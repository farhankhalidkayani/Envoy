import { Injectable } from "@nestjs/common";
import type { SttProvider, SttTranscribeResult } from "./types.js";

/**
 * Deterministic, zero-dependency provider used by default (STT_PROVIDER=mock).
 * Decodes the base64 payload as UTF-8 and returns it as the transcript.
 * `Buffer.toString("utf8")` never throws — even on real opus binary from a
 * genuine microphone recording it just produces a garbled-but-harmless
 * string (replacement characters for invalid byte sequences) — so this
 * works uniformly for a deliberately plaintext-as-base64 test fixture (clean,
 * assertable transcript) and a real/fake browser mic recording (mechanical
 * pipeline verification only, content fidelity isn't the point of the mock).
 */
@Injectable()
export class MockSttProvider implements SttProvider {
  readonly name = "mock";

  async transcribe(audioBase64: string): Promise<SttTranscribeResult> {
    return { text: Buffer.from(audioBase64, "base64").toString("utf8") };
  }
}
