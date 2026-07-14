// ─────────────────────────────────────────────────────────────────────────────
// profile.ts — single source of MixProfile types for the Ableton extension.
//
// These interfaces mirror the gateway's camelCase MixProfile shape EXACTLY (see
// supabase/functions/_shared/mix-templates.ts). The extension speaks only this
// contract — it never reaches into internal edge-function shapes. The pure
// planner (mix/plan.ts) and the SDK apply layer (mix/apply.ts) both consume
// these types.
// ─────────────────────────────────────────────────────────────────────────────

export type EqBandType = "lowshelf" | "bell" | "highshelf" | "highpass" | "lowpass";
export type SaturationType = "tape" | "tube" | "soft" | "none";

export interface EqBand {
  freqHz: number;
  gainDb: number;
  q: number;
  type: EqBandType;
}

export interface CompressionSettings {
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  makeupDb: number;
}

export interface MultibandBand {
  thresholdDb: number;
  ratio: number;
}

export interface MultibandSettings {
  low: MultibandBand;
  mid: MultibandBand;
  high: MultibandBand;
}

export interface SaturationSettings {
  /** 0..1 normalized amount. */
  drive: number;
  type: SaturationType;
}

export interface StereoSettings {
  /** 0 (mono) .. 200 (max wide). */
  widthPct: number;
  /** collapse to mono below this frequency. */
  bassMonoHz: number;
}

export interface LimiterSettings {
  /** output ceiling, e.g. -1.0 dBTP. */
  ceilingDb: number;
  /** input gain into the limiter. */
  gainDb: number;
}

export interface MixerSend {
  name: string;
  amountDb: number;
}

export interface MixerSettings {
  volumeDb: number;
  /** -1 (L) .. 1 (R). */
  pan: number;
  sends: MixerSend[];
}

export interface MixProfile {
  key: string;
  label: string;
  description: string;
  loudnessLufsTarget: number;
  truePeakDb: number;
  eqBands: EqBand[];
  compression: CompressionSettings;
  multiband: MultibandSettings;
  saturation: SaturationSettings;
  stereo: StereoSettings;
  limiter: LimiterSettings;
  mixer: MixerSettings;
}

export interface TemplateOption {
  key: string;
  label: string;
  description: string;
}

// ─── UI menu options ─────────────────────────────────────────────────────────
// Mirrors the 7 server templates (key/label/description) so the modal can render
// a dropdown WITHOUT a round-trip. The authoritative DSP payload still comes from
// the gateway; these are catalogue-only entries for selection.
export const MIX_TEMPLATE_OPTIONS: ReadonlyArray<TemplateOption> = [
  {
    key: "modern-pop-master",
    label: "Modern Pop Master",
    description: "Bright, punchy, streaming-ready pop master with controlled lows and airy top.",
  },
  {
    key: "warm-analog",
    label: "Warm Analog",
    description: "Tube-flavored, rounded master that smooths digital harshness with gentle glue.",
  },
  {
    key: "lofi-bedroom",
    label: "Lofi Bedroom",
    description: "Soft, dusty, mono-leaning lofi character with rolled-off highs and warm saturation.",
  },
  {
    key: "edm-club-loud",
    label: "EDM Club Loud",
    description: "Aggressive, ultra-loud club master with tight mono bass and wide hyped highs.",
  },
  {
    key: "acoustic-natural",
    label: "Acoustic Natural",
    description: "Transparent, dynamic-preserving master for acoustic and singer-songwriter material.",
  },
  {
    key: "hiphop-808-forward",
    label: "Hip-Hop 808 Forward",
    description: "Bass-forward hip-hop master with weighty 808s, present vocals, and crisp top.",
  },
  {
    key: "podcast-voice-clarity",
    label: "Podcast Voice Clarity",
    description: "Speech-optimized master: rumble removal, presence lift, and consistent broadcast loudness.",
  },
];
