import { Injectable } from "@nestjs/common";
import { OpenAiCompatibleProvider } from "./openai-compatible.provider.js";

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
// llama-3.3-70b-versatile was retired from Groq's catalog; openai/gpt-oss-120b
// is the current general-purpose chat model with comparable quality.
const DEFAULT_MODEL = "openai/gpt-oss-120b";

/** Groq's OpenAI-compatible chat completions API — https://console.groq.com/docs/api-reference */
@Injectable()
export class GroqLlmProvider extends OpenAiCompatibleProvider {
  constructor(apiKey: string, model = DEFAULT_MODEL) {
    super({ name: "groq", apiKey, model, url: GROQ_API_URL });
  }
}
