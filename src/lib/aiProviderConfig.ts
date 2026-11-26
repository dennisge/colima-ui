import { getAppSetting, setAppSetting } from "./settingsStore.svelte";

/**
 * A model endpoint the app can talk to.
 *
 * `needsKey` / `needsEndpoint` drive which fields the settings form renders —
 * a local Ollama daemon has no credential to ask for, and an OpenAI-compatible
 * gateway is nothing without its base URL.
 */
export interface AiProvider {
  id: string;
  label: string;
  needsKey: boolean;
  needsEndpoint: boolean;
  endpointPlaceholder?: string;
  /** How this provider names its models, shown under the model field. */
  modelHint?: string;
}

/**
 * Reduce anything the user might paste to the base a `/chat/completions` or
 * `/models` path can be appended to.
 *
 * Proxies are documented inconsistently — LiteLLM prints `http://0.0.0.0:4000`,
 * some UIs show the full completions URL — and the caller appends its own
 * suffix, so without this the same server works or 404s depending on which of
 * the three forms was pasted.
 */
export function normalizeOpenAiBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "";

  const withoutCompletions = trimmed.replace(/\/chat\/completions$/i, "").replace(/\/+$/, "");

  try {
    const parsed = new URL(withoutCompletions);
    // A bare host means the version segment was left off; every
    // OpenAI-compatible server mounts its API under one.
    if (parsed.pathname === "" || parsed.pathname === "/") {
      return `${parsed.origin}/v1`;
    }
  } catch {
    // Not an absolute URL — the request will fail on its own terms, with the
    // user's own text in the error rather than something rewritten here.
  }

  return withoutCompletions;
}

/**
 * Reduce an Ollama host to the base its `/api/...` paths hang off.
 *
 * Ollama's docs quote full endpoints (`https://ollama.com/api/chat`), so that is
 * what users paste; every caller then appends `/api/chat` or `/api/tags` of its
 * own and the request 404s on a doubled path.
 */
export function normalizeOllamaBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.replace(/\/api(\/(chat|tags|generate|show))?$/i, "").replace(/\/+$/, "");
}

export const AI_PROVIDERS: AiProvider[] = [
  { id: "anthropic", label: "Anthropic", needsKey: true, needsEndpoint: false },
  { id: "openai", label: "OpenAI", needsKey: true, needsEndpoint: false },
  { id: "gemini", label: "Google Gemini", needsKey: true, needsEndpoint: false },
  {
    id: "openai-compatible",
    label: "OpenAI-compatible proxy",
    needsKey: true,
    needsEndpoint: true,
    endpointPlaceholder: "http://localhost:4000/v1",
    modelHint: "Use the full model identifier reported by your proxy. Refresh to list available models.",
  },
  { id: "ollama-local", label: "Ollama Local", needsKey: false, needsEndpoint: false },
  {
    id: "ollama-cloud",
    label: "Ollama Cloud / remote host",
    needsKey: true,
    needsEndpoint: true,
    endpointPlaceholder: "https://your-host.example",
    // Ollama's docs name the same model differently by route: pulled through a
    // local host it carries a -cloud suffix, called directly on ollama.com it
    // does not (`gpt-oss:120b-cloud` vs `gpt-oss:120b`).
    modelHint: "Enter the host URL. The client adds the API path automatically.",
  },
];

export const DEFAULT_PROVIDER = "anthropic";

export function findProvider(id: string): AiProvider | undefined {
  return AI_PROVIDERS.find((p) => p.id === id);
}

export type AiField = "model" | "api_key" | "endpoint";

/**
 * The settings key each field is read from at call time. Every AI feature
 * (chat panel, compose diagnosis, security triage, instance help) reads these,
 * so they always mirror the provider currently selected.
 */
const ACTIVE_KEY: Record<AiField, string> = {
  model: "ai_model",
  api_key: "ai_api_key",
  endpoint: "ai_endpoint",
};

function scopedKey(provider: string, field: AiField): string {
  return `${ACTIVE_KEY[field]}.${provider}`;
}

export function getActiveProvider(): string {
  return getAppSetting("ai_provider", DEFAULT_PROVIDER);
}

/**
 * Read one field for a provider, whether or not it is the active one.
 *
 * Falls back to the unscoped key so configuration written before per-provider
 * storage existed is not lost — but only for the provider that was active when
 * it was written, otherwise one provider's key would leak into every other.
 */
export function getProviderField(provider: string, field: AiField): string {
  const scoped = getAppSetting(scopedKey(provider, field), "");
  if (scoped) return scoped;
  if (getActiveProvider() === provider) return getAppSetting(ACTIVE_KEY[field], "");
  return "";
}

/** Write one field, keeping the active mirror in step when it applies. */
export function setProviderField(provider: string, field: AiField, value: string): void {
  setAppSetting(scopedKey(provider, field), value);
  if (getActiveProvider() === provider) setAppSetting(ACTIVE_KEY[field], value);
}

/**
 * Switch providers, restoring that provider's own model, key and endpoint.
 *
 * The values are resolved before `ai_provider` moves: `getProviderField`
 * consults the active provider for its legacy fallback, so reading afterwards
 * would hand the incoming provider the outgoing one's credential.
 */
export function activateProvider(provider: string): void {
  const restored: Record<AiField, string> = {
    model: getProviderField(provider, "model"),
    api_key: getProviderField(provider, "api_key"),
    endpoint: getProviderField(provider, "endpoint"),
  };
  setAppSetting("ai_provider", provider);
  for (const field of Object.keys(restored) as AiField[]) {
    setAppSetting(ACTIVE_KEY[field], restored[field]);
    setAppSetting(scopedKey(provider, field), restored[field]);
  }
}
