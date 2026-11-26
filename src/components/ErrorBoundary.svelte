<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import type { Snippet } from "svelte";
  import { t } from "../lib/i18n.svelte";

  let { children }: { children: Snippet } = $props();

  let hasError = $state(false);
  let errorMsg = $state("");
  let errorStack = $state("");

  function handleError(event: ErrorEvent) {
    hasError = true;
    errorMsg = event.message || "Unknown error";
    errorStack = event.error?.stack || "";
    event.preventDefault(); // Stop propagation
  }

  function handleUnhandledRejection(event: PromiseRejectionEvent) {
    hasError = true;
    errorMsg = event.reason?.message || String(event.reason) || "Unhandled Promise Rejection";
    errorStack = event.reason?.stack || "";
    event.preventDefault(); // Stop propagation
  }

  onMount(() => {
    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);
  });

  onDestroy(() => {
    window.removeEventListener("error", handleError);
    window.removeEventListener("unhandledrejection", handleUnhandledRejection);
  });

  function resetError() {
    hasError = false;
    errorMsg = "";
    errorStack = "";
    window.location.reload();
  }
</script>

{#if hasError}
  <div style="padding: 40px; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; background: var(--bg-primary); color: var(--text-primary); gap: 20px;">
    <div style="font-size: 48px; color: var(--accent-red);">⚠️</div>
    <h1 style="margin: 0; font-size: var(--text-2xl);">{t("app_error.title")}</h1>
    <details style="max-width: 800px; width: 100%; overflow: auto;">
      <summary>{t("app_error.details")}</summary>
      <pre style="font-family: monospace; font-size: var(--text-xs); color: var(--text-secondary); white-space: pre-wrap;">{errorMsg}{errorStack ? "\n\n" + errorStack : ""}</pre>
    </details>
    <button class="btn btn-primary" onclick={resetError} style="padding: 12px 24px;">{t("app_error.reload")}</button>
  </div>
{:else}
  {@render children()}
{/if}
