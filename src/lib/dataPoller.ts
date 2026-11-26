import { colimaApi, sysMethods, getApiToken, type ColimaInstance } from "./api";
import { resolveApiBase } from "./api/client";
import { loadCapabilities } from "../store/capabilities.svelte";
import { normalizeContainer, normalizeImage } from "./normalizers";
import {
  containerResources, imageResources, volumeResources, networkResources,
  ensureDockerRuntime, resumeDockerResources, suspendDockerResources,
} from "./dockerResources";
import { dockerState, resourceState, dashboardState, isEventCooldownActive, uiState, isValidPage } from "../store.svelte";
import { getAppSetting } from "./settingsStore.svelte";
import { setVisibleInterval } from "./visibleInterval";
import { globalToast } from "./globalToast";
import { t } from "./i18n.svelte";

import { isRunningInTauri } from "./env";
let _refetchRetryCount = 0;
const MAX_REFETCH_RETRIES = 10;
let stopPolling: (() => void) | null = null;
let refetchRetryTimeout: ReturnType<typeof setTimeout> | null = null;
// Module-level, not inside the browser-mode branch: the teardown returned by
// startDataPoller() lives outside that branch and has to be able to close it.
let currentEventSource: EventSource | null = null;
// A refetch already in flight when teardown runs would otherwise schedule its
// retry after the timeout was cleared, and keep polling a dead context.
let disposed = false;
let awaitingReconnect = false;
let dockerRefetch: Promise<void> | null = null;
let retryOnVisible: (() => void) | null = null;
let stopSysPoll: (() => void) | null = null;
let sseRetryTimeout: ReturnType<typeof setTimeout> | null = null;
let activeUnlisteners: (() => void)[] = [];

function trackUnlisten(promise: Promise<() => void>) {
  promise
    .then((unlisten) => {
      if (disposed) {
        unlisten();
        return;
      }
      activeUnlisteners.push(unlisten);
    })
    .catch(() => {});
}

export async function refreshManual() {
  try {
    const [instanceList, sysInfo] = await Promise.all([
      colimaApi.listInstances().catch(() => [] as ColimaInstance[]),
      sysMethods.checkSystem().catch(() => null),
    ]);
    dashboardState.colimaInstances = instanceList;
    dashboardState.instancesLoaded = true;
    if (sysInfo) dashboardState.systemInfo = sysInfo;
  } catch (e) {
    uiState.globalError = String(e);
  } finally {
    // loading handled by consumer or not needed globally anymore
  }
}

function clearRefetchRetry() {
  if (refetchRetryTimeout) clearTimeout(refetchRetryTimeout);
  refetchRetryTimeout = null;
  if (retryOnVisible) document.removeEventListener("visibilitychange", retryOnVisible);
  retryOnVisible = null;
}

function scheduleRefetchRetry() {
  const delay = ++_refetchRetryCount < MAX_REFETCH_RETRIES ? 5000 : 15000;
  refetchRetryTimeout = setTimeout(() => {
    refetchRetryTimeout = null;
    if (typeof document === "undefined" || document.visibilityState === "visible") {
      void refetchAllResources();
      return;
    }
    retryOnVisible = () => {
      if (document.visibilityState !== "visible") return;
      clearRefetchRetry();
      void refetchAllResources();
    };
    document.addEventListener("visibilitychange", retryOnVisible);
  }, delay);
}

function refetchResources(ensureSnapshots = false): Promise<void> {
  if (disposed) return Promise.resolve();
  if (dockerRefetch) return dockerRefetch;
  clearRefetchRetry();

  const result = Promise.all([
    ensureSnapshots ? containerResources.ensure() : containerResources.refresh(),
    ensureSnapshots ? imageResources.ensure() : imageResources.refresh(),
    volumeResources.refresh(),
    networkResources.refresh(),
  ]).then((results) => {
    if (dockerRefetch !== result) return;
    dockerRefetch = null;
    if (results.every(Boolean)) {
      _refetchRetryCount = 0;
    } else {
      if (!results[0]) void refreshManual();
      scheduleRefetchRetry();
    }
  });
  dockerRefetch = result;
  return result;
}

export function refetchAllResources() {
  return refetchResources();
}

interface DockerStateUpdate {
  containers?: Record<string, unknown>[];
  images?: Record<string, unknown>[];
  changed?: ("containers" | "images" | "volumes" | "networks")[];
}

function handleDockerStateUpdated(data: DockerStateUpdate) {
  if (disposed || awaitingReconnect) return;

  if (!isEventCooldownActive() && Array.isArray(data.containers)
      && (!data.changed || data.changed.includes("containers"))) {
    containerResources.accept(data.containers.map(normalizeContainer));
  }
  if (Array.isArray(data.images) && (!data.changed || data.changed.includes("images"))) {
    imageResources.accept(data.images.map(normalizeImage));
  }
  if (data.changed?.includes("volumes")) void volumeResources.afterChange();
  if (data.changed?.includes("networks")) void networkResources.afterChange();
}

function handleConnectionLost() {
  awaitingReconnect = true;
  dockerRefetch = null;
  clearRefetchRetry();
  suspendDockerResources();
  resumeDockerResources();
  dockerState.containers = [];
  dockerState.images = [];
  resourceState.volumes = [];
  resourceState.networks = [];
  dockerState.loading = true;
  resourceState.volumesLoading = true;
  resourceState.networksLoading = true;
}

function handleDockerReconnected() {
  awaitingReconnect = false;
  ensureDockerRuntime();
  return refetchResources(true);
}

function showUnsupportedRuntimeToast(payload: { runtime?: string; profiles?: string[] }) {
  const runtime = payload.runtime || "containerd";
  const profiles = payload.profiles?.join(", ") || "unknown";
  globalToast(
    "error",
    t("docker.unsupported_runtime", {
      default: "{runtime} runtime is not supported",
      runtime,
      profiles,
    }),
    {
      hint: t("docker.unsupported_runtime_hint", {
        default: "ColimaUI requires the Docker runtime. Stop the profile and run: colima start --runtime docker",
      }),
    }
  );
}

export function startDataPoller() {
  // A second start after a teardown (HMR, or a re-mounted root) must not
  // inherit the previous run's disposed flag or its retry count.
  disposed = false;
  awaitingReconnect = false;
  resumeDockerResources();
  _refetchRetryCount = 0;
  refreshManual();
  refetchAllResources();
  // Load once at startup so pages can explain an empty list ("Colima isn't
  // installed") instead of just showing nothing. The backend caches this and
  // drops the cache when an instance changes state, so refreshing is cheap.
  loadCapabilities();

  const rsEnabled = getAppSetting("colimaui_auto_pause") === "true";
  const rsMins = parseInt(getAppSetting("colimaui_auto_pause_mins") || "15", 10);
  sysMethods.setResourceSaver(rsEnabled, rsMins).catch(() => {});

  stopSysPoll = setVisibleInterval(() => { sysMethods.checkSystem().then(s => dashboardState.systemInfo = s).catch(()=>{}); }, 30000);

  const staleUnlisteners = activeUnlisteners;
  activeUnlisteners = [];
  for (const fn of staleUnlisteners) {
    fn();
  }

  if (isRunningInTauri()) {
    import("@tauri-apps/api/event").then((mod) => {
      if (disposed) return;
      trackUnlisten(
        mod.listen("instances-update", (event: { payload: { instances?: ColimaInstance[] } }) => {
          if (event.payload.instances) dashboardState.colimaInstances = event.payload.instances;
          dashboardState.instancesLoaded = true;
          // Starting or stopping an instance flips Colima and Docker between
          // "installed but not running" and "usable".
          loadCapabilities();
        })
      );
      trackUnlisten(
        mod.listen("docker-state-updated", (event: { payload: DockerStateUpdate }) =>
          handleDockerStateUpdated(event.payload)
        )
      );
      trackUnlisten(mod.listen("docker-connection-lost", handleConnectionLost));
      trackUnlisten(mod.listen("docker-reconnected", handleDockerReconnected));
      trackUnlisten(
        mod.listen("docker-unsupported-runtime", (event: { payload: { runtime?: string; profiles?: string[] } }) =>
          showUnsupportedRuntimeToast(event.payload)
        )
      );
      // Tray menu navigation (container click / Help) drives the active page.
      trackUnlisten(
        mod.listen("navigate", (event: { payload?: { page?: unknown } }) => {
          const page = event.payload?.page;
          if (typeof page === "string" && isValidPage(page)) {
            uiState.currentPage = page;
          }
        })
      );
    }).catch(() => {});
  } else {
    let sseRetryDelay = 2000;

    async function connectSSE() {
      // A reconnect must not leave the previous socket open: Chrome caps a
      // single origin at 6 concurrent connections, after which every request
      // to 127.0.0.1:11420 blocks — including the plain HTTP polling fallback.
      if (currentEventSource) {
        currentEventSource.close();
        currentEventSource = null;
      }
      if (disposed) return;

      // Re-read the token on every attempt rather than capturing it once.
      // Browser mode receives it from a URL fragment, so the very first attempt
      // can legitimately run before one is available; a captured empty string
      // would then be retried forever against an endpoint that always 401s.
      const token = await getApiToken();

      // Must use the resolved base: the server falls back to 11421-11429 when
      // the default port is taken, and an EventSource pointed at the wrong port
      // fails silently — the UI would just stop updating.
      const base = await resolveApiBase();
      const sseUrl = token ? `${base}/api/events?token=${token}` : `${base}/api/events`;
      // Re-checked after the awaits above: a teardown during token/base
      // resolution would otherwise open a socket nobody is left to close.
      if (disposed) return;
      const es = new EventSource(sseUrl);
      currentEventSource = es;
      es.addEventListener("instances-update", (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data) as { instances?: ColimaInstance[] };
          if (data.instances) dashboardState.colimaInstances = data.instances;
          dashboardState.instancesLoaded = true;
          loadCapabilities();
        } catch {
          // A malformed SSE frame is ignored; the next update will retry.
        }
      });
      es.addEventListener("docker-state-updated", (e: MessageEvent) => {
        try {
          handleDockerStateUpdated(JSON.parse(e.data) as DockerStateUpdate);
        } catch {
          // A malformed SSE frame is ignored; the next update will retry.
        }
      });
      es.addEventListener("docker-connection-lost", handleConnectionLost);
      es.addEventListener("docker-reconnected", handleDockerReconnected);
      es.addEventListener("docker-unsupported-runtime", (e: MessageEvent) => {
        try {
          showUnsupportedRuntimeToast(JSON.parse(e.data) as { runtime?: string; profiles?: string[] });
        } catch {
          // A malformed SSE frame is ignored; the next update will retry.
        }
      });
      es.onopen = () => {
        sseRetryDelay = 2000;
        if (stopPolling) {
          stopPolling();
          stopPolling = null;
          // The transport might have missed changes while disconnected.
          awaitingReconnect = false;
          void refetchAllResources();
        }
      };
      es.onerror = () => {
        es.close();
        if (!stopPolling) {
          stopPolling = setVisibleInterval(() => {
            refreshManual();
            refetchAllResources();
          }, 5000);
        }
        sseRetryTimeout = setTimeout(() => {
          connectSSE();
        }, sseRetryDelay);
        sseRetryDelay = Math.min(sseRetryDelay * 2, 30000);
      };
    }

    connectSSE();
  }

  return stopDataPoller;
}

export function stopDataPoller() {
  disposed = true;
  if (stopSysPoll) { stopSysPoll(); stopSysPoll = null; }
  if (stopPolling) { stopPolling(); stopPolling = null; }
  dockerRefetch = null;
  suspendDockerResources();
  clearRefetchRetry();
  if (sseRetryTimeout) { clearTimeout(sseRetryTimeout); sseRetryTimeout = null; }
  const registered = activeUnlisteners;
  activeUnlisteners = [];
  for (const fn of registered) {
    fn();
  }
  // close() does not fire onerror, so no reconnect is woken by the teardown.
  if (currentEventSource) {
    currentEventSource.close();
    currentEventSource = null;
  }
}
