// Picks the AI provider Wander talks to. Settings saved from the web app (AI settings) win over the
// GEMINI_* environment variables, so anyone running their own copy can bring their own key and model.
import { createGemini } from "./gemini.js";
import { createOpenAI, createAnthropic } from "./providers.js";

export const PROVIDERS = {
  gemini: { label: "Google Gemini", defaultModel: "gemini-flash-latest", keyUrl: "https://aistudio.google.com/apikey", keyHint: "AIza…" },
  openai: { label: "OpenAI or compatible", defaultModel: "", keyUrl: "https://platform.openai.com/api-keys", keyHint: "sk-…", baseUrl: true },
  anthropic: { label: "Anthropic Claude", defaultModel: "claude-opus-5", keyUrl: "https://console.anthropic.com/settings/keys", keyHint: "sk-ant-…" },
};

/** Returns a client with Wander's AI features, or null when there's no usable key. */
export function createAI({ provider = "gemini", apiKey, model, smartModel, baseUrl, fetchImpl }) {
  const d = PROVIDERS[provider]?.defaultModel || undefined;
  const cfg = { apiKey, model: model || d, smartModel: smartModel || model || d, baseUrl, ...(fetchImpl ? { fetchImpl } : {}) };
  if (provider === "openai") return createOpenAI(cfg);
  if (provider === "anthropic") return createAnthropic(cfg);
  if (provider === "gemini") return createGemini(cfg);
  return null;
}
