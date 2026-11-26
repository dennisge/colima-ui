use bollard::models::{EventMessage, EventMessageTypeEnum};
use bollard::query_parameters::{EventsOptions, ListContainersOptions, ListImagesOptions};
use bollard::Docker;
use futures_util::stream::StreamExt;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::time::Instant;
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;

static GLOBAL_DOCKER_STATE: OnceLock<Arc<RwLock<DockerState>>> = OnceLock::new();
static GLOBAL_APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// Initialize global references to DockerState and AppHandle for lifecycle notifications.
pub fn init_global_docker_state(state: Arc<RwLock<DockerState>>, app: AppHandle) {
    let _ = GLOBAL_DOCKER_STATE.set(state);
    let _ = GLOBAL_APP_HANDLE.set(app);
}

/// Access the Desktop `AppHandle` when running inside the Tauri application.
pub fn global_app_handle() -> Option<&'static AppHandle> {
    GLOBAL_APP_HANDLE.get()
}

/// Centralized lifecycle helper called when an instance is stopping or being deleted.
/// Suppresses watcher reconnection, clears Docker caches, invalidates socket probe cache,
/// and broadcasts connection-lost and empty state events over both SSE and Tauri IPC.
pub fn notify_instance_stopping(profile: &str) {
    crate::path_util::invalidate_probe_cache();
    crate::commands::system_capabilities::invalidate();

    if let Some(state) = GLOBAL_DOCKER_STATE.get() {
        match state.try_write() {
            Ok(mut lock) => {
                lock.docker = None;
                lock.containers_cache = vec![];
                lock.images_cache = vec![];
                lock.suppressed = true;
            }
            Err(_) => {
                let state_clone = state.clone();
                tauri::async_runtime::spawn(async move {
                    let mut lock = state_clone.write().await;
                    lock.docker = None;
                    lock.containers_cache = vec![];
                    lock.images_cache = vec![];
                    lock.suppressed = true;
                });
            }
        }
    }

    let payload = serde_json::json!({ "profile": profile });
    let empty_state = serde_json::json!({ "containers": [], "images": [] });
    crate::sse::publish_sse_event("docker-connection-lost", &payload);
    crate::sse::publish_sse_event("docker-state-updated", &empty_state);

    if let Some(app) = GLOBAL_APP_HANDLE.get() {
        let _ = app.emit("docker-connection-lost", payload);
        let _ = app.emit("docker-state-updated", empty_state);
    }
}

/// Centralized lifecycle helper called when an instance has started or is starting.
/// Invalidates socket probe cache and unsets the suppressed flag so the watcher can reconnect.
pub fn notify_instance_started(_profile: &str) {
    crate::path_util::invalidate_probe_cache();
    crate::commands::system_capabilities::invalidate();

    if let Some(state) = GLOBAL_DOCKER_STATE.get() {
        match state.try_write() {
            Ok(mut lock) => {
                lock.suppressed = false;
            }
            Err(_) => {
                let state_clone = state.clone();
                tauri::async_runtime::spawn(async move {
                    let mut lock = state_clone.write().await;
                    lock.suppressed = false;
                });
            }
        }
    }
}

/// Returns true if an instance stop/delete operation is actively suppressing reconnection.
pub fn is_suppressed() -> bool {
    GLOBAL_DOCKER_STATE
        .get()
        .and_then(|s| s.try_read().ok().map(|g| g.suppressed))
        .unwrap_or(false)
}

/// Connect to Docker via the Colima socket.
/// This is essential because macOS .app bundles don't inherit DOCKER_HOST,
/// and Colima doesn't create /var/run/docker.sock (which Bollard defaults to).
/// Connect to whichever daemon this machine has.
///
/// `pub(crate)` because the SSE watcher needs the *same* answer: it once had its
/// own copy, and when that copy was removed in favour of calling this, the
/// difference between them turned out to be the `connect_with_defaults()`
/// fallback — i.e. every machine running Docker Desktop rather than colima.
pub(crate) fn connect_bollard() -> Option<Docker> {
    // Try Colima socket detection first
    if let Some((host, _)) = crate::path_util::detect_docker_host() {
        // host is like "unix:///Users/mike/.colima/default/docker.sock"
        let socket_path = host.trim_start_matches("unix://");
        if let Ok(d) = Docker::connect_with_unix(socket_path, 5, bollard::API_DEFAULT_VERSION) {
            return Some(d);
        }
    }
    // Fallback to defaults (works if /var/run/docker.sock exists or DOCKER_HOST is set)
    Docker::connect_with_defaults().ok()
}

pub struct DockerState {
    pub docker: Option<Docker>,
    pub containers_cache: Vec<serde_json::Value>,
    pub images_cache: Vec<serde_json::Value>,
    /// When true, the watcher must NOT reconnect or push data.
    /// Set by stop_instance/delete_instance before running the colima command.
    /// The watcher auto-clears this when the socket is truly gone (detect_docker_host() returns None).
    pub suppressed: bool,
    /// True once the watcher has emitted a containerd-unsupported warning.
    /// Reset when no containerd profile is running, so a later switch to
    /// containerd is still reported.
    pub containerd_warned: bool,
}

impl DockerState {
    /// Creates a new DockerState. Never panics — if Docker is unavailable,
    /// `docker` is `None` and caches start empty.
    pub fn new() -> Self {
        let docker = connect_bollard();
        if docker.is_none() {
            let containerd = crate::instance_reader::running_containerd_profiles();
            if containerd.is_empty() {
                eprintln!("[DockerState] Docker daemon not reachable — starting with empty state");
            } else {
                eprintln!(
                    "[DockerState] Docker daemon not reachable — running Colima profile(s) use the unsupported containerd runtime: {}. Use `colima start --runtime docker`.",
                    containerd.join(", ")
                );
            }
        }
        Self {
            docker,
            containers_cache: vec![],
            images_cache: vec![],
            suppressed: false,
            containerd_warned: false,
        }
    }

    /// Returns a reference to the Docker client, or an error if not connected.
    #[allow(dead_code)]
    pub fn docker(&self) -> Result<&Docker, String> {
        self.docker.as_ref().ok_or_else(|| "Docker daemon is not connected".to_string())
    }
}

impl Default for DockerState {
    fn default() -> Self {
        Self::new()
    }
}

/// Resilient Docker event watcher with auto-reconnect.
/// Runs forever: connects → streams events → on disconnect, clears state → retries.
/// Push-based (no polling) — same approach as OrbStack.
pub async fn start_docker_watcher(app: AppHandle, state: Arc<RwLock<DockerState>>) {
    init_global_docker_state(state.clone(), app.clone());
    loop {
        // Check suppression flag — stop/delete in progress, don't reconnect
        {
            let is_suppressed = state.read().await.suppressed;
            if is_suppressed {
                // Socket might still exist during shutdown — check if it's truly gone
                if crate::path_util::detect_docker_host().is_none() {
                    // Socket gone → clear suppression so watcher can reconnect when instance starts again
                    state.write().await.suppressed = false;
                }
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                continue;
            }
        }

        // Try to connect (or reconnect) to Docker daemon via Colima socket
        let docker = match connect_bollard() {
            Some(d) => {
                // Verify connection is actually alive with a ping (with timeout)
                match tokio::time::timeout(std::time::Duration::from_secs(5), d.ping()).await {
                    Ok(Ok(_)) => {
                        eprintln!("[DockerWatcher] Connected to Docker daemon");
                        d
                    }
                    _ => {
                        eprintln!("[DockerWatcher] Docker ping failed or timed out");
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                        continue;
                    }
                }
            }
            None => {
                let containerd = crate::instance_reader::running_containerd_profiles();
                if !containerd.is_empty() {
                    let mut lock = state.write().await;
                    if !lock.containerd_warned {
                        lock.containerd_warned = true;
                        let payload = serde_json::json!({
                            "runtime": "containerd",
                            "profiles": containerd,
                        });
                        crate::sse::publish_sse_event("docker-unsupported-runtime", &payload);
                        let _ = app.emit("docker-unsupported-runtime", payload.clone());
                        eprintln!(
                            "[DockerWatcher] containerd runtime is unsupported for profile(s): {}. Use `colima start --runtime docker`.",
                            containerd.join(", ")
                        );
                    }
                } else {
                    state.write().await.containerd_warned = false;
                }
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                continue;
            }
        };

        // Update DockerState with fresh connection (so list_containers/list_images use it)
        {
            let mut lock = state.write().await;
            // Double-check suppression in case stop was called between connect and here
            if lock.suppressed {
                continue;
            }
            lock.docker = Some(docker.clone());
        }

        // Initial fetch on (re)connect — push to frontend immediately.
        //
        // Both transports, not just Tauri. Browser-mode clients are driven by
        // container events, and a recovery produces none: after a VM restart
        // with nothing running there is simply nothing to report, so a client
        // that only reacts to events would sit on pre-outage data forever.
        let mut pending = ResourceChanges {
            containers: true,
            images: true,
            ..Default::default()
        };
        publish_changes(&docker, &state, &mut pending).await;
        // Notify frontend of reconnection so it can refetch volumes/networks/compose
        crate::sse::publish_sse_event("docker-reconnected", &serde_json::json!({}));
        let _ = app.emit("docker-reconnected", serde_json::json!({}));

        let (detected_host, detected_profile) = match crate::path_util::detect_docker_host() {
            Some((h, p)) => (h, p),
            None => (String::new(), "default".to_string()),
        };

        // Stream Docker events until connection drops
        // Trailing-edge debounce: when events arrive in rapid bursts (e.g., docker stop
        // fires kill→stop→die within ~200ms), wait for the burst to settle before
        // refreshing. This ensures we always capture the FINAL state, not an
        // intermediate transition state.
        let mut stream = docker.events(Some(EventsOptions::default()));
        let quiet_period = Duration::from_millis(500);
        let max_batch_delay = Duration::from_millis(1500);
        let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(5));
        heartbeat.tick().await; // Consume initial immediate tick

        let mut connection_lost_reason: Option<String> = None;

        loop {
            // Wait for the next event or periodic 5s ping heartbeat
            let event = tokio::select! {
                _ = heartbeat.tick() => {
                    let ping_res = tokio::time::timeout(std::time::Duration::from_secs(2), docker.ping()).await;
                    let is_ok = matches!(&ping_res, Ok(Ok(_)));
                    if !is_ok {
                        let reason = match ping_res {
                            Err(_) => "docker.ping() timed out after 2s".to_string(),
                            Ok(Err(e)) => format!("docker.ping() failed: {}", e),
                            _ => "docker ping failed".to_string(),
                        };
                        eprintln!("[DockerWatcher] Heartbeat ping failed ({}) — dropping connection", reason);
                        connection_lost_reason = Some(reason);
                        break;
                    }
                    // Retry a resource that failed independently of its peers.
                    if pending.has_changes() {
                        publish_changes(&docker, &state, &mut pending).await;
                    }
                    continue;
                }
                ev = stream.next() => ev,
            };

            match event {
                Some(Ok(ev)) => {
                    if !pending.record(&ev) {
                        continue;
                    }

                    let batch_deadline = Instant::now() + max_batch_delay;
                    let mut deadline = Instant::now() + quiet_period;
                    loop {
                        match tokio::time::timeout_at(deadline.min(batch_deadline), stream.next()).await {
                            Ok(Some(Ok(ev))) => {
                                if pending.record(&ev) {
                                    deadline = Instant::now() + quiet_period;
                                }
                                if Instant::now() >= batch_deadline {
                                    break;
                                }
                            }
                            Ok(Some(Err(e))) => {
                                connection_lost_reason = Some(format!("event stream error during drain: {}", e));
                                break;
                            }
                            Ok(None) => {
                                connection_lost_reason = Some("event stream ended during drain".to_string());
                                break;
                            }
                            Err(_) => break,
                        }
                    }
                    if connection_lost_reason.is_some() {
                        break;
                    }
                    publish_changes(&docker, &state, &mut pending).await;
                }
                Some(Err(e)) => {
                    // Event stream error — break to reconnect logic
                    connection_lost_reason = Some(format!("event stream error: {}", e));
                    break;
                }
                None => {
                    // Stream ended
                    connection_lost_reason = Some("event stream ended".to_string());
                    break;
                }
            }
        }

        // Stream ended or ping failed — check if Docker is actually gone or just a transient stream error
        let is_transient = if connection_lost_reason.as_deref().is_some_and(|r| r.starts_with("docker.ping()")) {
            false
        } else {
            matches!(
                tokio::time::timeout(std::time::Duration::from_secs(2), docker.ping()).await,
                Ok(Ok(_))
            )
        };

        if is_transient {
            // Docker is still alive — transient stream error.
            // Don't clear state, just reconnect the event stream.
            eprintln!("[DockerWatcher] Event stream interrupted but Docker is alive — reconnecting stream");
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            continue;
        }

        // Docker is truly unreachable — clear stale data and notify frontend
        {
            let mut lock = state.write().await;
            lock.docker = None;
            lock.containers_cache = vec![];
            lock.images_cache = vec![];
        }
        crate::path_util::invalidate_probe_cache();

        let (host, profile) = match crate::path_util::detect_docker_host() {
            Some((h, p)) => (h, p),
            None => (detected_host.clone(), detected_profile.clone()),
        };
        let reason = connection_lost_reason.unwrap_or_else(|| "Docker daemon connection lost".to_string());
        let lost_payload = serde_json::json!({
            "host": host,
            "profile": profile,
            "reason": reason,
        });
        let empty = serde_json::json!({ "containers": [], "images": [] });

        crate::sse::publish_sse_event("docker-connection-lost", &lost_payload);
        crate::sse::publish_sse_event("docker-state-updated", &empty);
        let _ = app.emit("docker-connection-lost", lost_payload);
        let _ = app.emit("docker-state-updated", empty);

        eprintln!("[DockerWatcher] Connection lost — will retry in 2s");
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}

/// Map bollard ContainerSummary to our JSON format (public for reuse by command handlers)
pub fn map_containers(containers: &[bollard::models::ContainerSummary]) -> Vec<serde_json::Value> {
    let mut mapped = Vec::new();
    for c in containers {
        let names = c.names.clone().unwrap_or_default().join(", ").replace("/", "");
        let ports = match &c.ports {
            Some(ports) => ports
                .iter()
                .map(|p| {
                    let typ_str = p
                        .typ
                        .as_ref()
                        .map_or_else(
                            || "tcp".to_string(),
                            |t| format!("{:?}", t).to_lowercase().replace("\"", ""),
                        );
                    if let Some(ip) = &p.ip {
                        format!(
                            "{}:{}->{}/{}",
                            ip,
                            p.public_port.unwrap_or(0),
                            p.private_port,
                            typ_str
                        )
                    } else {
                        format!("{}/{}", p.private_port, typ_str)
                    }
                })
                .collect::<Vec<String>>()
                .join(", "),
            None => "".to_string(),
        };

        mapped.push(serde_json::json!({
            "Id": c.id.clone().unwrap_or_default(),
            "Names": names,
            "Image": c.image.clone().unwrap_or_default(),
            "Status": c.status.clone().unwrap_or_default(),
            "State": c.state.unwrap_or(bollard::models::ContainerSummaryStateEnum::EMPTY),
            "Ports": ports,
            "CreatedAt": c.created.unwrap_or(0).to_string(),
            "Size": c.size_rw.unwrap_or(0).to_string(),
            "Command": c.command.clone().unwrap_or_default(),
            // Compose grouping reads com.docker.compose.project from here.
            // Always an object, never null, so the frontend does not have to
            // special-case a container with no labels.
            "Labels": c.labels.clone().unwrap_or_default(),
        }));
    }
    mapped
}

/// Map bollard ImageSummary to our JSON format (public for reuse by command handlers)
pub fn map_images(images: &[bollard::models::ImageSummary]) -> Vec<serde_json::Value> {
    let mut mapped = Vec::new();
    for i in images {
        let tags = &i.repo_tags;
        let (repo, tag) = if !tags.is_empty() && tags[0] != "<none>:<none>" {
            let repo_tag = &tags[0];
            match repo_tag.rfind(':') {
                Some(colon_idx) if colon_idx > repo_tag.rfind('/').unwrap_or(0) => (
                    repo_tag[..colon_idx].to_string(),
                    repo_tag[colon_idx + 1..].to_string(),
                ),
                _ => (repo_tag.clone(), "latest".to_string()),
            }
        } else {
            ("<none>".to_string(), "<none>".to_string())
        };

        mapped.push(serde_json::json!({
            "Id": i.id.replace("sha256:", ""),
            "Repository": repo,
            "Tag": tag,
            "Size": i.size.to_string(),
            "CreatedAt": i.created.to_string(),
        }));
    }
    mapped
}

#[derive(Default)]
struct ResourceChanges {
    containers: bool,
    images: bool,
    volumes: bool,
    networks: bool,
}

impl ResourceChanges {
    fn record(&mut self, event: &EventMessage) -> bool {
        // Preserve the raw lifecycle stream independently of UI batching.
        if let Some(event) = crate::docker_events::from_bollard(event) {
            crate::docker_events::publish(event);
        }
        let action = event.action.as_deref().unwrap_or_default();
        let changed = match event.typ {
            Some(EventMessageTypeEnum::CONTAINER)
                if !action.starts_with("exec_")
                    && !matches!(action, "attach" | "detach" | "resize" | "top") =>
            {
                &mut self.containers
            }
            Some(EventMessageTypeEnum::IMAGE) => &mut self.images,
            Some(EventMessageTypeEnum::VOLUME) if !matches!(action, "mount" | "unmount") => {
                &mut self.volumes
            }
            Some(EventMessageTypeEnum::NETWORK) if !matches!(action, "connect" | "disconnect") => {
                &mut self.networks
            }
            _ => return false,
        };
        *changed = true;
        true
    }

    fn has_changes(&self) -> bool {
        self.containers || self.images || self.volumes || self.networks
    }
}

async fn publish_changes(
    docker: &Docker,
    state: &Arc<RwLock<DockerState>>,
    changes: &mut ResourceChanges,
) {
    if let Some(data) = update_cache(docker, state, changes).await {
        crate::sse::emit_all("docker-state-updated", &data);
    }
}

async fn update_cache(
    docker: &Docker,
    state: &Arc<RwLock<DockerState>>,
    changes: &mut ResourceChanges,
) -> Option<serde_json::Value> {
    let containers = async {
        if !changes.containers {
            return None;
        }
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            docker.list_containers(Some(ListContainersOptions { all: true, ..Default::default() })),
        ).await;
        match result {
            Ok(Ok(items)) => Some(map_containers(&items)),
            failure => {
                eprintln!("[DockerWatcher] list_containers failed: {failure:?}");
                None
            }
        }
    };
    let images = async {
        if !changes.images {
            return None;
        }
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            docker.list_images(Some(ListImagesOptions { all: false, ..Default::default() })),
        ).await;
        match result {
            Ok(Ok(items)) => Some(map_images(&items)),
            failure => {
                eprintln!("[DockerWatcher] list_images failed: {failure:?}");
                None
            }
        }
    };
    let (containers, images) = tokio::join!(containers, images);

    let mut lock = state.write().await;
    if lock.suppressed || lock.docker.is_none() {
        return None;
    }
    let mut refreshed = Vec::new();
    if let Some(containers) = containers {
        lock.containers_cache = containers;
        changes.containers = false;
        refreshed.push("containers");
    }
    if let Some(images) = images {
        lock.images_cache = images;
        changes.images = false;
        refreshed.push("images");
    }
    if std::mem::take(&mut changes.volumes) {
        refreshed.push("volumes");
    }
    if std::mem::take(&mut changes.networks) {
        refreshed.push("networks");
    }

    // Preserve the full snapshot fields for existing SSE clients. A frontend
    // that understands changed resources can skip normalizing the other lists.
    (!refreshed.is_empty()).then(|| serde_json::json!({
        "containers": lock.containers_cache,
        "images": lock.images_cache,
        "changed": refreshed,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inventory_events_only_mark_the_affected_resource() {
        let event = |typ, action: &str| EventMessage {
            typ: Some(typ),
            action: Some(action.to_string()),
            ..Default::default()
        };
        let mut changes = ResourceChanges::default();

        assert!(!changes.record(&event(EventMessageTypeEnum::CONTAINER, "exec_start")));
        assert!(!changes.record(&event(EventMessageTypeEnum::NETWORK, "connect")));
        assert!(!changes.record(&event(EventMessageTypeEnum::VOLUME, "mount")));
        assert!(!changes.has_changes());

        assert!(changes.record(&event(EventMessageTypeEnum::IMAGE, "tag")));
        assert!(changes.images);
        assert!(!changes.containers && !changes.volumes && !changes.networks);
    }

    #[test]
    fn docker_state_initializes_empty_when_no_daemon() {
        let state = DockerState {
            docker: None,
            containers_cache: vec![],
            images_cache: vec![],
            suppressed: false,
            containerd_warned: false,
        };
        assert!(state.docker().is_err());
        assert!(state.containers_cache.is_empty());
        assert!(state.images_cache.is_empty());
    }

    #[test]
    fn map_containers_formats_ports_and_labels_consistently() {
        let summary: bollard::models::ContainerSummary = serde_json::from_value(serde_json::json!({
            "Id": "1234567890abcdef",
            "Names": ["/my-app"],
            "Image": "nginx:latest",
            "Status": "Up 2 hours",
            "State": "running",
            "Ports": [{
                "IP": "0.0.0.0",
                "PrivatePort": 80,
                "PublicPort": 8080,
                "Type": "tcp"
            }],
            "Created": 1700000000,
            "SizeRw": 1024,
            "Command": "nginx -g 'daemon off;'",
            "Labels": {
                "com.docker.compose.project": "demo"
            }
        })).expect("deserialize ContainerSummary");

        let mapped = map_containers(&[summary]);
        assert_eq!(mapped.len(), 1);
        assert_eq!(mapped[0]["Id"], "1234567890abcdef");
        assert_eq!(mapped[0]["Names"], "my-app");
        assert_eq!(mapped[0]["Ports"], "0.0.0.0:8080->80/tcp");
        assert_eq!(mapped[0]["Labels"]["com.docker.compose.project"], "demo");
    }

    #[test]
    fn map_images_strips_sha_prefix_and_handles_tags() {
        let img = bollard::models::ImageSummary {
            id: "sha256:abcdef1234567890".to_string(),
            repo_tags: vec!["alpine:3.18".to_string()],
            size: 5000000,
            created: 1700000000,
            ..Default::default()
        };

        let mapped = map_images(&[img]);
        assert_eq!(mapped.len(), 1);
        assert_eq!(mapped[0]["Id"], "abcdef1234567890");
        assert_eq!(mapped[0]["Repository"], "alpine");
        assert_eq!(mapped[0]["Tag"], "3.18");
    }

    #[test]
    fn map_images_preserves_registry_port_with_and_without_tag() {
        let tagged = bollard::models::ImageSummary {
            id: "sha256:111".to_string(),
            repo_tags: vec!["localhost:5000/org/app:v1.2".to_string()],
            size: 100,
            created: 1700000000,
            ..Default::default()
        };
        let untagged_registry = bollard::models::ImageSummary {
            id: "sha256:222".to_string(),
            repo_tags: vec!["localhost:5000/org/app".to_string()],
            size: 200,
            created: 1700000000,
            ..Default::default()
        };
        let untagged_plain = bollard::models::ImageSummary {
            id: "sha256:333".to_string(),
            repo_tags: vec!["org/app".to_string()],
            size: 300,
            created: 1700000000,
            ..Default::default()
        };
        let dangling = bollard::models::ImageSummary {
            id: "sha256:444".to_string(),
            repo_tags: vec!["<none>:<none>".to_string()],
            size: 400,
            created: 1700000000,
            ..Default::default()
        };

        let mapped = map_images(&[tagged, untagged_registry, untagged_plain, dangling]);
        assert_eq!(mapped[0]["Repository"], "localhost:5000/org/app");
        assert_eq!(mapped[0]["Tag"], "v1.2");

        assert_eq!(mapped[1]["Repository"], "localhost:5000/org/app");
        assert_eq!(mapped[1]["Tag"], "latest");

        assert_eq!(mapped[2]["Repository"], "org/app");
        assert_eq!(mapped[2]["Tag"], "latest");

        assert_eq!(mapped[3]["Repository"], "<none>");
        assert_eq!(mapped[3]["Tag"], "<none>");
    }

    #[tokio::test]
    async fn update_cache_keeps_last_good_data_when_disconnected() {
        if let Ok(docker) = Docker::connect_with_unix("/tmp/nonexistent_mock_socket.sock", 1, bollard::API_DEFAULT_VERSION) {
            let state = Arc::new(RwLock::new(DockerState {
                docker: Some(docker.clone()),
                containers_cache: vec![serde_json::json!({"Id": "prev"})],
                images_cache: vec![],
                suppressed: false,
                containerd_warned: false,
            }));
            let mut changes = ResourceChanges { containers: true, ..Default::default() };
            let res = update_cache(&docker, &state, &mut changes).await;
            assert!(res.is_none(), "failed reads must not publish an empty snapshot");
            assert!(changes.containers, "failed resource remains pending for retry");
            let lock = state.read().await;
            assert_eq!(lock.containers_cache.len(), 1, "Cache must not be clobbered on failure");
        }
    }
}
