import { dockerApi, networksApi, sysMethods, volumesApi } from "./api";
import { dockerState, resourceState } from "../store.svelte";

let suspended = false;
let runtimeRequest: Promise<void> | undefined;

export function ensureDockerRuntime() {
  if (suspended || runtimeRequest) return;
  const request = sysMethods.getRuntimeInfo().then((name) => {
    if (runtimeRequest === request) dockerState.runtimeName = name;
  }, () => {
    if (runtimeRequest === request) runtimeRequest = undefined;
  });
  runtimeRequest = request;
}

function dockerResource<T>(load: () => Promise<T[]>, apply: (items: T[]) => void) {
  let ready = false;
  let revision = 0;
  let pending: { revision: number; result: Promise<boolean> } | undefined;

  function refresh(): Promise<boolean> {
    if (suspended) return Promise.resolve(false);
    if (pending?.revision === revision) return pending.result;

    const startedAt = revision;
    const result = load().then((items) => {
      // Events and connection changes can supersede a read already on the wire.
      if (revision === startedAt) {
        apply(items);
        ready = true;
      }
      return ready;
    }, () => ready && revision !== startedAt).finally(() => {
      if (pending?.result === result) pending = undefined;
    });
    pending = { revision: startedAt, result };
    return result;
  }

  return {
    ensure: () => ready ? Promise.resolve(true) : refresh(),
    refresh,
    afterChange: () => {
      // A read started before a confirmed change cannot cover that change.
      revision++;
      return refresh();
    },
    accept(items: T[]) {
      revision++;
      apply(items);
      ready = true;
    },
    reset() {
      revision++;
      ready = false;
      pending = undefined;
    },
  };
}

export const containerResources = dockerResource(
  () => dockerApi.listContainers(true),
  (items) => { dockerState.containers = items; dockerState.loading = false; },
);

export const imageResources = dockerResource(
  () => dockerApi.listImages(),
  (items) => { dockerState.images = items; },
);

export const volumeResources = dockerResource(
  () => volumesApi.listVolumes(),
  (items) => { resourceState.volumes = items; resourceState.volumesLoading = false; },
);

export const networkResources = dockerResource(
  () => networksApi.listNetworks(),
  (items) => { resourceState.networks = items; resourceState.networksLoading = false; },
);

export function suspendDockerResources() {
  suspended = true;
  runtimeRequest = undefined;
  containerResources.reset();
  imageResources.reset();
  volumeResources.reset();
  networkResources.reset();
}

export function resumeDockerResources() {
  suspended = false;
}
