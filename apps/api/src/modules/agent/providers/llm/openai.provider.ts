import { OpenAiCompatibleProvider } from "./openai-compatible.provider.js";

/** OpenAI's chat completions API. `baseUrl` (a tenant-supplied proxy or Azure-style gateway) is SSRF-guarded; the default is not. */
export class OpenAiLlmProvider extends OpenAiCompatibleProvider {
  constructor(apiKey: string, model: string, baseUrl?: string) {
    super({
      name: "openai",
      apiKey,
      model,
      url: baseUrl ? `${baseUrl.replace(/\/+$/, "")}/chat/completions` : "https://api.openai.com/v1/chat/completions",
      guardUrl: Boolean(baseUrl),
    });
  }
}

/** A self-hosted or third-party endpoint speaking the OpenAI protocol. Always SSRF-guarded. */
export class CustomOpenAiLlmProvider extends OpenAiCompatibleProvider {
  constructor(apiKey: string, model: string, baseUrl: string) {
    super({
      name: "openai_compatible",
      apiKey,
      model,
      url: `${baseUrl.replace(/\/+$/, "")}/chat/completions`,
      guardUrl: true,
    });
  }
}
