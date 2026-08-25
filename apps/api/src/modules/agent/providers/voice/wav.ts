/**
 * Minimal 44-byte canonical WAV header writer. Gemini's TTS endpoint returns
 * raw headerless PCM, which no browser <audio> element can play directly —
 * this wraps it so every provider (mock or real) hands the gateway/widget
 * back an already-playable audio/wav blob.
 */
export function pcmToWav(pcm: Buffer, sampleRate: number, bitsPerSample: number, channels: number): Buffer {
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

/** A short, valid, silent 16-bit/24kHz/mono WAV — used by MockTtsProvider. */
export function silentWav(seconds = 0.3): Buffer {
  const sampleRate = 24000;
  const samples = Math.round(sampleRate * seconds);
  const pcm = Buffer.alloc(samples * 2); // 16-bit silence is all-zero bytes
  return pcmToWav(pcm, sampleRate, 16, 1);
}
