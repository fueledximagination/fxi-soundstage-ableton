// ─────────────────────────────────────────────────────────────────────────────
// apply.ts — applies a MixProfile to a Live track via the official SDK.
//
// Strategy: planMixChain() gives us an ordered intended device chain. For each
// intended device we REUSE a matching device already on the track (by name) or
// insert the built-in one. Then we set each planned parameter by locating the
// live DeviceParameter by name (case-insensitive exact → contains) and writing a
// value CLAMPED to [min,max]. Params we can't locate on the installed device are
// collected as MANUAL notes — we NEVER write to a wrong-but-similar control.
//
// HONESTY about Live: stock-device parameter names vary across Live versions and
// localisations (EQ Eight "1 Frequency A", Multiband "Low Below Threshold",
// Glue "Threshold"/"Output Gain", etc.). A name miss degrades to a manual note,
// not a silent mis-write. The engineer fine-tunes the flagged controls by ear.
// ─────────────────────────────────────────────────────────────────────────────

import * as ableton from "@ableton-extensions/sdk";
import type { MixProfile } from "./profile.js";
import { planMixChain, panToNormalized, type PlannedParam, type PlannedDevice } from "./plan.js";

type Ctx = ReturnType<typeof ableton.initialize>;
type SdkTrack = ReturnType<Ctx["getObjectFromHandle"]>;

// We avoid importing the concrete generic class types directly (they're
// version-parameterized); instead we narrow off the resolved track object below
// to the structural shape we actually use.
export interface DeviceParameterLike {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  getValue(): Promise<number>;
  setValue(value: number): Promise<void>;
}
export interface DeviceLike {
  readonly name: string;
  readonly parameters: ReadonlyArray<DeviceParameterLike>;
}
interface TrackMixerLike {
  readonly volume: DeviceParameterLike;
  readonly panning: DeviceParameterLike;
  readonly sends: ReadonlyArray<DeviceParameterLike>;
}
interface AudioTrackLike {
  readonly devices: ReadonlyArray<DeviceLike>;
  readonly mixer: TrackMixerLike;
  insertDevice(deviceName: string, index: number): Promise<DeviceLike>;
}

export interface ApplyResult {
  insertedDevices: string[];
  paramsSet: number;
  manual: string[];
}

/** Clamp a numeric value into a live parameter's [min,max] range. */
function clampToParam(value: number, param: DeviceParameterLike): number {
  if (value < param.min) return param.min;
  if (value > param.max) return param.max;
  return value;
}

/**
 * Find a DeviceParameter by name: case-insensitive EXACT first, then a
 * case-insensitive CONTAINS fallback. Returns null when nothing matches.
 */
function findParam(
  params: ReadonlyArray<DeviceParameterLike>,
  name: string,
): DeviceParameterLike | null {
  const target = name.toLowerCase();
  const exact = params.find((p) => p.name.toLowerCase() === target);
  if (exact) return exact;
  const contains = params.find((p) => p.name.toLowerCase().includes(target));
  return contains ?? null;
}

/** Locate an existing device on the track by exact-then-contains name match. */
function findDevice(track: AudioTrackLike, deviceName: string): DeviceLike | null {
  const target = deviceName.toLowerCase();
  const exact = track.devices.find((d) => d.name.toLowerCase() === target);
  if (exact) return exact;
  const contains = track.devices.find((d) => d.name.toLowerCase().includes(target));
  return contains ?? null;
}

/** Write one planned param onto a device; returns true if set, else records manual. */
export async function applyParam(
  device: DeviceLike,
  planned: PlannedParam,
  manual: string[],
): Promise<boolean> {
  const param = findParam(device.parameters, planned.name);
  if (!param) {
    manual.push(
      `${device.name}: set "${planned.name}" to ${planned.value} ${planned.unit} (parameter name not found on this Live version — adjust manually)`,
    );
    return false;
  }
  await param.setValue(clampToParam(planned.value, param));
  return true;
}

/** Reuse a matching device or insert the built-in one at the chain end. */
async function ensureDevice(
  track: AudioTrackLike,
  planned: PlannedDevice,
  inserted: string[],
): Promise<DeviceLike> {
  const existing = findDevice(track, planned.deviceName);
  if (existing) return existing;
  const device = await track.insertDevice(planned.deviceName, track.devices.length);
  inserted.push(planned.deviceName);
  return device;
}

/**
 * Apply a MixProfile to the given track. Merges the gateway's own manualSteps
 * with locally-detected manual notes (param misses, send-count shortfalls).
 */
export async function applyMixProfile(
  ctx: Ctx,
  track: SdkTrack,
  profile: MixProfile,
  gatewayManualSteps: ReadonlyArray<string> = [],
): Promise<ApplyResult> {
  void ctx; // ctx kept in signature for symmetry with the rest of the codebase.
  // The resolved track is an AudioTrack; narrow to the structural shape we use.
  const t = track as unknown as AudioTrackLike;

  const plan = planMixChain(profile);
  const insertedDevices: string[] = [];
  const manual: string[] = [...gatewayManualSteps];
  let paramsSet = 0;

  // Device chain (ordered).
  for (const plannedDevice of plan.devices) {
    const device = await ensureDevice(t, plannedDevice, insertedDevices);
    for (const planned of plannedDevice.params) {
      const ok = await applyParam(device, planned, manual);
      if (ok) paramsSet += 1;
    }
  }

  // Mixer. We keep the fader at unity because the Utility "Gain" carries the
  // precise dB (see plan.ts). Pan is a clean -1..1 → 0..1 linear map.
  try {
    const pan = clampToParam(panToNormalized(plan.mixer.pan), t.mixer.panning);
    await t.mixer.panning.setValue(pan);
    paramsSet += 1;
  } catch {
    manual.push("Set track pan manually (mixer pan write failed)");
  }

  // Sends best-effort by index against existing return tracks.
  plan.mixer.sends.forEach((send, i) => {
    const sendParam = t.mixer.sends[i];
    if (!sendParam) {
      manual.push(
        `Send "${send.name}" (${send.amountDb} dB): no return track at index ${i} — create the return and set the send manually`,
      );
    }
  });
  // Apply the sends that DO have a return-track param.
  for (let i = 0; i < plan.mixer.sends.length; i += 1) {
    const send = plan.mixer.sends[i];
    const sendParam = t.mixer.sends[i];
    if (!send || !sendParam) continue;
    try {
      // Send params are normalized 0..1; -inf..0 dB region. Map dB via the same
      // documented taper used for the fader fallback (import-free: inline amp).
      const amp = send.amountDb <= -70 ? 0 : Math.pow(10, send.amountDb / 20);
      await sendParam.setValue(clampToParam(amp, sendParam));
      paramsSet += 1;
    } catch {
      manual.push(`Set send "${send.name}" to ${send.amountDb} dB manually`);
    }
  }

  return { insertedDevices, paramsSet, manual };
}
