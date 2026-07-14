// ─────────────────────────────────────────────────────────────────────────────
// vocal-max.ts — the NATIVE "Vocal-Max" rack. Instant, free, no gateway / API /
// credits. Builds a professional vocal device chain out of built-in Live devices
// and GROUPS it into an Audio Effect Rack on the target track.
//
// This reuses the exact machinery of mix/apply.ts:
//   • Track.insertDevice(name, index)     — insert a built-in Live device BY NAME
//   • applyParam(device, planned, manual) — set a DeviceParameter by case-insensitive
//                                            name (exact→contains), clamped to range,
//                                            degrading a name miss to a MANUAL note.
//
// GROUPING is REAL, not faked. The SDK exposes racks natively:
//   • Track.insertDevice("Audio Effect Rack") returns a RackDevice at runtime
//   • RackDevice.insertChain(index) / RackDevice.chains
//   • Chain.insertDevice(name, index)
// So we insert an Audio Effect Rack, create a chain inside it, and insert the whole
// vocal chain INTO that chain — the operator gets a single grouped rack.
//
// If the host doesn't hand back a populatable rack (older API / unexpected type),
// we honestly DEGRADE: insert the chain ungrouped on the track and add a manual
// "select the N devices and ⌘G / Ctrl-G to group" note — never a fake group.
//
// HONESTY about Live: stock-device parameter names vary across versions and
// localisations. Values below are canonical Live 12 targets in the parameter's
// own DISPLAY unit (dB / ms / Hz / %). apply.ts clamps to each param's [min,max]
// and degrades an unmatched name to a manual note. Percent params assume Live's
// 0..100 LOM scaling; the clamp protects against a differently-scaled range.
// ─────────────────────────────────────────────────────────────────────────────

import * as ableton from "@ableton-extensions/sdk";
import type { PlannedDevice } from "./plan.js";
import { applyParam, type ApplyResult, type DeviceLike } from "./apply.js";

type Ctx = ReturnType<typeof ableton.initialize>;
type SdkTrack = ReturnType<Ctx["getObjectFromHandle"]>;

/** The built-in Live device that hosts the grouped chain. */
const RACK_DEVICE_NAME = "Audio Effect Rack";

// Structural shapes we actually use (avoids depending on the version-parameterized
// concrete generic classes — same approach as apply.ts).
interface ChainLike {
  readonly devices: ReadonlyArray<DeviceLike>;
  insertDevice(deviceName: string, index: number): Promise<DeviceLike>;
}
interface RackLike extends DeviceLike {
  readonly chains: ReadonlyArray<ChainLike>;
  insertChain(index: number): Promise<ChainLike>;
}
interface InsertableTrack {
  readonly devices: ReadonlyArray<DeviceLike>;
  insertDevice(deviceName: string, index: number): Promise<DeviceLike>;
  deleteDevice(device: DeviceLike): Promise<void>;
}

// ─── The Vocal-Max chain (pure, ordered, testable) ───────────────────────────
// Order = professional vocal signal flow: correct pitch → control dynamics →
// add depth (delay) → add space (reverb) → final gain/width utility.
//
// Values are sane pro-vocal starting points; the operator fine-tunes to taste.
export const VOCAL_MAX_CHAIN: ReadonlyArray<PlannedDevice> = [
  {
    // Auto Shift (Live 12) — gentle pitch correction that preserves character.
    // No transpose, no formant shift; full wet so the correction path is active.
    deviceName: "Auto Shift",
    params: [
      { name: "Pitch", value: 0, unit: "raw" },
      { name: "Formant", value: 0, unit: "raw" },
      { name: "Wet", value: 100, unit: "percent" },
    ],
  },
  {
    // Compressor — classic vocal levelling: ~3:1, fast-ish attack, medium release,
    // threshold set for ~3–6 dB gain reduction on a typical take, makeup to unity.
    deviceName: "Compressor",
    params: [
      { name: "Threshold", value: -18, unit: "dB" },
      { name: "Ratio", value: 3, unit: "ratio" },
      { name: "Attack", value: 8, unit: "ms" },
      { name: "Release", value: 120, unit: "ms" },
      { name: "Output Gain", value: 3, unit: "dB" },
      { name: "Dry/Wet", value: 100, unit: "percent" },
    ],
  },
  {
    // Delay — subtle tempo-synced 1/8 throw, low feedback, mostly dry.
    deviceName: "Delay",
    params: [
      { name: "L Sync", value: 1, unit: "raw" },
      { name: "R Sync", value: 1, unit: "raw" },
      { name: "L 16th", value: 2, unit: "raw" }, // 2/16 = 1/8 note
      { name: "R 16th", value: 2, unit: "raw" },
      { name: "Feedback", value: 18, unit: "percent" },
      { name: "Dry/Wet", value: 10, unit: "percent" },
    ],
  },
  {
    // Reverb — vocal plate/room: medium decay, short predelay to keep consonants
    // clear, low wet so it sits behind the voice.
    deviceName: "Reverb",
    params: [
      { name: "Predelay", value: 20, unit: "ms" },
      { name: "Decay Time", value: 1900, unit: "ms" },
      { name: "Dry/Wet", value: 15, unit: "percent" },
    ],
  },
  {
    // Utility — final unity gain + width control, mono-fold the low end.
    deviceName: "Utility",
    params: [
      { name: "Gain", value: 0, unit: "dB" },
      { name: "Width", value: 100, unit: "percent" },
      { name: "Bass Mono Frequency", value: 120, unit: "Hz" },
    ],
  },
];

export interface VocalMaxResult extends ApplyResult {
  /** true = inserted as a single native Audio Effect Rack; false = ungrouped + manual ⌘G note. */
  grouped: boolean;
  /** The rack device name (for messaging). */
  rackDeviceName: string;
}

/** Runtime narrow: did insertDevice hand us a populatable rack? */
function isRack(device: DeviceLike): device is RackLike {
  const d = device as Partial<RackLike>;
  return typeof d.insertChain === "function" && Array.isArray(d.chains);
}

/** Apply every planned param of one device, tallying set-count + manual notes. */
async function applyDeviceParams(
  device: DeviceLike,
  planned: PlannedDevice,
  manual: string[],
): Promise<number> {
  let set = 0;
  for (const param of planned.params) {
    if (await applyParam(device, param, manual)) set += 1;
  }
  return set;
}

/**
 * Build the native Vocal-Max rack on `track`. Inserts an Audio Effect Rack at the
 * end of the track's device chain and populates a single inner chain with the
 * ordered vocal devices. Falls back to an ungrouped chain (+ manual group note)
 * only if the host doesn't return a populatable rack.
 */
export async function applyVocalMaxRack(ctx: Ctx, track: SdkTrack): Promise<VocalMaxResult> {
  void ctx; // kept for signature symmetry with applyMixProfile.
  const t = track as unknown as InsertableTrack;

  const insertedDevices: string[] = [];
  const manual: string[] = [];
  let paramsSet = 0;

  // Insert the rack shell at the end of the track's chain.
  const rackShell = await t.insertDevice(RACK_DEVICE_NAME, t.devices.length);

  if (isRack(rackShell)) {
    insertedDevices.push(RACK_DEVICE_NAME);
    // A freshly-inserted Audio Effect Rack has no chains; create one.
    const chain = rackShell.chains.length > 0 ? rackShell.chains[0] : await rackShell.insertChain(0);
    for (const planned of VOCAL_MAX_CHAIN) {
      const device = await chain.insertDevice(planned.deviceName, chain.devices.length);
      insertedDevices.push(planned.deviceName);
      paramsSet += await applyDeviceParams(device, planned, manual);
    }
    return { insertedDevices, paramsSet, manual, grouped: true, rackDeviceName: RACK_DEVICE_NAME };
  }

  // DEGRADE honestly: no populatable rack came back. Remove the shell and insert
  // the chain directly on the track, then flag a manual group step.
  try {
    await t.deleteDevice(rackShell);
  } catch {
    /* leave the empty shell in place rather than dead-ending */
  }
  for (const planned of VOCAL_MAX_CHAIN) {
    const device = await t.insertDevice(planned.deviceName, t.devices.length);
    insertedDevices.push(planned.deviceName);
    paramsSet += await applyDeviceParams(device, planned, manual);
  }
  manual.push(
    `Select the ${VOCAL_MAX_CHAIN.length} inserted devices (` +
      `${VOCAL_MAX_CHAIN.map((d) => d.deviceName).join(", ")}` +
      `) and press ⌘G / Ctrl-G to group them into an Audio Effect Rack.`,
  );
  return { insertedDevices, paramsSet, manual, grouped: false, rackDeviceName: RACK_DEVICE_NAME };
}
