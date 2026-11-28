import { z } from "zod";

/**
 * Bring-your-own-model configuration. A tenant stores provider API keys
 * (ModelCredential rows, encrypted) and chooses which credential + model
 * serves each role. Anything unconfigured falls back to the platform's shared
 * default model.
 */

export const MODEL_PROVIDER_KINDS = ["anthropic", "openai", "gemini", "groq", "openai_compatible"] as const;
export const ModelProviderKind = z.enum(MODEL_PROVIDER_KINDS);
export type ModelProviderKind = z.infer<typeof ModelProviderKind>;

/** Each AI job an agent needs done is a role, so a tenant can put a strong model on the reply and a cheap one on summaries. */
export const MODEL_ROLES = ["chat", "judge", "extract", "summarize"] as const;
export const ModelRole = z.enum(MODEL_ROLES);
export type ModelRole = z.infer<typeof ModelRole>;

export const ModelChoice = z.object({
  credentialId: z.string().min(1),
  model: z.string().min(1).max(100),
});
export type ModelChoice = z.infer<typeof ModelChoice>;

export type ModelTier = "best" | "balanced" | "fast";

export interface CatalogModel {
  id: string;
  label: string;
  tier: ModelTier;
}

/** Suggested models per provider. Advisory only — any model id the provider accepts can be typed in, and saving a key tests it. */
/**
 * Voice jobs: turning a visitor's speech into text (stt) and the agent's reply into speech (tts). Unlike the text
 * roles they never inherit `default` — a chat model can't transcribe — so each is set on its own or stays on the
 * platform's voice.
 */
export const VOICE_ROLES = ["stt", "tts"] as const;
export const VoiceRole = z.enum(VOICE_ROLES);
export type VoiceRole = z.infer<typeof VoiceRole>;

export const TtsChoice = ModelChoice.extend({
  /** The provider's voice name, e.g. "alloy" (OpenAI) or "Kore" (Gemini). Unset = the provider's default below. */
  voice: z.string().trim().min(1).max(50).optional(),
});
export type TtsChoice = z.infer<typeof TtsChoice>;

/** Which providers can do each voice job. Anthropic has no speech API. */
export const VOICE_PROVIDERS: Record<VoiceRole, readonly ModelProviderKind[]> = {
  stt: ["openai", "groq", "openai_compatible"],
  tts: ["openai", "gemini", "openai_compatible"],
};

/** Suggested voice models, and the voice used when none is named. Advisory: any model id the provider accepts works. */
export const VOICE_CATALOG: { stt: Partial<Record<ModelProviderKind, CatalogModel[]>>; tts: Partial<Record<ModelProviderKind, Array<CatalogModel & { defaultVoice: string }>>> } = {
  stt: {
    openai: [
      { id: "gpt-4o-transcribe", label: "GPT-4o Transcribe", tier: "best" },
      { id: "gpt-4o-mini-transcribe", label: "GPT-4o mini Transcribe", tier: "fast" },
    ],
    groq: [
      { id: "whisper-large-v3", label: "Whisper large v3", tier: "best" },
      { id: "whisper-large-v3-turbo", label: "Whisper large v3 turbo", tier: "fast" },
    ],
  },
  tts: {
    openai: [
      { id: "gpt-4o-mini-tts", label: "GPT-4o mini TTS", tier: "best", defaultVoice: "alloy" },
      { id: "tts-1", label: "TTS-1", tier: "fast", defaultVoice: "alloy" },
    ],
    gemini: [
      { id: "gemini-2.5-pro-preview-tts", label: "Gemini 2.5 Pro TTS", tier: "best", defaultVoice: "Kore" },
      { id: "gemini-2.5-flash-preview-tts", label: "Gemini 2.5 Flash TTS", tier: "fast", defaultVoice: "Kore" },
    ],
  },
};

export const supportsVoiceRole = (provider: ModelProviderKind, role: VoiceRole) => VOICE_PROVIDERS[role].includes(provider);

/** `default` serves every TEXT role that has no entry of its own; voice roles are set individually. */
export const ModelConfig = z.object({
  default: ModelChoice.optional(),
  chat: ModelChoice.optional(),
  judge: ModelChoice.optional(),
  extract: ModelChoice.optional(),
  summarize: ModelChoice.optional(),
  stt: ModelChoice.optional(),
  tts: TtsChoice.optional(),
  /** When a tenant key fails (rejected, out of quota, provider down), serve the request from the platform default instead of failing the visitor. */
  allowPlatformFallback: z.boolean().default(true),
});
export type ModelConfig = z.infer<typeof ModelConfig>;

export const MODEL_CATALOG: Record<Exclude<ModelProviderKind, "openai_compatible">, CatalogModel[]> = {
  anthropic: [
    { id: "claude-opus-5-5", label: "Claude Opus 5.5", tier: "best" },
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", tier: "balanced" },
    { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", tier: "fast" },
  ],
  openai: [
    { id: "gpt-4.1", label: "GPT-4.1", tier: "best" },
    { id: "gpt-4.1-mini", label: "GPT-4.1 mini", tier: "balanced" },
    { id: "gpt-4.1-nano", label: "GPT-4.1 nano", tier: "fast" },
  ],
  gemini: [
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", tier: "best" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", tier: "balanced" },
    { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash", tier: "fast" },
  ],
  groq: [
    { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B", tier: "best" },
    { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B", tier: "fast" },
  ],
};

export const PROVIDER_LABELS: Record<ModelProviderKind, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI",
  gemini: "Google Gemini",
  groq: "Groq",
  openai_compatible: "OpenAI-compatible endpoint",
};

export const MODEL_PRESETS = ["best_quality", "balanced", "lowest_cost"] as const;
export type ModelPreset = (typeof MODEL_PRESETS)[number];

export const PRESET_LABELS: Record<ModelPreset, { label: string; help: string }> = {
  best_quality: { label: "Best quality", help: "Strongest model for replies and rule checks; a fast one for extraction and summaries." },
  balanced: { label: "Balanced", help: "A mid-tier model for replies and rule checks; a fast one for extraction and summaries." },
  lowest_cost: { label: "Lowest cost", help: "The fastest, cheapest model for every job." },
};

function pick(provider: ModelProviderKind, tier: ModelTier): string | undefined {
  if (provider === "openai_compatible") return undefined;
  const models = MODEL_CATALOG[provider];
  // A provider may lack a tier (Groq has no "balanced"): fall back to the nearest stronger one, then any.
  const order: ModelTier[] = tier === "fast" ? ["fast", "balanced", "best"] : tier === "balanced" ? ["balanced", "best", "fast"] : ["best", "balanced", "fast"];
  for (const t of order) {
    const hit = models.find((m) => m.tier === t);
    if (hit) return hit.id;
  }
  return undefined;
}

/** The role→model assignment a preset produces for one provider, or null when that provider has no catalog (custom endpoints). */
export function presetModels(provider: ModelProviderKind, preset: ModelPreset): Record<ModelRole, string> | null {
  const best = pick(provider, "best");
  const balanced = pick(provider, "balanced");
  const fast = pick(provider, "fast");
  if (!best || !balanced || !fast) return null;
  switch (preset) {
    case "best_quality":
      return { chat: best, judge: best, extract: fast, summarize: fast };
    case "balanced":
      return { chat: balanced, judge: balanced, extract: fast, summarize: fast };
    case "lowest_cost":
      return { chat: fast, judge: fast, extract: fast, summarize: fast };
  }
}

/** Which role a legacy LlmPurpose maps to. */
export function roleForPurpose(purpose: "chat" | "extract" | "summarize"): ModelRole {
  return purpose;
}
