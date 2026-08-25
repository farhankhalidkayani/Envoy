import { Injectable } from "@nestjs/common";
import { silentWav } from "./wav.js";
import type { TtsProvider, TtsSynthesizeResult } from "./types.js";

const SILENT_WAV_BASE64 = silentWav().toString("base64");

/**
 * Deterministic, zero-dependency provider used by default (TTS_PROVIDER=mock).
 * Ignores the input text and always returns the same short, valid, silent
 * WAV file — this exercises the real audio-element playback path in the
 * widget/e2e tests (a real, decodable, playable file) without needing an
 * actual speech engine. Content fidelity isn't the point of the mock.
 */
@Injectable()
export class MockTtsProvider implements TtsProvider {
  readonly name = "mock";

  async synthesize(): Promise<TtsSynthesizeResult> {
    return { audioBase64: SILENT_WAV_BASE64, mimeType: "audio/wav" };
  }
}
