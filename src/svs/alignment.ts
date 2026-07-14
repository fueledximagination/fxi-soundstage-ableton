/**
 * SVS alignment layer — turns MIDI notes + typed lyrics into an AlignedScore:
 * a per-note assignment of *which syllable sings on which note*. This is the
 * previewable, editable half of the melody-locked-vocal feature (the piano-roll
 * shows the syllable under each note; the user can fix a bad split). The Cog
 * (services/diffsinger-svs/predict.py) consumes this and does g2p + synthesis.
 *
 * Deliberately kept out of the model so alignment is deterministic + editable,
 * never a black box. Syllabification here is a good-enough heuristic; the user
 * can override by typing explicit hyphens ("mel-o-dy") or editing the preview.
 */

/** A note ready to synthesize: pitch + timing (beats) + its assigned syllable. */
export interface AlignedNote {
  pitch: number;      // MIDI note number
  startBeat: number;  // note start, in beats
  durBeat: number;    // note duration, in beats
  /** Syllable sung on this note. Empty when `slur` (melisma continuation). */
  syllable: string;
  /** true = this note extends the previous syllable's vowel (melisma), no new text. */
  slur: boolean;
  /** true = alignment was uncertain here (overflow/mismatch) — flag for the preview UI. */
  needsReview?: boolean;
}

export interface AlignedScore {
  tempo: number;          // BPM
  notes: AlignedNote[];
  /** Non-fatal alignment notes for the UI (e.g. "3 more syllables than notes"). */
  warnings: string[];
}

/** Minimal note shape the aligner needs (matches extract.ts PreviewNote). */
export interface ScoreNote {
  pitch: number;
  start: number; // beats
  dur: number;   // beats
}

const VOWELS = "aeiouy";

/** Split one word into syllables. Respects explicit hyphens; else heuristic. */
export function syllabify(word: string): string[] {
  const w = word.trim();
  if (!w) return [];
  // Honor user-authored hyphenation ("mel-o-dy") — the reliable path.
  if (w.includes("-")) return w.split("-").map((s) => s.trim()).filter(Boolean);

  const lower = w.toLowerCase();
  // Find vowel-group nuclei; each nucleus ~ one syllable.
  const nuclei: number[] = [];
  let inVowel = false;
  for (let i = 0; i < lower.length; i++) {
    const v = VOWELS.includes(lower[i]);
    if (v && !inVowel) nuclei.push(i);
    inVowel = v;
  }
  // Silent trailing "e" (e.g. "time") is not its own syllable.
  if (nuclei.length > 1 && lower.endsWith("e") && !VOWELS.includes(lower[lower.length - 2])) {
    nuclei.pop();
  }
  if (nuclei.length <= 1) return [w];

  // Cut boundary between two nuclei at the consonant before the later nucleus
  // (leaves at least one consonant to start the next syllable — a simple,
  // musically-forgiving rule; the preview lets the user fix edge cases).
  const cuts: number[] = [];
  for (let n = 0; n < nuclei.length - 1; n++) {
    const a = nuclei[n];
    const b = nuclei[n + 1];
    const cut = Math.max(a + 1, b - 1); // split just before the next nucleus's onset
    cuts.push(cut);
  }
  const parts: string[] = [];
  let prev = 0;
  for (const c of cuts) { parts.push(w.slice(prev, c)); prev = c; }
  parts.push(w.slice(prev));
  return parts.filter(Boolean);
}

/** Lyrics string -> ordered syllable stream. Strips [section] tags + punctuation. */
export function lyricsToSyllables(lyrics: string): string[] {
  const cleaned = lyrics
    .replace(/\[[^\]]*\]/g, " ")          // drop [Verse] [Chorus] tags
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")  // keep letters/digits/apostrophe/hyphen
    .trim();
  if (!cleaned) return [];
  const words = cleaned.split(/\s+/).filter(Boolean);
  return words.flatMap(syllabify);
}

/**
 * Assign a syllable stream to notes in order.
 *  - fewer syllables than notes  -> extra notes become slurs (melisma) on the
 *    last-sung syllable's vowel.
 *  - more syllables than notes    -> overflow syllables are packed onto the last
 *    note (joined) and flagged needsReview so the user can re-split.
 */
export function assignSyllablesToNotes(
  notes: ScoreNote[],
  syllables: string[],
): { notes: AlignedNote[]; warnings: string[] } {
  const warnings: string[] = [];
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  const out: AlignedNote[] = [];

  if (syllables.length === 0) {
    warnings.push("No lyrics — nothing to sing. Add lyrics or use an instrumental model.");
    return { notes: [], warnings };
  }

  let s = 0;
  for (let i = 0; i < sorted.length; i++) {
    const n = sorted[i];
    if (s < syllables.length) {
      out.push({ pitch: n.pitch, startBeat: n.start, durBeat: n.dur, syllable: syllables[s], slur: false });
      s++;
    } else {
      // Ran out of syllables -> melisma: hold the previous vowel across this note.
      out.push({ pitch: n.pitch, startBeat: n.start, durBeat: n.dur, syllable: "", slur: true });
    }
  }

  // Leftover syllables (more words than notes): cram onto the final note.
  if (s < syllables.length && out.length > 0) {
    const rest = syllables.slice(s);
    const last = out[out.length - 1];
    last.syllable = [last.syllable, ...rest].filter(Boolean).join(" ");
    last.needsReview = true;
    warnings.push(
      `${rest.length} more syllable(s) than notes — packed onto the last note. ` +
      `Add notes or edit the split for a cleaner result.`,
    );
  }
  if (out.some((n) => n.slur)) {
    const slurs = out.filter((n) => n.slur).length;
    warnings.push(`${slurs} note(s) with no syllable — sung as melisma (held vowel).`);
  }
  return { notes: out, warnings };
}

/** Full pipeline: notes + lyrics + tempo -> AlignedScore (ready for the Cog). */
export function buildAlignedScore(notes: ScoreNote[], lyrics: string, tempo = 120): AlignedScore {
  const syllables = lyricsToSyllables(lyrics);
  const { notes: aligned, warnings } = assignSyllablesToNotes(notes, syllables);
  return { tempo, notes: aligned, warnings };
}

/** Per-note labels for the piano-roll preview (syllable under each note). */
export function toPreviewLabels(score: AlignedScore): Array<{ startBeat: number; label: string; review: boolean }> {
  return score.notes.map((n) => ({
    startBeat: n.startBeat,
    label: n.slur ? "–" : (n.syllable || "?"),
    review: !!n.needsReview,
  }));
}
