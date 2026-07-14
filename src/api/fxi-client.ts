import { getAccessToken } from "../auth/session-manager.js";
import { GATEWAY_URL, SUPABASE_PUBLISHABLE_KEY } from "../config.js";
import type { MixProfile } from "../mix/profile.js";

export type { MixProfile } from "../mix/profile.js";

// Typed wrapper over the soundstage-extension gateway. The extension speaks ONLY
// this contract — never internal edge-function shapes.

export interface ModelOption {
  id: string;
  label: string;
  supportsVocals: boolean;
  supportsMelody: boolean;
  available: boolean;
}

export interface GenerateRequest {
  lyrics?: string;
  /** Multi-provider fan-out: one sample set per model. */
  models?: string[];
  model?: string;
  title?: string;
  style?: string;
  variants?: number;
  instrumental?: boolean;
  /** Public URL of a rendered MIDI→WAV melody (melody-capable models only). */
  melodyUrl?: string;
  /** Ableton project tempo (BPM), read from the Live set at generate-time so
      the generated track matches the session. */
  tempo?: number;
}

export interface GenerateResponse {
  jobId: string;
  trackIds: string[];
  models: string[];
  variants: number;
  creditsQuoted: number;
}

export interface Sample {
  trackId: string;
  idx: number;
  title: string;
  /** FXI model label for the badge (never a provider name). */
  model: string | null;
  status: "pending" | "dispatched" | "generating" | "complete" | "failed";
  audioUrl: string | null;
  durationSec: number | null;
  /** Derive lifecycle for stems: null | queued | deriving | derived | derive_failed. */
  deriveStatus: string | null;
  stems: { wavUrl: string | null; instrumentalUrl: string | null; vocalUrl: string | null } | null;
  /** Mapped, user-facing failure reason (set on failed takes only). */
  error?: string | null;
  /** Stable failure code, e.g. "copyright_lyrics" (failed takes only). */
  errorCode?: string | null;
}

export interface StatusResponse {
  jobId: string;
  done: boolean;
  samples: Sample[];
  /** Stable code when the whole job failed with no usable take. */
  error?: string | null;
  /** User-facing reason when the whole job failed (e.g. copyrighted lyrics). */
  message?: string | null;
}

export interface MelodyResponse {
  melodyUrl: string;
}

export interface StemsResponse {
  trackId: string;
  /** null | queued | deriving | derived | derive_failed. */
  deriveStatus?: string | null;
  /** Lossless WAV master. Null until the WAV conversion lands. */
  wavUrl?: string | null;
  /** Instrumental stem (vocals removed). Null until separation lands. */
  instrumentalUrl?: string | null;
  /** Isolated vocal stem. Null until separation lands. */
  vocalUrl?: string | null;
}

/** Mix Master target: the master chain or the selected track. */
export type MixTarget = "master" | "track";

export interface MixMasterRequest {
  /** https URL of a reference track to match (advanced). Mutually exclusive with templateKey. */
  referenceUrl?: string;
  /** One of the 7 built-in template keys. Mutually exclusive with referenceUrl. */
  templateKey?: string;
  target?: MixTarget;
}

export interface MixMasterResponse {
  profile: MixProfile;
  /** null on the reference path. */
  templateKey: string | null;
  /** Steps the resident client can't reliably automate ([] on the template path). */
  manualSteps: string[];
  source: "template" | "reference";
  /** true only when a WAV reference was DSP-analyzed. */
  measured: boolean;
  target: MixTarget;
}

export class GatewayError extends Error {
  constructor(
    /** HTTP status, or 0 when the request never reached the gateway (network). */
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

/**
 * Human, on-brand message for a GatewayError, chosen by HTTP status. 5xx, a
 * timeout, and network failures are OUR problem, not the user's — say so,
 * reassure that failed work isn't charged, and surface the status code so
 * support can triage. A 4xx that carries a genuine, user-facing server message
 * (e.g. copyrighted lyrics) keeps that message instead of a generic line.
 */
export function describeGatewayError(err: GatewayError): string {
  const { status, code, message } = err;
  // Network / no response — fetch threw before any HTTP status came back.
  if (status === 0 || code === "network") {
    return "Couldn't reach SoundStage. Check your internet connection and try again — nothing was charged.";
  }
  if (status === 401 || status === 403) {
    return "Your SoundStage session expired. Sign in again to keep going.";
  }
  if (status === 402 || code === "insufficient_credits") {
    return "You're out of SoundStage credits. Top up at fxi.studio/soundstage, then try again.";
  }
  if (status === 408 || status === 504) {
    return "SoundStage took too long to respond and timed out. That's on us — your credits weren't charged. Please try again.";
  }
  if (status === 429) {
    return "SoundStage is busy right now — too many requests at once. Wait a few seconds and try again; nothing was charged.";
  }
  if (status >= 500) {
    return (
      `SoundStage's audio service hit a problem on our end (error ${status}). ` +
      "This isn't your fault and failed takes aren't charged — please try again in a moment. " +
      "If it keeps happening, reach us at support@fxi.studio."
    );
  }
  // A 4xx with a real, user-facing message → trust it; otherwise stay generic.
  if (message && message !== code && message !== "gateway_error") return message;
  return "SoundStage couldn't complete that request. Please check your inputs and try again.";
}

async function call<T>(action: string, payload: Record<string, unknown>, authed = true): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    apikey: SUPABASE_PUBLISHABLE_KEY,
  };
  if (authed) headers.Authorization = `Bearer ${await getAccessToken()}`;

  // Convert a transport failure (offline, DNS, TLS, reset) into a GatewayError
  // with status 0 so every caller surfaces one friendly, mapped message instead
  // of a raw "Failed to fetch".
  let res: Response;
  try {
    res = await fetch(GATEWAY_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ action, ...payload }),
    });
  } catch (netErr) {
    throw new GatewayError(0, "network", netErr instanceof Error ? netErr.message : "network error");
  }

  // A 5xx often returns an HTML error page or an empty body rather than JSON;
  // `.catch(() => ({}))` keeps that from throwing so we fall through to the
  // status-based message in describeGatewayError.
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code = typeof body.error === "string" ? body.error : "gateway_error";
    const message = typeof body.message === "string" ? body.message : code;
    throw new GatewayError(res.status, code, message);
  }
  return body as T;
}

export async function listModels(): Promise<ModelOption[]> {
  const res = await call<{ models: ModelOption[] }>("models", {}, false);
  return res.models;
}

export function uploadMelody(wavBase64: string): Promise<MelodyResponse> {
  return call<MelodyResponse>("melody", { wavBase64 });
}

export function generate(req: GenerateRequest): Promise<GenerateResponse> {
  return call<GenerateResponse>("generate", { ...req });
}

export interface EnhanceRequest {
  /** "re-sing" = Suno cover (AI re-performs); "vocal-max" = resemble-enhance
      (keeps the voice, de-noise + restore); "isolate-vocals" = Demucs source
      separation (pull the clean vocal out of any mix); "isolate-instrumental" =
      the SAME Demucs separation, delivering the instrumental (no_vocals) stem. */
  mode: "re-sing" | "vocal-max" | "isolate-vocals" | "isolate-instrumental";
  /** Public URL of the uploaded sung clip. */
  sourceAudioUrl: string;
  /** Re-sing only — optional style + lyrics direction. */
  style?: string;
  lyrics?: string;
  title?: string;
  instrumental?: boolean;
  tempo?: number;
}

export function enhanceVocals(req: EnhanceRequest): Promise<GenerateResponse> {
  return call<GenerateResponse>("enhance", { ...req });
}

export function getStatus(jobId: string): Promise<StatusResponse> {
  return call<StatusResponse>("status", { jobId });
}

/**
 * The user's previously generated SoundStage takes — completed, audio-bearing
 * tracks, newest first. Lets the extension double as a personal sample library:
 * each item is a `Sample` and inserts through the same import helpers.
 */
export async function listLibrary(): Promise<Sample[]> {
  const r = await call<{ samples: Sample[] }>("library", {});
  return r.samples;
}

export function deriveStems(trackId: string): Promise<StemsResponse> {
  return call<StemsResponse>("stems", { trackId });
}

/**
 * Resolve a Mix Master profile from the gateway — either a built-in template or a
 * reference-track match. Analysis-only: deducts no credits.
 */
export function getMixProfile(req: MixMasterRequest): Promise<MixMasterResponse> {
  return call<MixMasterResponse>("mix-master", { ...req });
}
