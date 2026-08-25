import { Inject, Injectable, Logger } from "@nestjs/common";
import type { RequiredFieldsSpec } from "@envoy/types";
import { validateFieldValue } from "@envoy/types";
import { embedRequiredFields } from "../providers/llm/prompt-markers.js";
import { LLM_PROVIDER } from "../providers/llm/llm-provider.module.js";
import type { LlmProvider } from "../providers/llm/types.js";

const EXTRACTION_INSTRUCTIONS = [
  "Extract any of the following fields the visitor's latest message provides a value for.",
  "Respond with ONLY a JSON object mapping field keys to extracted values — omit keys you",
  "cannot confidently fill from this message. Do not guess.",
].join(" ");

@Injectable()
export class FieldExtractorService {
  private readonly logger = new Logger(FieldExtractorService.name);

  constructor(@Inject(LLM_PROVIDER) private readonly llm: LlmProvider) {}

  /**
   * Runs a cheap, separate extraction pass over the visitor's latest message
   * and merges any newly-found, individually-valid values into the running
   * capturedData accumulator. Never throws — a bad/unparseable extraction
   * degrades to "nothing new captured this turn," not a broken conversation.
   */
  async extractAndMerge(params: {
    fields: RequiredFieldsSpec;
    latestUserMessage: string;
    capturedDataSoFar: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    if (params.fields.length === 0) return params.capturedDataSoFar;

    let raw: string;
    try {
      const result = await this.llm.complete({
        purpose: "extract",
        messages: [
          {
            role: "system",
            content: `${EXTRACTION_INSTRUCTIONS}\n${embedRequiredFields(params.fields)}`,
          },
          { role: "user", content: params.latestUserMessage },
        ],
        maxTokens: 300,
      });
      raw = result.text;
    } catch (err) {
      this.logger.warn(`extraction call failed: ${(err as Error).message}`);
      return params.capturedDataSoFar;
    }

    let parsed: Record<string, unknown>;
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(match ? match[0] : raw) as Record<string, unknown>;
    } catch {
      this.logger.warn(`extraction response was not valid JSON: ${raw.slice(0, 200)}`);
      return params.capturedDataSoFar;
    }

    const merged = { ...params.capturedDataSoFar };
    for (const field of params.fields) {
      if (!(field.key in parsed)) continue;
      const outcome = validateFieldValue(field, parsed[field.key]);
      if (outcome.valid) {
        merged[field.key] = outcome.value;
      } else {
        this.logger.debug(`discarded extracted value for "${field.key}": ${outcome.error}`);
      }
    }
    return merged;
  }
}
