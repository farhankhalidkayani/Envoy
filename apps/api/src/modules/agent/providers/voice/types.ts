export interface SttTranscribeResult {
  text: string;
}

export interface SttProvider {
  readonly name: string;
  transcribe(audioBase64: string, mimeType: string): Promise<SttTranscribeResult>;
}

export interface TtsSynthesizeResult {
  audioBase64: string;
  mimeType: string;
}

export interface TtsProvider {
  readonly name: string;
  synthesize(text: string): Promise<TtsSynthesizeResult>;
}
