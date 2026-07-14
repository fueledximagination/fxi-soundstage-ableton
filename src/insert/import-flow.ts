import * as ableton from "@ableton-extensions/sdk";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { Sample } from "../api/fxi-client.js";

type Ctx = ReturnType<typeof ableton.initialize>;
// Concrete, version-resolved AudioTrack instance type (AudioTrack is generic over
// the API version) — derived from the SDK so it tracks the targeted version.
type AudioTrackInstance = Awaited<ReturnType<Ctx["application"]["song"]["createAudioTrack"]>>;

// Download the durable Storage URL the gateway returned (never an expiring
// provider URL) to a temp file, hand it to Live via importIntoProject, then drop
// it onto the chosen target. Temp file is always cleaned up.

// Rotating clip-colour palette so each newly inserted take/stem is visually
// distinct from the previous render (operator QOL 2026-06-24 — a same-coloured
// clip read as "nothing inserted"). Values are Live RGB ints (0xRRGGBB),
// FXI gold first.
const TAKE_COLORS = [
  0xeecd2b, 0x3fd2d6, 0xf5663c, 0x9b6cf5, 0x5fd37a, 0xe85cc0, 0xf5a63c, 0x4c8df5,
];
let takeColorIdx = 0;
function nextTakeColor(): number {
  const c = TAKE_COLORS[takeColorIdx % TAKE_COLORS.length];
  takeColorIdx += 1;
  return c;
}

/** Set a clip's colour, best-effort — colour is cosmetic, never fail an insert. */
function colourClip(clip: { color?: number }, color: number): void {
  try {
    clip.color = color;
  } catch {
    /* colour unsupported on this Live build — ignore */
  }
}

async function downloadToTemp(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new Error("Couldn't reach the audio file — check your connection and try again.");
  }
  if (!res.ok) {
    // 5xx = storage/CDN hiccup on our side; 4xx = an expired/missing link. Give a
    // plain reason instead of a raw "download failed (500)".
    const reason =
      res.status >= 500
        ? `The audio service had a problem (error ${res.status}). Please try again in a moment.`
        : `That audio link is no longer available (error ${res.status}). Re-generate the take and try again.`;
    throw new Error(reason);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  // Preserve the source container so Live imports it correctly (WAV stems must
  // not be handed over with a .mp3 extension).
  const ext = /\.wav(\?|$)/i.test(url) ? "wav" : "mp3";
  const file = path.join(os.tmpdir(), `fxi-${randomBytes(6).toString("hex")}.${ext}`);
  await fs.writeFile(file, buf);
  return file;
}

/** Download `url`, import into the project, drop it onto `track` at `startTime`. */
async function dropUrlOntoTrack(
  ctx: Ctx,
  track: AudioTrackInstance,
  url: string,
  startTime: number,
  durationSec: number | null,
): Promise<void> {
  const local = await downloadToTemp(url);
  try {
    const imported = await ctx.resources.importIntoProject(local);
    const opts: { filePath: string; startTime: number; isWarped: boolean; duration?: number } = {
      filePath: imported,
      startTime,
      isWarped: true,
    };
    if (typeof durationSec === "number") opts.duration = durationSec;
    const clip = await track.createAudioClip(opts);
    colourClip(clip, nextTakeColor());
  } finally {
    await fs.rm(local, { force: true });
  }
}

export interface StemUrls {
  wavUrl?: string | null;
  instrumentalUrl?: string | null;
  vocalUrl?: string | null;
}

/**
 * Create a fresh, labelled audio track in the Live set for each available stem
 * (WAV master, instrumental, vocal) and place the clip at `startTime`. New tracks
 * keep the stems out of the way of the chosen take — the producer mixes from here.
 * Returns the count of stems placed.
 */
export async function placeStemsAsTracks(
  ctx: Ctx,
  baseTitle: string,
  stems: StemUrls,
  startTime = 0,
  durationSec: number | null = null,
): Promise<number> {
  const planned: Array<{ url: string; name: string }> = [];
  if (stems.wavUrl) planned.push({ url: stems.wavUrl, name: `${baseTitle} · WAV` });
  if (stems.instrumentalUrl) planned.push({ url: stems.instrumentalUrl, name: `${baseTitle} · Instrumental` });
  if (stems.vocalUrl) planned.push({ url: stems.vocalUrl, name: `${baseTitle} · Vocals` });
  if (planned.length === 0) return 0;

  // Sequential: createAudioTrack inserts after the last selected track, so order
  // is deterministic, and one import at a time keeps the host responsive.
  for (const stem of planned) {
    const track = await ctx.application.song.createAudioTrack();
    track.name = stem.name;
    await dropUrlOntoTrack(ctx, track, stem.url, startTime, durationSec);
  }
  return planned.length;
}

/**
 * Where the chosen take lands in the arrangement:
 *   - "new"     → a fresh audio track (DEFAULT, non-destructive — never clobbers
 *                 existing audio on the right-clicked track).
 *   - "replace" → delete the source/reference clip(s) on the target track, then
 *                 drop the new clip where they started.
 *   - "beside"  → keep the existing audio, drop the new clip after the last clip
 *                 ends (no overlap) on the same track.
 */
export type Placement = "new" | "replace" | "beside";

export async function insertIntoArrangement(
  ctx: Ctx,
  handle: ableton.Handle,
  sample: Sample,
  opts: { placement?: Placement } = {},
): Promise<void> {
  if (!sample.audioUrl) throw new Error("sample has no audio yet");
  const placement: Placement = opts.placement ?? "new";
  const targetTrack = ctx.getObjectFromHandle(handle, ableton.AudioTrack);

  // Resolve the destination track + start position from the placement mode. The
  // default ("new") guarantees we never destroy the operator's existing audio.
  let track: AudioTrackInstance = targetTrack;
  let startTime = 0;

  if (placement === "new") {
    track = await ctx.application.song.createAudioTrack();
    track.name = sample.title ? `FXI · ${sample.title}` : "FXI take";
  } else if (placement === "replace") {
    const clips = targetTrack.arrangementClips;
    if (clips.length > 0) {
      startTime = Math.min(...clips.map((c) => c.startTime));
      // Delete the reference/source clip(s) so the new take takes their place.
      for (const clip of clips) {
        try {
          await targetTrack.deleteClip(clip);
        } catch {
          /* clip already gone / undeletable — best-effort, keep going */
        }
      }
    }
  } else {
    // "beside" — never overlap: start after the furthest-out existing clip end.
    const clips = targetTrack.arrangementClips;
    startTime = clips.length ? Math.max(...clips.map((c) => c.endTime)) : 0;
  }

  const durationSec = typeof sample.durationSec === "number" ? sample.durationSec : null;
  await dropUrlOntoTrack(ctx, track, sample.audioUrl, startTime, durationSec);
}

export async function insertIntoClipSlot(
  ctx: Ctx,
  handle: ableton.Handle,
  sample: Sample,
): Promise<void> {
  if (!sample.audioUrl) throw new Error("sample has no audio yet");
  const slot = ctx.getObjectFromHandle(handle, ableton.ClipSlot);
  const local = await downloadToTemp(sample.audioUrl);
  try {
    const imported = await ctx.resources.importIntoProject(local);
    const clip = await slot.createAudioClip({
      filePath: imported,
      isWarped: true,
      loopSettings: { looping: false, startMarker: 1, endMarker: 5, loopStart: 1, loopEnd: 5 },
    });
    colourClip(clip, nextTakeColor());
  } finally {
    await fs.rm(local, { force: true });
  }
}
