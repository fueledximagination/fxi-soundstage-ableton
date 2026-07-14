import * as ableton from "@ableton-extensions/sdk";
import type { RenderNote } from "./render-wav.js";

type Ctx = ReturnType<typeof ableton.initialize>;

// MidiClip.notes are NoteDescription { pitch, startTime, duration, velocity? }
// with time in BEATS. We render at a fixed reference tempo — for melody
// conditioning the model extracts pitch contour, so absolute tempo is not
// critical; 120 BPM keeps a played sequence near its musical length.
const DEFAULT_BPM = 120;

export interface PreviewNote {
  pitch: number;
  start: number; // beats (for the piano-roll x-axis)
  dur: number; // beats
}

export interface ExtractedMelody {
  renderNotes: RenderNote[];
  preview: PreviewNote[]; // capped for the UI piano-roll
  noteCount: number;
  durationSec: number;
  durationBeats: number;
}

const MAX_PREVIEW_NOTES = 256;

export function extractMelodyFromHandle(ctx: Ctx, handle: ableton.Handle, bpm = DEFAULT_BPM): ExtractedMelody {
  const clip = ctx.getObjectFromHandle(handle, ableton.MidiClip);
  const notes = clip.notes ?? [];
  const secPerBeat = 60 / bpm;

  const sorted = [...notes]
    .filter((n) => !n.muted)
    .sort((a, b) => a.startTime - b.startTime);

  const renderNotes: RenderNote[] = sorted.map((n) => ({
    pitch: n.pitch,
    start: n.startTime * secPerBeat,
    dur: Math.max(0.05, n.duration * secPerBeat),
    velocity: typeof n.velocity === "number" ? n.velocity : 100,
  }));

  const durationBeats = sorted.reduce((m, n) => Math.max(m, n.startTime + n.duration), 0);

  const preview: PreviewNote[] = sorted
    .slice(0, MAX_PREVIEW_NOTES)
    .map((n) => ({ pitch: n.pitch, start: n.startTime, dur: n.duration }));

  return {
    renderNotes,
    preview,
    noteCount: sorted.length,
    durationSec: durationBeats * secPerBeat,
    durationBeats,
  };
}
