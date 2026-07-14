// Pure unit tests for the SVS alignment layer (no SDK, no I/O).
// Run with:  npx tsx src/svs/alignment.test.mjs
import { syllabify, lyricsToSyllables, assignSyllablesToNotes, buildAlignedScore } from "./alignment.ts";

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) passed++; else { failed++; console.error(`  FAIL: ${msg}`); } }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), `${msg} — got ${JSON.stringify(a)}`); }

// syllabify: hyphens honored
eq(syllabify("mel-o-dy"), ["mel", "o", "dy"], "explicit hyphens split as authored");
// syllabify: single-syllable words stay whole
eq(syllabify("hear"), ["hear"], "monosyllable unchanged");
eq(syllabify("my"), ["my"], "monosyllable 'my' unchanged");
// syllabify: multi-syllable heuristic yields >1 part
ok(syllabify("hello").length === 2, "'hello' -> 2 syllables");

// lyricsToSyllables: strips [tags] + punctuation
eq(lyricsToSyllables("[Verse] I can hear my mel-o-dy now!"),
   ["I", "can", "hear", "my", "mel", "o", "dy", "now"],
   "8-note proof lyric -> 8 syllables, tags/punct stripped");

// 8 notes + 8 syllables -> clean 1:1, no slurs, no review
const notes8 = Array.from({ length: 8 }, (_, i) => ({ pitch: 60 + i, start: i, dur: 1 }));
const s8 = buildAlignedScore(notes8, "I can hear my mel-o-dy now", 120);
ok(s8.notes.length === 8, "8 aligned notes");
ok(s8.notes.every((n) => !n.slur), "no slurs when counts match");
ok(s8.notes[4].syllable === "mel" && s8.notes[6].syllable === "dy", "syllables land in order");
ok(s8.warnings.length === 0, "no warnings on a clean 1:1 match");

// more notes than syllables -> trailing slurs (melisma)
const align = assignSyllablesToNotes(
  [{ pitch: 60, start: 0, dur: 1 }, { pitch: 62, start: 1, dur: 1 }, { pitch: 64, start: 2, dur: 1 }],
  ["la"],
);
ok(align.notes[0].slur === false && align.notes[1].slur && align.notes[2].slur, "extra notes become slurs");

// more syllables than notes -> overflow packed onto last note + review flag
const align2 = assignSyllablesToNotes(
  [{ pitch: 60, start: 0, dur: 1 }],
  ["one", "two", "three"],
);
ok(align2.notes[0].needsReview === true, "overflow flags needsReview");
ok(align2.warnings.some((w) => w.includes("more syllable")), "overflow warns");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
