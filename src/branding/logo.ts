// FXI SoundStage terminal branding.
//
// ── ASCII art vs ANSI: the two distinct things happening here ──────────────────
// • ASCII / Unicode ART = the SHAPES. The "FXI" wordmark and the equalizer bars
//   are drawn out of text glyphs (█ ╗ ╚ ▂ ▅ ▇ …). Strip every color code and the
//   art is still there — it's literally characters arranged to look like a logo.
// • ANSI = the COLOR + MOTION. ANSI escape codes (e.g. "\x1b[38;2;R;G;Bm") tell
//   the terminal to paint those glyphs gold/bronze, and cursor codes
//   ("\x1b[1A", "\x1b[2K", "\x1b[?25l") move/clear lines to animate. ANSI is
//   invisible plumbing — it carries no shape, only style and cursor commands.
// So: the drawing is ASCII art; the bronze-gold gradient and the bar animation
// are ANSI. Non-TTY streams (log files, piped output) get the ASCII art with the
// ANSI stripped — readable, just monochrome.

// ── ANSI helpers ──────────────────────────────────────────────────────────────
type RGB = [number, number, number];

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CURSOR_UP = "\x1b[1A";
const CLEAR_LINE = "\x1b[2K";

/** Warm bronze → FXI gold. Deliberately starts deep/warm, ends bright. */
const BRONZE: RGB = [120, 72, 28];
const GOLD: RGB = [238, 205, 43]; // FXI Gold #eecd2b
const CYAN: RGB = [63, 210, 214]; // cool accent — FXI outline (bright end)
const CYAN_DEEP: RGB = [20, 110, 124]; // FXI outline gradient (deep end)

const lerp = (a: number, b: number, t: number): number => Math.round(a + (b - a) * t);
/** 24-bit truecolor foreground escape. */
const fg = ([r, g, b]: RGB): string => `\x1b[38;2;${r};${g};${b}m`;
const mix = (from: RGB, to: RGB, t: number): RGB => [
  lerp(from[0], to[0], t),
  lerp(from[1], to[1], t),
  lerp(from[2], to[2], t),
];

/**
 * Color each non-space glyph of `text` along a `from`→`to` gradient. Spaces are
 * left uncolored so word spacing stays clean. Returns the string with a trailing
 * RESET. (Truecolor; on terminals without 24-bit support the codes degrade
 * gracefully to the nearest color.)
 */
export function gradient(text: string, from: RGB = BRONZE, to: RGB = GOLD): string {
  const chars = [...text];
  const colorable = chars.filter((c) => c.trim().length > 0).length;
  const span = Math.max(1, colorable - 1);
  let i = 0;
  let out = "";
  for (const ch of chars) {
    if (ch.trim().length === 0) {
      out += ch;
      continue;
    }
    out += fg(mix(from, to, i / span)) + ch;
    i += 1;
  }
  return out + RESET;
}

// ── ASCII art ─────────────────────────────────────────────────────────────────
// FXI wordmark in the brand display face — AKIRA Super Bold, faux-italicized
// (~0.30 forward shear) and rasterized to solid blocks from the real .ttf
// (Akira Super Bold.ttf → PIL render → threshold). F, X, and I all lean right,
// matching the FXI logo. Regenerate via scripts/render-logo (Akira font + PIL).
const FXI_BLOCK = String.raw`     █████████████████████ ████████       █████████ ██████
    █████████████████████    ████████   ████████    ██████
    ████████████████████      ███████████████      ███████
   ██████████████████           ██████████        ███████
  ███████████████████          ███████████        ██████
  ███████████████████       ███████████████      ███████
 ███████                 █████████   ████████   ███████
███████                ████████       ████████  ███████`;

const SOUNDSTAGE = "               S  O  U  N  D  S  T  A  G  E";

// Thematic art: a frozen equalizer spectrum — the "soundstage" reading levels.
const EQ_BARS = "▄▅▇▇▇▇▆▄▃▂▁▁▁▂▃▅▆▇▇▇▆▅▄▂▁▁▁▁▃▄▆▇▇▇▇▆▄▃▁▁▁▁▂▃▅▆▇▇▇▆▅▃▂▁";

/** Plain (no ANSI) version for non-TTY streams: ASCII art, monochrome. */
const FXI_PLAIN = `${FXI_BLOCK}\n${SOUNDSTAGE}\n   ${EQ_BARS}`;

// FXI logomark — a compact symbol (distinct from the wordmark above): an italic
// F fused with a forward play-blade ("press play on the unseen"). Designed to
// survive ASCII: block-rasterized from the same vector as docs/decks/assets/
// fxi-mark.svg. Use where a small emblem fits better than the full wordmark.
export const FXI_MARK = String.raw`   █████████████
   ███████████
  █████        ██
  █████        ████
  █████████   ████████
 ██████       ████████
 █████        ████
█████        ██`;

/** The logomark in brand gold (TTY) or plain blocks (non-TTY). */
export function markGold(): string {
  const tty = Boolean(process.stdout && process.stdout.isTTY);
  return tty ? `${fg(GOLD)}${FXI_MARK}${RESET}` : FXI_MARK;
}

// ── Banner ────────────────────────────────────────────────────────────────────
/**
 * Print the FXI SoundStage banner. On a TTY: gold FXI wordmark, bronze→gold
 * gradient "SOUNDSTAGE", gradient EQ bars. Off a TTY (log files / piped output):
 * the same ASCII art with ANSI stripped.
 */
export function printBanner(version: string, tagline = "Generate music in Ableton Live"): void {
  const tty = Boolean(process.stdout && process.stdout.isTTY);
  // ONE banner design everywhere: plain gold FXI + a (static) cyan cube, with
  // bronze→gold SOUNDSTAGE + EQ below — the static twin of animateBanner. Used
  // by activate() (Live host log, non-TTY → plain) and as animateBanner's
  // non-TTY fallback, so the extension never shows two conflicting layouts.
  const SOUND = "S  O  U  N  D  S  T  A  G  E";
  const REF = SOUND.length;
  // FXI centered above the word; EQ spans the word width.
  const ind = " ".repeat(Math.max(0, Math.floor((REF - FXI_FW) / 2)));
  const lines: string[] = [];
  if (tty) {
    for (const r of fxiLines(-1)) lines.push(ind + r);
    lines.push("");
    lines.push(gradient(SOUND));
    lines.push(eqBar(1, 18, REF, 0, 1) + RESET); // settled standing wave (static)
    lines.push(`${DIM}v${version} — ${tagline}${RESET}`);
  } else {
    for (const r of FXI_STD) lines.push(ind + r);
    lines.push("");
    lines.push(SOUND);
    lines.push(EQ_BARS.slice(0, REF));
    lines.push(`v${version} — ${tagline}`);
  }
  // eslint-disable-next-line no-console
  console.log(lines.join("\n") + "\n");
}

/**
 * Thematic ANSI ANIMATION: a single live equalizer row that dances bronze→gold
 * for `durationMs`, then settles. TTY-only and fully self-contained (hides the
 * cursor, redraws ONE line via cursor-up + clear-line, restores the cursor). No
 * output at all on non-TTY streams, so it never pollutes log files or the
 * Extension Host protocol. Call it from a dev terminal (build/start), NOT from
 * inside activate() — the Live host stdout is not yours to animate.
 */
export async function animateEqualizer(durationMs = 1600, fps = 14, cols = 28): Promise<void> {
  const out = process.stdout;
  if (!(out && out.isTTY)) return;

  const levels = "▁▂▃▄▅▆▇█";
  const frameCount = Math.max(1, Math.round((durationMs / 1000) * fps));
  const interval = 1000 / fps;

  out.write(HIDE_CURSOR);
  for (let f = 0; f < frameCount; f += 1) {
    let bar = "";
    for (let c = 0; c < cols; c += 1) {
      const h = Math.floor(Math.random() * levels.length);
      bar += fg(mix(BRONZE, GOLD, c / (cols - 1))) + levels[h];
    }
    if (f > 0) out.write(CURSOR_UP);
    out.write(`\r${CLEAR_LINE}   ${bar}${RESET}\n`);
    await new Promise((r) => setTimeout(r, interval));
  }
  out.write(SHOW_CURSOR);
}

// ── Animated banner: FXI lettermark + gradient SOUNDSTAGE + EQ ────────────────
// ANSI-shadow FXI: █ body gets the gold gradient + shimmer; the box-drawing edge
// (╔╗╚╝═║) gets a cyan gradient outline.
const FXI_STD = [
  " ███████╗ ██╗  ██╗ ██╗",
  " ██╔════╝ ╚██╗██╔╝ ██║",
  " █████╗    ╚███╔╝  ██║",
  " ██╔══╝    ██╔██╗  ██║",
  " ██║      ██╔╝ ██╗ ██║",
  " ╚═╝      ╚═╝  ╚═╝ ╚═╝",
];

const SHIMMER: RGB = [255, 246, 200];
const FXI_FW = Math.max(...FXI_STD.map((l) => l.length));
const EQ_LEVELS = "▁▂▃▄▅▆▇█";

// FXI lettermark with a left→right bronze→gold gradient and a bright shimmer
// band sweeping across it (the "ASCII MOTION" shimmer-over-gradient look).
// `phase` 0..1 is the shimmer's horizontal position; pass a negative phase for a
// static gradient with no shimmer. Each row is padded to FXI_FW so callers can
// treat the visible width as constant.
function fxiLines(phase: number): string[] {
  const W = FXI_FW;
  const H = FXI_STD.length;
  const sweep = phase * (W + 12) - 6;
  return FXI_STD.map((raw, y) => {
    const line = raw.padEnd(W);
    const vt = y / Math.max(1, H - 1); // VERTICAL gradient: top → bottom
    let out = "";
    for (let x = 0; x < W; x += 1) {
      const ch = line[x];
      if (ch === " ") { out += " "; continue; }
      if (ch === "█") {
        // Body: vertical bronze→gold gradient + a horizontal shimmer band.
        let col = mix(BRONZE, GOLD, vt);
        if (phase >= 0) {
          const d = Math.abs(x - sweep);
          if (d < 3.5) col = mix(col, SHIMMER, (1 - d / 3.5) * 0.9);
        }
        out += fg(col) + ch;
      } else {
        // Box-drawing edge → vertical cyan gradient outline (deep → bright).
        out += fg(mix(CYAN_DEEP, CYAN, vt)) + ch;
      }
    }
    return out + RESET;
  });
}

// EQ spectrum row — three phases across the banner's run:
//   1. RANDOM (first `randomFrames`): chaotic levels — power-on noise.
//   2. WAVE   (next `waveFrames`): a traveling sine whose travel EASES OUT, so it
//      organizes out of the noise and decelerates toward a stop.
//   3. SETTLE (remaining frames): travel is frozen → the wave stands still and the
//      row ends on a static waveform (the "wav"). The ease-out makes 2→3 seamless.
// Returns the colored bars WITHOUT a trailing reset (caller adds it).
function eqBar(
  frame: number,
  fps: number,
  width: number,
  randomFrames: number,
  waveFrames: number,
): string {
  const TOTAL_TRAVEL = Math.PI * 6; // a few cycles of travel before the freeze
  let bar = "";
  for (let c = 0; c < width; c += 1) {
    let h: number;
    if (frame < randomFrames) {
      h = Math.floor(Math.random() * EQ_LEVELS.length);
    } else {
      // p: 0 at the start of the wave phase → 1 at the freeze, then clamped (settle).
      const p = Math.min(1, (frame - randomFrames) / Math.max(1, waveFrames));
      // Ease-out travel (fast → slow → stop). At p=1 travel is constant ⇒ standing wave.
      const travel = (1 - (1 - p) * (1 - p)) * TOTAL_TRAVEL;
      const phase = (c / width) * Math.PI * 3 - travel;
      h = Math.round((Math.sin(phase) * 0.5 + 0.5) * (EQ_LEVELS.length - 1));
    }
    bar += fg(mix(BRONZE, GOLD, c / (width - 1))) + EQ_LEVELS[h];
  }
  return bar;
}

// ── 3D logomark (STL-to-ASCII) ────────────────────────────────────────────────
// The FXI mark rendered as a shaded 3D object (à la STL-to-ASCII): glyph DENSITY
// encodes depth/lighting — the source generator picks a heavier glyph for a
// brighter/closer face. We map that ramp to bronze→gold so the lit faces read
// bright gold and the shadowed faces deep bronze, reproducing the 3D form in
// brand color. The hero of the animated banner on a wide terminal.
const FXI_3D = [
  "          +++++++++++++++++++++++=*+          **%%%%%%%*",
  "         +++++++++++++++++++++++++++-      ---------------.",
  "       .--++++++++++++++++++++++-----: ----------+-------:",
  "      .-------               :----------------  :-------:",
  "     .------------+++++++++   .------------    :-------:",
  "    :---------------------   *-----------     *-------:",
  "   ---------------------- *---------------.  *--------",
  "  --------             +--------: ---------:+--------",
  " --------           ---------.     -----------------",
  "........        .---------.         ---------------",
];
const ART_W = Math.max(...FXI_3D.map((l) => l.length));

// Glyph → ink weight (light → heavy). Drives the bronze→gold tone so the shaded
// faces (-, +, =, *, %) land as distinct gold tones — the 3D read.
const DENSITY: Record<string, number> = {
  ".": 0.0, ":": 0.12, "-": 0.22, "+": 0.4, "=": 0.62, "*": 0.85, "%": 0.95, "#": 1.0,
};
// Shade the 3D mark: density → bronze→gold (warm floor + faint top→bottom lift),
// plus a bright shimmer band sweeping horizontally across it. `phase` 0..1 is the
// sweep position; a negative phase gives a static, shimmer-free render. The warm
// floor (0.22) keeps even the sparse `-` faces visible on #050505. Rows padded to
// ART_W so callers can treat the visible width as constant.
function fxi3dLines(phase: number): string[] {
  const W = ART_W;
  const H = FXI_3D.length;
  const sweep = phase * (W + 16) - 8;
  return FXI_3D.map((raw, y) => {
    const line = raw.padEnd(W);
    const vt = y / Math.max(1, H - 1);
    let out = "";
    for (let x = 0; x < W; x += 1) {
      const ch = line[x];
      if (ch === " ") { out += " "; continue; }
      const d = DENSITY[ch] ?? 0.5;
      let col = mix(BRONZE, GOLD, Math.min(1, 0.22 + d * 0.66 + vt * 0.12));
      if (phase >= 0) {
        const dist = Math.abs(x - sweep);
        if (dist < 4) col = mix(col, SHIMMER, (1 - dist / 4) * 0.85);
      }
      out += fg(col) + ch;
    }
    return out + RESET;
  });
}

/**
 * Full animated banner (TTY only): on a wide terminal, the 3D FXI logomark with a
 * shimmer sweep + bronze→gold density shading and breathing room; on a narrow
 * terminal, the compact FXI lettermark. Both sit above bronze→gold "SOUNDSTAGE"
 * and a live EQ spectrum that starts as noise, organizes into a decelerating
 * wave, and settles on a static waveform — inside a demoscene-style titled frame.
 * Redraws the whole block per frame via cursor-up. Falls back to static
 * printBanner on non-TTY streams.
 */
export async function animateBanner(durationMs = 5200, fps = 18, version = "1.0.0"): Promise<void> {
  const out = process.stdout;
  if (!(out && out.isTTY)) { printBanner(version); return; }

  const SOUND = "S  O  U  N  D  S  T  A  G  E"; // the word — the layout anchor
  const REF = SOUND.length;

  // Wide terminal → 3D hero logomark with vertical breathing room. Narrow →
  // compact lettermark (keeps the animation usable below the 3D art's width).
  const wide = (out.columns ?? 80) >= ART_W + 8;
  const heroW = wide ? ART_W : FXI_FW;
  const heroH = wide ? FXI_3D.length : FXI_STD.length;
  const padRows = wide ? 1 : 0; // blank rows above + below the mark
  const innerW = (wide ? ART_W : REF) + 6;
  const EQ_W = wide ? ART_W : REF; // wide: full FXI-mark width; narrow: word width
  const randomFrames = Math.round(fps * 1.2); // power-on noise first (~1.2s)
  const waveFrames = Math.round(fps * 2.0); // then organize into a decelerating wave → freeze

  const dim = fg([122, 96, 36]);
  const title = " FXI · SOUNDSTAGE ";
  const credit = ` v${version} · FUELED BY IMAGINATION `;
  const top = `${dim}╔${fg(GOLD)}${title}${dim}${"═".repeat(Math.max(0, innerW - title.length))}╗${RESET}`;
  const bottom = `${dim}╚${"═".repeat(Math.max(0, innerW - credit.length))}${fg([150, 124, 60])}${credit}${dim}╝${RESET}`;
  // Center an element of visible width `w` within the frame.
  const crow = (colored: string, w: number): string => {
    const pad = Math.max(0, Math.floor((innerW - w) / 2));
    return `${dim}║${RESET}${" ".repeat(pad)}${colored}${" ".repeat(Math.max(0, innerW - pad - w))}${dim}║${RESET}`;
  };

  // top + padRows + hero + blank + SOUND + EQ + padRows + bottom
  const totalLines = 1 + padRows + heroH + 1 + 1 + 1 + padRows + 1;
  const frameCount = Math.max(1, Math.round((durationMs / 1000) * fps));
  const interval = 1000 / fps;

  out.write(HIDE_CURSOR);
  for (let f = 0; f < frameCount; f += 1) {
    const phase = ((f / fps) * 0.42) % 1; // shimmer sweeps ~every 2.4s
    const heroRows = wide ? fxi3dLines(phase) : fxiLines(phase);
    const lines: string[] = [top];
    for (let p = 0; p < padRows; p += 1) lines.push(crow("", 0));
    for (const r of heroRows) lines.push(crow(r, heroW));
    lines.push(crow("", 0));
    lines.push(crow(gradient(SOUND), REF));
    lines.push(crow(eqBar(f, fps, EQ_W, randomFrames, waveFrames) + RESET, EQ_W));
    for (let p = 0; p < padRows; p += 1) lines.push(crow("", 0));
    lines.push(bottom);

    if (f > 0) out.write(`\x1b[${totalLines}A`);
    for (const ln of lines) out.write(`\r${CLEAR_LINE}${ln}\n`);
    await new Promise((r) => setTimeout(r, interval));
  }
  out.write(SHOW_CURSOR);
}
