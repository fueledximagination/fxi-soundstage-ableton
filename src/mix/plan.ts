// ─────────────────────────────────────────────────────────────────────────────
// plan.ts — PURE, SDK-free Mix Master chain planner (the testable core).
//
// planMixChain(profile) turns a provider-agnostic MixProfile into an ORDERED list
// of intended built-in Live devices and the parameter values to write on each,
// plus the mixer routing. It performs NO I/O and imports NO SDK — apply.ts
// consumes this plan and reconciles it against the live device chain.
//
// Param NAMES here are the canonical Live 12 stock-device names we attempt FIRST.
// Live's parameter naming varies across versions and localisations; apply.ts does
// case-insensitive exact-then-contains matching and degrades any unmatched param
// to a manual note rather than writing the wrong control. The names below are
// therefore best-effort targets, not guarantees.
// ─────────────────────────────────────────────────────────────────────────────

import type { MixProfile, MixerSend } from "./profile.js";

export type ParamUnit = "dB" | "Hz" | "ratio" | "ms" | "percent" | "normalized" | "raw";

export interface PlannedParam {
  /** Canonical Live parameter name to target (matched case-insensitively). */
  name: string;
  /** Numeric value in the unit below. apply.ts clamps to the live param range. */
  value: number;
  unit: ParamUnit;
}

export interface PlannedDevice {
  /** Built-in Live device name passed to Track.insertDevice. */
  deviceName: string;
  params: PlannedParam[];
}

export interface PlannedMixer {
  volumeDb: number;
  /** -1..1. */
  pan: number;
  sends: MixerSend[];
}

export interface MixPlan {
  profileKey: string;
  /** Ordered signal chain, first-inserted first. */
  devices: PlannedDevice[];
  mixer: PlannedMixer;
}

// ─── dB / mapping helpers (documented assumptions) ───────────────────────────

/**
 * Convert a dB level to a normalized amplitude in [0,1] using a monotonic
 * approximation of Live's proprietary fader taper.
 *
 * ASSUMPTIONS (documented, intentionally honest — NOT a bit-exact inverse of
 * Live's curve):
 *   • 0 dB  → 0.85  (Live's unity marker sits near 0.85 on the 0..1 mixer param)
 *   • +6 dB → 1.0   (top of the fader)
 *   • below unity: linear in amplitude (10^(dB/20)) scaled so 0 dB lands on 0.85
 *   • −70 dB and below → 0.0 (treated as silence)
 *
 * We PREFER routing precise gain through a Utility "Gain" param (real dB) over
 * the mixer fader; this helper exists for the mixer fader fallback and is flagged
 * to the engineer for fine-tuning by ear.
 */
export function dbToGainNormalized(db: number): number {
  const UNITY_NORM = 0.85;
  if (db >= 6) return 1;
  if (db <= -70) return 0;
  if (db >= 0) {
    // 0 dB → 0.85, +6 dB → 1.0 (linear in the small upper region).
    return UNITY_NORM + (db / 6) * (1 - UNITY_NORM);
  }
  // Below unity: linear in amplitude, scaled so 0 dB → 0.85.
  const amp = Math.pow(10, db / 20); // 1.0 at 0 dB → ~0.000316 at -70 dB
  return clamp01(amp * UNITY_NORM);
}

/** Map a pan position (-1 L .. +1 R) onto Live's 0..1 linear panning param. */
export function panToNormalized(pan: number): number {
  const p = Math.max(-1, Math.min(1, pan));
  return (p + 1) / 2; // -1 → 0.0, 0 → 0.5, +1 → 1.0
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

// ─── EQ Eight band mapping ───────────────────────────────────────────────────
// EQ Eight exposes 8 bands. We map each MixProfile eqBand onto band N (1-based).
// Per band the relevant params are "<N> Frequency A", "<N> Gain A", "<N> Resonance A"
// and "<N> Filter Type A" (an enum). We emit Frequency/Gain/Resonance as numeric
// targets; filter type is left to the band's default to avoid mis-indexing the
// quantized enum across versions (surfaced as a manual note in apply.ts).

function eqEightParams(profile: MixProfile): PlannedParam[] {
  const params: PlannedParam[] = [];
  profile.eqBands.slice(0, 8).forEach((band, i) => {
    const n = i + 1;
    params.push({ name: `${n} Frequency A`, value: band.freqHz, unit: "Hz" });
    if (band.gainDb !== 0) {
      params.push({ name: `${n} Gain A`, value: band.gainDb, unit: "dB" });
    }
    params.push({ name: `${n} Resonance A`, value: band.q, unit: "raw" });
  });
  return params;
}

// ─── Device builders ─────────────────────────────────────────────────────────

function glueCompressorParams(profile: MixProfile): PlannedParam[] {
  const c = profile.compression;
  return [
    { name: "Threshold", value: c.thresholdDb, unit: "dB" },
    { name: "Ratio", value: c.ratio, unit: "ratio" },
    { name: "Attack", value: c.attackMs, unit: "ms" },
    { name: "Release", value: c.releaseMs, unit: "ms" },
    { name: "Makeup", value: c.makeupDb, unit: "dB" },
  ];
}

function multibandDynamicsParams(profile: MixProfile): PlannedParam[] {
  const m = profile.multiband;
  // Multiband Dynamics "Below" threshold/ratio per band. Names vary by version
  // ("Low Below Threshold" vs "L Below Thresh"); we target the long form first.
  return [
    { name: "Low Below Threshold", value: m.low.thresholdDb, unit: "dB" },
    { name: "Low Below Ratio", value: m.low.ratio, unit: "ratio" },
    { name: "Mid Below Threshold", value: m.mid.thresholdDb, unit: "dB" },
    { name: "Mid Below Ratio", value: m.mid.ratio, unit: "ratio" },
    { name: "High Below Threshold", value: m.high.thresholdDb, unit: "dB" },
    { name: "High Below Ratio", value: m.high.ratio, unit: "ratio" },
  ];
}

function saturatorParams(profile: MixProfile): PlannedParam[] {
  // Saturator "Drive" is in dB (0..36). Map normalized 0..1 drive → 0..18 dB
  // (a musical half-range; full 36 dB is destructive). Documented assumption.
  const driveDb = Math.max(0, Math.min(1, profile.saturation.drive)) * 18;
  return [{ name: "Drive", value: driveDb, unit: "dB" }];
}

function utilityParams(profile: MixProfile): PlannedParam[] {
  // Utility carries TWO MixProfile intents:
  //   • stereo width  → "Stereo Width" / "Width" (0..200 %, but Live's param is
  //     0..400 % with 100 % = unchanged; we pass the profile percent directly and
  //     let apply.ts clamp to the live range).
  //   • bass mono     → "Bass Mono Frequency" + enabling "Bass Mono".
  //   • precise gain  → "Gain" (real dB). We route the mixer's intended volumeDb
  //     here so the dB is exact rather than going through the proprietary fader.
  return [
    { name: "Stereo Width", value: profile.stereo.widthPct, unit: "percent" },
    { name: "Bass Mono Frequency", value: profile.stereo.bassMonoHz, unit: "Hz" },
    { name: "Gain", value: profile.mixer.volumeDb, unit: "dB" },
  ];
}

function limiterParams(profile: MixProfile): PlannedParam[] {
  const l = profile.limiter;
  return [
    { name: "Ceiling", value: l.ceilingDb, unit: "dB" },
    { name: "Gain", value: l.gainDb, unit: "dB" },
  ];
}

/**
 * Build the ordered intended device chain for a profile. Order matters and
 * follows standard mastering signal flow:
 *   EQ Eight → Glue Compressor → Multiband Dynamics → Saturator → Utility → Limiter
 *
 * The Saturator is omitted when saturation.type is "none" (no useful drive).
 */
export function planMixChain(profile: MixProfile): MixPlan {
  const devices: PlannedDevice[] = [
    { deviceName: "EQ Eight", params: eqEightParams(profile) },
    { deviceName: "Glue Compressor", params: glueCompressorParams(profile) },
    { deviceName: "Multiband Dynamics", params: multibandDynamicsParams(profile) },
  ];

  if (profile.saturation.type !== "none") {
    devices.push({ deviceName: "Saturator", params: saturatorParams(profile) });
  }

  devices.push({ deviceName: "Utility", params: utilityParams(profile) });
  devices.push({ deviceName: "Limiter", params: limiterParams(profile) });

  return {
    profileKey: profile.key,
    devices,
    mixer: {
      // Utility "Gain" carries the precise dB; the mixer fader is kept at unity
      // (0 dB) so we don't double-apply gain. apply.ts honours this.
      volumeDb: 0,
      pan: profile.mixer.pan,
      sends: profile.mixer.sends.map((s) => ({ ...s })),
    },
  };
}
