// MIDI → WAV renderer. Pure Node (Buffer/Float32 math), no native deps.
// Renders Ableton notes to 44.1 kHz mono 16-bit PCM via additive-oscillator
// synthesis + ADSR. For melody conditioning, contour matters more than timbre,
// so a deliberately minimal synth is sufficient.
// Algorithm: docs/specs/ableton-extension-providers.md §"MIDI → WAV".

export interface RenderNote {
  pitch: number; // MIDI note number
  start: number; // seconds
  dur: number; // seconds
  velocity: number; // 0..127
}

const SR = 44100;

const freqOf = (n: number): number => 440 * Math.pow(2, (n - 69) / 12);

function adsr(t: number, dur: number, a = 0.01, d = 0.06, s = 0.7, r = 0.08): number {
  if (t < 0 || t > dur + r) return 0;
  if (t < a) return t / a;
  if (t < a + d) return 1 - (1 - s) * ((t - a) / d);
  if (t < dur) return s;
  return s * (1 - (t - dur) / r);
}

export function renderNotesToWav(notes: RenderNote[]): Buffer {
  if (notes.length === 0) return floatToWav16(new Float32Array(SR), SR); // 1s silence
  const end = notes.reduce((m, n) => Math.max(m, n.start + n.dur + 0.1), 0);
  const total = Math.ceil(end * SR);
  const buf = new Float32Array(total);

  for (const n of notes) {
    const f = freqOf(n.pitch);
    const amp = (Math.max(1, n.velocity) / 127) * 0.25;
    const s0 = Math.max(0, Math.floor(n.start * SR));
    const sEnd = Math.min(total, Math.floor((n.start + n.dur + 0.08) * SR));
    for (let i = s0; i < sEnd; i++) {
      const t = (i - s0) / SR;
      const phase = 2 * Math.PI * f * t;
      const sample = Math.sin(phase) + 0.3 * Math.sin(2 * phase) + 0.12 * Math.sin(3 * phase);
      buf[i] = (buf[i] ?? 0) + (sample / 1.42) * amp * adsr(t, n.dur);
    }
  }
  for (let i = 0; i < total; i++) buf[i] = Math.max(-1, Math.min(1, buf[i]!));
  return floatToWav16(buf, SR);
}

function floatToWav16(samples: Float32Array, sampleRate: number): Buffer {
  const n = samples.length;
  const dataBytes = n * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  let o = 44;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    buf.writeInt16LE(Math.round(s * 32767), o);
    o += 2;
  }
  return buf;
}
