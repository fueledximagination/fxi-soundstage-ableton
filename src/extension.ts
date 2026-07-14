import "./runtime-globals.js"; // MUST be first: polyfills URL et al. the host omits
import * as ableton from "@ableton-extensions/sdk";
import composeHtml from "./ui/compose.html";
import browserHtml from "./ui/browser.html";
import mixMasterHtml from "./ui/mix-master.html";
import vocalEnhanceHtml from "./ui/vocal-enhance.html";
import { initSession, isSignedIn, setActiveSession, NotSignedInError } from "./auth/session-manager.js";
import { signIn } from "./auth/sign-in.js";
import * as fxi from "./api/fxi-client.js";
import { insertIntoArrangement, insertIntoClipSlot, placeStemsAsTracks } from "./insert/import-flow.js";
import type { Placement } from "./insert/import-flow.js";
import { applyMixProfile } from "./mix/apply.js";
import { applyVocalMaxRack, type VocalMaxResult } from "./mix/vocal-max.js";
import { MIX_TEMPLATE_OPTIONS } from "./mix/profile.js";
import { extractMelodyFromHandle, type PreviewNote } from "./midi/extract.js";
import { renderNotesToWav } from "./midi/render-wav.js";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

type Ctx = ReturnType<typeof ableton.initialize>;

/**
 * Read the Live set's current tempo (BPM) so a generation matches the
 * Ableton session. Best-effort: any SDK/host hiccup returns undefined and
 * generation proceeds at the model's default tempo rather than failing.
 */
function readProjectTempo(ctx: Ctx): number | undefined {
  try {
    const t = ctx.application.song.tempo;
    if (Number.isFinite(t) && t >= 20 && t <= 300) return Math.round(t);
  } catch {
    /* tempo read is best-effort */
  }
  return undefined;
}
type Destination = "arrangement" | "slot";

const CREDITS_PER_SAMPLE = 10;
const MELODY_MAX_SECONDS = 30; // melody models use ~first 30s; bounds upload size.

interface CapturedMelody {
  url: string;
  preview: PreviewNote[];
  noteCount: number;
  durationSec: number;
}
let capturedMelody: CapturedMelody | null = null;

interface ComposePayload {
  cancelled?: boolean;
  lyrics: string;
  models: string[];
  variants: number;
  instrumental: boolean;
  /** Deliver only the isolated vocal (vocals-only / a cappella). Mutually
      exclusive with `instrumental`. */
  acapella?: boolean;
  /** "Browse my library" — open the saved-take browser instead of generating. */
  library?: boolean;
}
interface BrowserPayload {
  cancelled?: boolean;
  trackId?: string;
  /** "Generate again" — regenerate fresh takes with the same settings. */
  retry?: boolean;
  /** "← Change lyrics" — return to the compose screen, prior inputs restored. */
  back?: boolean;
  /** Per-stem extraction selection — each placed on its own labelled track. */
  stems?: { wav?: boolean; instrumental?: boolean; vocal?: boolean };
  /** "Extract selected → Live" — derive the checked stems only (no main take). */
  extractOnly?: boolean;
  /** Where the MAIN take lands via "Add to Live" (default: fresh track). */
  placement?: Placement;
}
/** Prior compose inputs, re-injected so "← Change lyrics" restores the form. */
interface ComposePrefill {
  lyrics: string;
  models: string[];
  variants: number;
  instrumental: boolean;
  acapella: boolean;
}
interface MixMasterPayload {
  cancelled?: boolean;
  mode?: "template" | "reference";
  templateKey?: string;
  referenceUrl?: string;
  target?: fxi.MixTarget;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Signature FXI dot-matrix — animated in the progress dialogs so a long
// generation reads as alive, not hung. Rotated one cell per tick.
const FXI_WAVE = "▄▅▇▇▇▇▆▄▃▂▁▁▁▂▃▅▆▇▇▇▆▅▄▂▁▁▁▁";
function fxiWave(tick: number): string {
  const off = ((tick % FXI_WAVE.length) + FXI_WAVE.length) % FXI_WAVE.length;
  return FXI_WAVE.slice(off) + FXI_WAVE.slice(0, off);
}
/**
 * Overlay a label in the CENTER of the animated wave so the word is never cut
 * off at the dialog edge (the wave is fixed-width; appending the label pushed
 * it past the right edge — operator screenshot 2026-06-24).
 */
function fxiWaveLabel(tick: number, label: string): string {
  const wave = fxiWave(tick);
  const tag = ` ${label} `;
  if (tag.length >= wave.length) return label;
  const side = Math.floor((wave.length - tag.length) / 2);
  // Mirror the wave on BOTH sides of the label so the decorated string is
  // exactly symmetric — the label then sits dead-center in the dialog row
  // instead of drifting left (operator: center the "Composing" animation).
  const left = wave.slice(0, side);
  const right = left.split("").reverse().join("");
  return left + tag + right;
}
const dataUrl = (html: string): string => `data:text/html,${encodeURIComponent(html)}`;
const inject = (html: string, marker: string, value: unknown): string =>
  html.replace(marker, JSON.stringify(value));

/**
 * Show the take/sample browser. `mode` toggles the screen between the
 * post-generation take picker ("takes" — stems + "Generate again") and the
 * saved-sample library ("library" — pick-only). Returns the raw JSON string the
 * webview posts back.
 */
function showBrowser(ctx: Ctx, samples: fxi.Sample[], mode: "takes" | "library"): Promise<string> {
  let html = inject(browserHtml, "__SAMPLES_JSON__", samples);
  html = inject(html, "__BROWSER_MODE_JSON__", mode);
  // Taller dialog: the take list scrolls inside a fixed-height region while the
  // player, extract options, placement selector and footer all stay visible
  // without clipping (operator: browser was vertically cramped).
  return ctx.ui.showModalDialog(dataUrl(html), 480, 820);
}

// Surface a failure to the operator instead of swallowing it in console.error.
// Without this, a failed dispatch / empty result just made the UI vanish with no
// explanation (operator QA, 2026-06-21). On-brand glass card, single Close.
async function notify(ctx: Ctx, title: string, message: string): Promise<void> {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html =
    `<!doctype html><html><head><meta charset="UTF-8"/><style>` +
    `*{box-sizing:border-box;margin:0}body{background:#050505;color:#fff;` +
    `font-family:Inter,system-ui,sans-serif;font-size:13px;padding:20px;display:flex;` +
    `flex-direction:column;gap:12px;height:100%}` +
    `h1{font-size:15px;color:#eecd2b}p{color:rgba(235,235,245,0.78);line-height:1.5}` +
    `button{margin-top:auto;padding:11px;border-radius:10px;border:none;background:#eecd2b;` +
    `color:#1a1300;font:inherit;font-weight:600;cursor:pointer}</style></head><body>` +
    `<h1>${esc(title)}</h1><p>${esc(message)}</p>` +
    `<button onclick="(window.webkit&&window.webkit.messageHandlers.live?` +
    `window.webkit.messageHandlers.live:window.chrome.webview)` +
    `.postMessage({method:'close_and_send',params:['ok']})">Close</button>` +
    `</body></html>`;
  try { await ctx.ui.showModalDialog(dataUrl(html), 420, 240); } catch { /* dismissed */ }
}

/**
 * Human message for a thrown error. GatewayError is mapped by HTTP status
 * (5xx / timeout / network → reassuring "our end, not charged" copy) via
 * describeGatewayError; anything else falls back to its own message or `fallback`.
 */
function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof fxi.GatewayError) return fxi.describeGatewayError(err);
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

/**
 * Resolve the enclosing AudioTrack handle for any right-clicked object. Lets the
 * arrangement-insert flows (Generate / Browse library / Match mix) work when the
 * operator right-clicks a pre-existing AUDIO CLIP — not just the track header —
 * which is the `AudioClip` context scope. Returns the track's own handle when
 * given a track, walks up the parent chain for a clip, or null if none is found.
 */
function enclosingAudioTrackHandle(ctx: Ctx, handle: ableton.Handle): ableton.Handle | null {
  try {
    const obj = ctx.getObjectFromHandle(handle, ableton.DataModelObject);
    if (obj instanceof ableton.AudioTrack) return obj.handle;
    let cur = obj.parent;
    for (let i = 0; i < 8 && cur; i++) {
      if (cur instanceof ableton.AudioTrack) return cur.handle;
      cur = cur.parent;
    }
  } catch {
    /* handle no longer resolvable — treat as not found */
  }
  return null;
}

// Read the OS clipboard from the host process. The webview can't (data: URL is
// an opaque origin → navigator.clipboard.readText() is blocked), so we pre-read
// here at dialog-open and inject it as the dialog's Paste source. Best-effort —
// resolves "" on any failure.
function readClipboard(): Promise<string> {
  return new Promise((resolve) => {
    let cmd: string;
    let args: string[];
    if (process.platform === "darwin") { cmd = "pbpaste"; args = []; }
    else if (process.platform === "win32") { cmd = "powershell"; args = ["-noprofile", "-command", "Get-Clipboard"]; }
    else { cmd = "xclip"; args = ["-selection", "clipboard", "-o"]; }
    try {
      const p = spawn(cmd, args);
      let out = "";
      p.stdout.on("data", (d) => { out += d.toString(); });
      p.on("close", () => resolve(out.replace(/\r\n/g, "\n")));
      p.on("error", () => resolve(""));
    } catch {
      resolve("");
    }
  });
}

export function activate(activation: ableton.ActivationContext): void {
  // No banner here — the build terminal (build.ts → animateBanner) is the single
  // banner surface. Printing it again from activate() double-rendered it in the
  // dev terminal and only ever landed in the Live host LOG (not user-facing UI).
  const ctx = ableton.initialize(activation, "1.0.0");

  ctx.commands.registerCommand("fxi.melody.capture", (arg: unknown) =>
    captureMelody(ctx, arg as ableton.Handle),
  );
  ctx.commands.registerCommand("fxi.gen.track", (arg: unknown) =>
    runFlow(ctx, arg as ableton.Handle, "arrangement"),
  );
  ctx.commands.registerCommand("fxi.gen.slot", (arg: unknown) =>
    runFlow(ctx, arg as ableton.Handle, "slot"),
  );
  ctx.commands.registerCommand("fxi.mix.master", (arg: unknown) =>
    runMixMaster(ctx, arg as ableton.Handle),
  );
  ctx.commands.registerCommand("fxi.vocal.enhance", (arg: unknown) =>
    runVocalEnhance(ctx, arg as ableton.Handle),
  );
  ctx.commands.registerCommand("fxi.vocal.max", (arg: unknown) =>
    runVocalMaxRack(ctx, arg as ableton.Handle),
  );
  ctx.commands.registerCommand("fxi.library.track", (arg: unknown) =>
    runLibrary(ctx, arg as ableton.Handle, "arrangement"),
  );
  ctx.commands.registerCommand("fxi.library.slot", (arg: unknown) =>
    runLibrary(ctx, arg as ableton.Handle, "slot"),
  );

  void ctx.ui.registerContextMenuAction("MidiClip", "Use clip as melody", "fxi.melody.capture");
  void ctx.ui.registerContextMenuAction("AudioTrack", "Generate music with FXI…", "fxi.gen.track");
  void ctx.ui.registerContextMenuAction("ClipSlot", "Generate music with FXI…", "fxi.gen.slot");
  void ctx.ui.registerContextMenuAction("AudioTrack", "Browse FXI sample library…", "fxi.library.track");
  void ctx.ui.registerContextMenuAction("ClipSlot", "Browse FXI sample library…", "fxi.library.slot");
  void ctx.ui.registerContextMenuAction("AudioTrack", "Match mix with FXI…", "fxi.mix.master");
  void ctx.ui.registerContextMenuAction("AudioTrack", "Enhance vocals with FXI…", "fxi.vocal.enhance");
  void ctx.ui.registerContextMenuAction("AudioClip", "Enhance vocals with FXI…", "fxi.vocal.enhance");
  void ctx.ui.registerContextMenuAction("ClipSlot", "Enhance vocals with FXI…", "fxi.vocal.enhance");
  // Native, instant, free — build a pro vocal Audio Effect Rack on the track.
  void ctx.ui.registerContextMenuAction("AudioTrack", "Enhance vocals with FXI (Vocal-Max rack)…", "fxi.vocal.max");
  void ctx.ui.registerContextMenuAction("AudioClip", "Enhance vocals with FXI (Vocal-Max rack)…", "fxi.vocal.max");
  void ctx.ui.registerContextMenuAction("ClipSlot", "Enhance vocals with FXI (Vocal-Max rack)…", "fxi.vocal.max");

  // AudioClip scope — right-click a pre-existing audio clip in Arrangement and
  // get the same rich menu as a track: generate, browse the saved-take library
  // (with a cappella / instrumental / WAV extraction), and match a mix. The
  // handlers resolve the clip's enclosing AudioTrack for insertion. Enhance +
  // Vocal-Max (incl. Isolate Vocals / Isolate Instrumental) are already above.
  void ctx.ui.registerContextMenuAction("AudioClip", "Generate music with FXI…", "fxi.gen.track");
  void ctx.ui.registerContextMenuAction("AudioClip", "Browse FXI sample library…", "fxi.library.track");
  void ctx.ui.registerContextMenuAction("AudioClip", "Match mix with FXI…", "fxi.mix.master");

  void initSession();
}

async function ensureSignedIn(): Promise<void> {
  if (isSignedIn()) return;
  setActiveSession(await signIn());
}

/** Right-click a MIDI clip → extract notes, render to WAV, upload as melody. */
async function captureMelody(ctx: Ctx, handle: ableton.Handle): Promise<void> {
  try {
    await ensureSignedIn();
    // Render the melody WAV at the SESSION tempo, not a hardcoded 120 BPM. The
    // rendered audio is the melody proxy Suno covers; if its pacing (note
    // durations in seconds) sits at 120 while the song targets another BPM, the
    // cover's phrasing drifts from the session (operator 2026-07-01). extract
    // falls back to 120 when the tempo can't be read.
    const captureTempo = readProjectTempo(ctx);
    const melody = extractMelodyFromHandle(ctx, handle, captureTempo);
    if (melody.noteCount === 0) {
      console.error("[FXI] melody clip has no notes");
      await notify(
        ctx,
        "No notes in that clip",
        "That MIDI clip has no notes to use as a melody. Pick a clip that contains notes and try again.",
      );
      return;
    }
    await ctx.ui.withinProgressDialog("Capturing melody…", {}, async () => {
      const trimmed = melody.renderNotes.filter((n) => n.start < MELODY_MAX_SECONDS);
      const wav = renderNotesToWav(trimmed);
      const { melodyUrl } = await fxi.uploadMelody(wav.toString("base64"));
      capturedMelody = {
        url: melodyUrl,
        preview: melody.preview,
        noteCount: melody.noteCount,
        durationSec: melody.durationSec,
      };
    });
    // Confirm — the capture is otherwise invisible, which read as "nothing
    // happened". Tell the operator exactly what to do next.
    await notify(
      ctx,
      "Melody captured",
      `${melody.noteCount} notes · ${melody.durationSec.toFixed(1)}s. Now right-click an audio track → "Generate music with FXI" — the melody will steer melody-capable models.`,
    );
  } catch (err) {
    if (err instanceof NotSignedInError) return;
    console.error("[FXI] melody capture error:", err);
    await notify(ctx, "Couldn't capture melody", errorMessage(err, "The melody clip couldn't be uploaded. Please try again."));
  }
}

async function runFlow(ctx: Ctx, target: ableton.Handle, dest: Destination): Promise<void> {
  try {
    await ensureSignedIn();

    // AudioClip scope hands us a clip; arrangement inserts need its track.
    if (dest === "arrangement") {
      const trackHandle = enclosingAudioTrackHandle(ctx, target);
      if (!trackHandle) {
        await notify(ctx, "No audio track found", "Right-click an audio track — or an audio clip on one — to add music with FXI.");
        return;
      }
      target = trackHandle;
    }

    const models = await fxi.listModels();
    const melodyForUi = capturedMelody
      ? {
          notes: capturedMelody.preview,
          noteCount: capturedMelody.noteCount,
          durationSec: capturedMelody.durationSec,
        }
      : null;
    const clipboard = await readClipboard();
    const tempo = readProjectTempo(ctx);

    // Outer loop = the compose screen. "← Change lyrics" from the take browser
    // and "← Back" from the library browser both re-show compose here, with the
    // operator's prior inputs restored via __PREFILL_JSON__ — no need to close
    // the dialog and re-right-click a track to start over (operator QOL).
    let prefill: ComposePrefill | null = null;
    for (;;) {
      let html = inject(composeHtml, "__MODELS_JSON__", models);
      html = inject(html, "__MELODY_JSON__", melodyForUi);
      html = inject(html, "__CFG_JSON__", { creditsPerSample: CREDITS_PER_SAMPLE });
      html = inject(html, "__CLIPBOARD_JSON__", clipboard);
      html = inject(html, "__PREFILL_JSON__", prefill);

      const composeRaw = await ctx.ui.showModalDialog(dataUrl(html), 480, 720);
      const compose = JSON.parse(composeRaw) as ComposePayload;
      if (compose.cancelled) return;

      // "Browse my library" → saved-sample browser. Picking an item inserts and
      // ends the flow; backing out returns to compose (outer loop continues).
      if (compose.library) {
        if (await browseLibrary(ctx, target, dest)) return;
        continue;
      }

      if (compose.models.length === 0) return;
      prefill = {
        lyrics: compose.lyrics,
        models: compose.models,
        variants: compose.variants,
        instrumental: compose.instrumental,
        acapella: !!compose.acapella,
      };

      // Inner loop = generate → browse → (pick | regenerate | back). "Generate
      // again" loops here with the SAME settings; "← Change lyrics" breaks back
      // to the compose screen (operator 2026-06-25 + QOL back-nav).
      const result = await generateAndBrowse(ctx, compose, tempo);
      if (result.kind === "cancel") return;
      if (result.kind === "back") continue; // re-show compose, prefilled
      if (result.kind === "extract") {
        await extractStemsToTracks(ctx, result.chosen, result.choice.stems);
        return;
      }

      await insertChosen(
        ctx,
        target,
        dest,
        result.chosen,
        !!compose.acapella,
        result.choice.stems,
        result.choice.placement ?? "new",
      );
      return;
    }
  } catch (err) {
    if (err instanceof NotSignedInError) return;
    console.error("[FXI] generation flow error:", err);
    await notify(ctx, "Generation failed", errorMessage(err, "Something went wrong while generating. Please try again."));
  }
}

type BrowseResult =
  | { kind: "cancel" }
  | { kind: "back" }
  | { kind: "extract"; chosen: fxi.Sample; choice: BrowserPayload }
  | { kind: "chosen"; chosen: fxi.Sample; choice: BrowserPayload };

/**
 * Inner generate→browse loop: spin a take set, show the take browser, and react
 * to the operator's choice. "Generate again" re-generates with the same
 * settings; "← Change lyrics" returns { back } so the caller re-shows compose.
 */
async function generateAndBrowse(
  ctx: Ctx,
  compose: ComposePayload,
  tempo: number | undefined,
): Promise<BrowseResult> {
  for (;;) {
    const job = await fxi.generate({
      lyrics: compose.lyrics,
      models: compose.models,
      variants: compose.variants,
      instrumental: compose.instrumental,
      ...(tempo ? { tempo } : {}),
      ...(capturedMelody ? { melodyUrl: capturedMelody.url } : {}),
    });

    const res = await pollUntilDone(ctx, job.jobId);
    const ready = res.ready;
    if (ready.length === 0) {
      await notify(
        ctx,
        res.error ? "Couldn't generate that" : "Nothing came back",
        res.error ??
          "The take finished but returned no audio. Failed takes aren't charged — try again, or pick a different model.",
      );
      return { kind: "cancel" };
    }

    const browseRaw = await showBrowser(ctx, ready, "takes");
    const choice = JSON.parse(browseRaw) as BrowserPayload;
    if (choice.cancelled) return { kind: "cancel" };
    if (choice.back) return { kind: "back" };
    if (choice.retry) continue; // quick retry — fresh takes, same settings
    if (!choice.trackId) return { kind: "cancel" };
    const chosen = ready.find((s) => s.trackId === choice.trackId);
    if (!chosen) return { kind: "cancel" };
    // "Extract selected → Live" — derive the checked stems only, each onto its
    // own new track. Distinct from "Add to Live", which places the main take.
    if (choice.extractOnly) return { kind: "extract", chosen, choice };
    return { kind: "chosen", chosen, choice };
  }
}

/**
 * Place a chosen take into the Live set. Handles the a cappella vocal-stem path
 * and the optional per-stem second pass — identical behavior to before, just
 * extracted so both the generation flow and the library browser can reuse it.
 */
async function insertChosen(
  ctx: Ctx,
  target: ableton.Handle,
  dest: Destination,
  chosen: fxi.Sample,
  acapella: boolean,
  stemSel: BrowserPayload["stems"],
  placement: Placement = "new",
): Promise<void> {
  if (acapella) {
    // A cappella → deliver the isolated VOCAL stem, not the full mix. Suno
    // has no native vocals-only mode, so we generate the full take then
    // separate it and place only the vocal.
    let placedVocal = false;
    try {
      const stems = await pollStemsUntilDerived(ctx, chosen.trackId);
      if (stems?.vocalUrl) {
        await ctx.ui.withinProgressDialog("Adding a cappella…", {}, async () => {
          const vocalTake = { ...chosen, audioUrl: stems.vocalUrl as string };
          if (dest === "arrangement") await insertIntoArrangement(ctx, target, vocalTake, { placement });
          else await insertIntoClipSlot(ctx, target, vocalTake);
        });
        placedVocal = true;
      }
    } catch (stemErr) {
      console.error("[FXI] acapella derive error:", stemErr);
    }
    if (!placedVocal) {
      await notify(
        ctx,
        "A cappella unavailable",
        "Couldn't isolate the vocals in time. Added the full take instead — the vocal stem keeps rendering and lands in your library.",
      );
      await ctx.ui.withinProgressDialog("Adding to your set…", {}, async () => {
        if (dest === "arrangement") await insertIntoArrangement(ctx, target, chosen, { placement });
        else await insertIntoClipSlot(ctx, target, chosen);
      });
    }
    return;
  }

  await ctx.ui.withinProgressDialog("Adding to your set…", {}, async () => {
    if (dest === "arrangement") await insertIntoArrangement(ctx, target, chosen, { placement });
    else await insertIntoClipSlot(ctx, target, chosen);
  });

  // Optional second pass: extract the operator-selected stems (vocal /
  // instrumental / WAV master), each onto its own labelled Live track.
  const wantStems = !!stemSel && (!!stemSel.wav || !!stemSel.instrumental || !!stemSel.vocal);
  if (wantStems && stemSel) {
    try {
      const stems = await pollStemsUntilDerived(ctx, chosen.trackId);
      if (stems) {
        const selected = {
          wavUrl: stemSel.wav ? stems.wavUrl : null,
          instrumentalUrl: stemSel.instrumental ? stems.instrumentalUrl : null,
          vocalUrl: stemSel.vocal ? stems.vocalUrl : null,
        };
        const placed = await ctx.ui.withinProgressDialog("Placing stems…", {}, () =>
          placeStemsAsTracks(ctx, chosen.title || "FXI take", selected, 0, chosen.durationSec),
        );
        if ((placed as number) === 0) {
          await notify(ctx, "No stems returned", "The selected stem(s) couldn't be rendered. Try again from the take.");
        }
      } else {
        await notify(ctx, "Stems unavailable", "Couldn't render the stems for this take. The main clip is already in your set.");
      }
    } catch (stemErr) {
      console.error("[FXI] stem derive/placement error:", stemErr);
      await notify(ctx, "Stems failed", errorMessage(stemErr, "Couldn't add the stems. The main clip is already in your set."));
    }
  }
}

/**
 * "Extract selected → Live" — derive the operator-checked stems for `chosen`
 * (vocal a cappella / instrumental / WAV master) and drop each onto its OWN new
 * labelled track. Never inserts the main take; that's what "Add to Live" is for.
 */
async function extractStemsToTracks(
  ctx: Ctx,
  chosen: fxi.Sample,
  stemSel: BrowserPayload["stems"],
): Promise<void> {
  const want = !!stemSel && (!!stemSel.wav || !!stemSel.instrumental || !!stemSel.vocal);
  if (!want || !stemSel) {
    await notify(ctx, "Nothing selected", "Tick Vocals, Instrumental or WAV master before extracting.");
    return;
  }
  try {
    // pollStemsUntilDerived shows its own "Rendering stems…" progress dialog.
    const stems = await pollStemsUntilDerived(ctx, chosen.trackId);
    if (!stems) {
      await notify(ctx, "Stems unavailable", "Couldn't render the stems for this take. Try again in a moment.");
      return;
    }
    const selected = {
      wavUrl: stemSel.wav ? stems.wavUrl : null,
      instrumentalUrl: stemSel.instrumental ? stems.instrumentalUrl : null,
      vocalUrl: stemSel.vocal ? stems.vocalUrl : null,
    };
    const placed = await ctx.ui.withinProgressDialog("Placing stems…", {}, () =>
      placeStemsAsTracks(ctx, chosen.title || "FXI take", selected, 0, chosen.durationSec),
    );
    if ((placed as number) === 0) {
      await notify(ctx, "No stems returned", "The selected stem(s) couldn't be rendered. Try again from the take.");
    }
  } catch (err) {
    console.error("[FXI] extract-only error:", err);
    await notify(ctx, "Extract failed", errorMessage(err, "Couldn't extract the stems. Please try again."));
  }
}

/**
 * Saved-sample browser: list the user's previously generated takes and insert
 * the picked one into the Live set. Returns true when the flow should END
 * (item inserted, or operator cancelled the whole dialog), false when the
 * operator backed out and a parent compose screen should be re-shown.
 */
async function browseLibrary(ctx: Ctx, target: ableton.Handle, dest: Destination): Promise<boolean> {
  const lib = await fxi.listLibrary();
  if (lib.length === 0) {
    await notify(
      ctx,
      "No saved audio yet",
      "Generate a take with FXI first — every take you make is saved here, ready to drop into any Live set.",
    );
    return false;
  }
  const raw = await showBrowser(ctx, lib, "library");
  const pick = JSON.parse(raw) as BrowserPayload;
  if (pick.cancelled) return true; // close the whole flow
  if (pick.back || !pick.trackId) return false; // back → re-show compose
  const chosen = lib.find((s) => s.trackId === pick.trackId);
  if (!chosen) return false;
  // "Make instrumental / a cappella / WAV from this take" — derive the checked
  // stems from the saved take (deriveStems works off its trackId), each onto its
  // own labelled track. No main take inserted; mirrors the post-gen "Extract".
  if (pick.extractOnly) {
    await extractStemsToTracks(ctx, chosen, pick.stems);
    return true;
  }
  // Plain "Add to Live", optionally with a stem second pass when the operator
  // ticked Vocals / Instrumental / WAV alongside the insert.
  await insertChosen(ctx, target, dest, chosen, false, pick.stems, pick.placement ?? "new");
  return true;
}

/**
 * Standalone entry point: right-click a track/clip-slot → "Browse FXI sample
 * library…". Opens the saved-sample browser directly, no generation required.
 */
async function runLibrary(ctx: Ctx, target: ableton.Handle, dest: Destination): Promise<void> {
  try {
    await ensureSignedIn();
    // AudioClip scope hands us a clip; arrangement inserts need its track.
    if (dest === "arrangement") {
      const trackHandle = enclosingAudioTrackHandle(ctx, target);
      if (!trackHandle) {
        await notify(ctx, "No audio track found", "Right-click an audio track — or an audio clip on one — to browse your library.");
        return;
      }
      target = trackHandle;
    }
    await browseLibrary(ctx, target, dest);
  } catch (err) {
    if (err instanceof NotSignedInError) return;
    console.error("[FXI] library flow error:", err);
    await notify(ctx, "Couldn't open your library", errorMessage(err, "Something went wrong loading your saved takes. Please try again."));
  }
}

/**
 * Drive the re-entrant derive pipeline to completion. Each `deriveStems` call
 * advances the WAV conversion + vocal separation one step and returns the current
 * `deriveStatus`; we poll until it terminates. Returns the stem URLs on success,
 * or null on hard failure / timeout.
 */
async function pollStemsUntilDerived(
  ctx: Ctx,
  trackId: string,
): Promise<{ wavUrl?: string | null; instrumentalUrl?: string | null; vocalUrl?: string | null } | null> {
  const MAX_PASSES = 144; // ~12 min ceiling at 5s/pass — multi-stem vocal-removal
  // separation routinely runs several minutes; the recover-orphaned-stems cron
  // is the server-side safety net if it outlasts even this window.
  let result: fxi.StemsResponse | null = null;
  await ctx.ui.withinProgressDialog("Rendering stems…", { progress: 0 }, async (update, signal) => {
    let tick = 0;
    let pass = 0;
    for (;;) {
      if (signal.aborted) return;
      // Poll deriveStems every ~5s (every 25 ticks); animate the wave at 200ms.
      if (tick % 25 === 0) {
        const res = await fxi.deriveStems(trackId);
        result = res;
        const status = res.deriveStatus ?? "deriving";
        if (status === "derived") {
          await update(fxiWaveLabel(tick, "Stems ready"), 100);
          return;
        }
        if (status === "derive_failed") return;
        pass += 1;
        if (pass >= MAX_PASSES) return;
      }
      await update(fxiWaveLabel(tick, "Rendering stems…"), Math.min(90, 10 + pass * 4));
      tick += 1;
      await delay(200);
    }
  });
  const final = result as fxi.StemsResponse | null;
  if (!final || final.deriveStatus !== "derived") return null;
  return { wavUrl: final.wavUrl, instrumentalUrl: final.instrumentalUrl, vocalUrl: final.vocalUrl };
}

/**
 * Right-click an audio track → "Enhance vocals with FXI…". Reads the track's
 * sung audio clip from disk, uploads it, then offers two modes:
 *   - Vocal-Max → keeps the user's own voice (resemble-enhance: de-noise + restore)
 *   - Re-sing   → AI re-performs the melody/lyrics (Suno cover)
 * The enhanced take is inserted back into the arrangement.
 */
async function runVocalEnhance(ctx: Ctx, handle: ableton.Handle): Promise<void> {
  try {
    await ensureSignedIn();

    // Registered on AudioTrack, AudioClip and ClipSlot — resolve the source
    // audio file + the track to insert the result into, whichever the operator
    // right-clicked.
    const obj = ctx.getObjectFromHandle(handle, ableton.DataModelObject);
    let filePath = "";
    let trackHandle: ableton.Handle | null = null;

    if (obj instanceof ableton.AudioClip) {
      filePath = obj.filePath;
    } else if (obj instanceof ableton.ClipSlot) {
      const clip = obj.clip;
      if (clip instanceof ableton.AudioClip) filePath = clip.filePath;
    } else if (obj instanceof ableton.AudioTrack) {
      trackHandle = obj.handle;
      for (const clip of obj.arrangementClips) {
        if (clip instanceof ableton.AudioClip) { filePath = clip.filePath; break; }
      }
      if (!filePath) {
        for (const slot of obj.clipSlots) {
          const c = slot.clip;
          if (c instanceof ableton.AudioClip) { filePath = c.filePath; break; }
        }
      }
    }

    // Walk up to the enclosing audio track so we can insert the result back.
    if (!trackHandle) {
      let cur = obj.parent;
      for (let i = 0; i < 8 && cur; i++) {
        if (cur instanceof ableton.AudioTrack) { trackHandle = cur.handle; break; }
        cur = cur.parent;
      }
    }

    if (!filePath || !trackHandle) {
      await notify(
        ctx,
        "No audio take found",
        "Right-click an audio clip with a sung take (or its track), then choose Enhance vocals.",
      );
      return;
    }

    // Read the clip file from disk → base64 → upload (reuses the melody store).
    let base64 = "";
    try {
      base64 = readFileSync(filePath).toString("base64");
    } catch {
      await notify(
        ctx,
        "Couldn't read the clip",
        "That audio file couldn't be read from disk. Consolidate the clip (⌘/Ctrl-J) and try again.",
      );
      return;
    }

    const sourceAudioUrl = (await ctx.ui.withinProgressDialog("Uploading your take…", {}, async () => {
      const { melodyUrl } = await fxi.uploadMelody(base64);
      return melodyUrl;
    })) as string;
    if (!sourceAudioUrl) return;

    const html = inject(vocalEnhanceHtml, "__CFG_JSON__", { creditsPerSample: CREDITS_PER_SAMPLE });
    const raw = await ctx.ui.showModalDialog(dataUrl(html), 460, 680);
    const choice = JSON.parse(raw) as {
      cancelled?: boolean;
      mode?: "re-sing" | "vocal-max" | "isolate-vocals" | "isolate-instrumental";
      style?: string;
      lyrics?: string;
      title?: string;
    };
    if (
      choice.cancelled ||
      (choice.mode !== "re-sing" &&
        choice.mode !== "vocal-max" &&
        choice.mode !== "isolate-vocals" &&
        choice.mode !== "isolate-instrumental")
    ) {
      return;
    }

    const tempo = readProjectTempo(ctx);

    // Run the chosen mode. When AI Re-Sing is rejected by the upstream model's
    // copyright detector — a KNOWN false-positive that provider raises on
    // common / traditional / public-domain / even original lines — we don't
    // dead-end the user: we blame the provider (FXI-themed message) and
    // automatically fall back to Vocal-Max, enhancing their OWN vocal instead.
    let effectiveMode = choice.mode;
    let ready: fxi.Sample[] = [];
    for (;;) {
      const job = await fxi.enhanceVocals({
        mode: effectiveMode,
        sourceAudioUrl,
        style: choice.style,
        lyrics: choice.lyrics,
        title: choice.title,
        ...(tempo ? { tempo } : {}),
      });

      const { ready: takes, error: jobError, errorCode } = await pollUntilDone(ctx, job.jobId);
      if (takes.length > 0) {
        ready = takes;
        break;
      }

      if (
        effectiveMode === "re-sing" &&
        isProviderCopyrightFalsePositive(errorCode, jobError)
      ) {
        // FXI-themed message: the provider's copyright detector misfired — not
        // your lyrics — and we're falling back to the NATIVE Vocal-Max rack.
        // Native is instant + free and can't also fail on an API, so instead of
        // re-calling the AI we build a pro vocal chain on the operator's OWN take.
        await notify(
          ctx,
          "Re-Sing flagged — switching to Vocal-Max",
          "The AI singing engine flagged your lyrics as copyrighted. That's a known " +
            "false-positive from the upstream AI music provider — its detector trips on " +
            "common, traditional, and public-domain lines, even original ones. It's the " +
            "provider's filter, not your words, and the flagged take wasn't charged.\n\n" +
            "FXI is building a native Vocal-Max rack on your track instead — Auto Shift, " +
            "vocal compression, delay, reverb and a utility, tuned to a studio finish. " +
            "It's instant, free, and polishes your own voice.",
        );
        const vtrack = ctx.getObjectFromHandle(trackHandle, ableton.AudioTrack);
        const rackResult = await ctx.ui.withinProgressDialog(
          "Building your Vocal-Max rack…",
          { progress: 0 },
          async (update) => {
            await update("Inserting native devices…", 40);
            const r = await applyVocalMaxRack(ctx, vtrack);
            await update("Done", 100);
            return r;
          },
        );
        await showVocalMaxSummary(ctx, rackResult as VocalMaxResult);
        return; // native rack applied — done, no AI re-run
      }

      await notify(
        ctx,
        jobError ? "Couldn't generate that" : "Nothing came back",
        jobError ??
          "The take finished but returned no audio. Failed takes aren't charged — try again.",
      );
      return;
    }

    const browseRaw = await showBrowser(ctx, ready, "takes");
    const pick = JSON.parse(browseRaw) as BrowserPayload;
    if (pick.cancelled || !pick.trackId) return;
    const chosen = ready.find((s) => s.trackId === pick.trackId);
    if (!chosen) return;

    await ctx.ui.withinProgressDialog("Adding to your set…", {}, async () => {
      await insertIntoArrangement(ctx, trackHandle, chosen);
    });
  } catch (err) {
    await notify(ctx, "Vocal enhance failed", errorMessage(err, "Something went wrong. Please try again."));
  }
}

/**
 * Right-click an audio track → "Match mix with FXI…". Resolve a MixProfile
 * (template or reference) from the gateway, then apply it to the track's device
 * chain + mixer via the SDK. Analysis-only — no credits are spent.
 */
async function runMixMaster(ctx: Ctx, handle: ableton.Handle): Promise<void> {
  try {
    await ensureSignedIn();

    // AudioClip scope hands us a clip; the mix profile applies to its track.
    const trackHandle = enclosingAudioTrackHandle(ctx, handle);
    if (!trackHandle) {
      await notify(ctx, "No audio track found", "Right-click an audio track — or an audio clip on one — to match a mix.");
      return;
    }

    let html = inject(mixMasterHtml, "__TEMPLATES_JSON__", MIX_TEMPLATE_OPTIONS);
    html = inject(html, "__CLIPBOARD_JSON__", await readClipboard());
    const raw = await ctx.ui.showModalDialog(dataUrl(html), 460, 420);
    const choice = JSON.parse(raw) as MixMasterPayload;
    if (choice.cancelled) return;

    const target: fxi.MixTarget = choice.target === "track" ? "track" : "master";
    const req: fxi.MixMasterRequest = { target };
    if (choice.mode === "reference") {
      if (!choice.referenceUrl) return;
      req.referenceUrl = choice.referenceUrl;
    } else {
      if (!choice.templateKey) return;
      req.templateKey = choice.templateKey;
    }

    const resolved = await fxi.getMixProfile(req);

    // Apply to the resolved AudioTrack (the right-clicked track, or the track of
    // a right-clicked clip). The master chain isn't directly addressable from
    // this context menu. (target is forwarded to the gateway for profile audit.)
    const track = ctx.getObjectFromHandle(trackHandle, ableton.AudioTrack);

    const result = await ctx.ui.withinProgressDialog("Matching mix…", { progress: 0 }, async (update) => {
      await update(`Applying ${resolved.profile.label}…`, 30);
      const r = await applyMixProfile(ctx, track, resolved.profile, resolved.manualSteps);
      await update("Done", 100);
      return r;
    });

    const apply = result as Awaited<ReturnType<typeof applyMixProfile>>;
    // Match the existing console.error logging convention (no console.log in this
    // codebase). A concise summary line is logged for the developer console.
    console.error(
      `[FXI] mix master "${resolved.profile.label}" applied — inserted ${apply.insertedDevices.length} device(s), ${apply.paramsSet} param(s) set, ${apply.manual.length} manual step(s)`,
    );

    const manualPreview = apply.manual.slice(0, 8);
    const summaryHtml =
      `<!doctype html><html><head><meta charset="UTF-8"/><style>` +
      `*{box-sizing:border-box;margin:0}body{background:#050505;color:#fff;font-family:Inter,system-ui,sans-serif;` +
      `font-size:12.5px;padding:18px;display:flex;flex-direction:column;gap:10px}` +
      `h1{font-size:14px;color:#eecd2b}.k{color:rgba(235,235,245,0.6)}` +
      `ul{margin:0;padding-left:18px;color:rgba(235,235,245,0.85);line-height:1.5}` +
      `button{margin-top:8px;padding:10px;border-radius:10px;border:none;background:#eecd2b;color:#1a1300;` +
      `font:inherit;font-weight:600;cursor:pointer}</style></head><body>` +
      `<h1>${resolved.profile.label}</h1>` +
      `<div class="k">Inserted ${apply.insertedDevices.length} device(s) · ${apply.paramsSet} parameter(s) set · ${apply.manual.length} manual step(s)</div>` +
      (manualPreview.length
        ? `<div class="k">Manual checklist:</div><ul>${manualPreview.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>`
        : `<div class="k">No manual steps — fully applied.</div>`) +
      `<button onclick="(window.webkit&&window.webkit.messageHandlers.live?window.webkit.messageHandlers.live:window.chrome.webview).postMessage({method:'close_and_send',params:['ok']})">Close</button>` +
      `</body></html>`;
    await ctx.ui.showModalDialog(dataUrl(summaryHtml), 460, 380);
  } catch (err) {
    if (err instanceof NotSignedInError) return;
    if (err instanceof fxi.GatewayError) {
      console.error(`[FXI] mix master gateway error (${err.status}/${err.code}):`, err.message);
      await notify(ctx, "Mix match failed", fxi.describeGatewayError(err));
      return;
    }
    console.error("[FXI] mix master error:", err);
    await notify(ctx, "Mix match failed", errorMessage(err, "Couldn't match the mix. Please try again."));
  }
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** FXI-themed completion dialog for the native Vocal-Max rack (mirrors mix master). */
async function showVocalMaxSummary(ctx: Ctx, result: VocalMaxResult): Promise<void> {
  const deviceCount = result.insertedDevices.length;
  console.error(
    `[FXI] vocal-max rack ${result.grouped ? "grouped" : "ungrouped"} — inserted ${deviceCount} device(s), ${result.paramsSet} param(s) set, ${result.manual.length} manual step(s)`,
  );
  const manualPreview = result.manual.slice(0, 8);
  const groupLine = result.grouped
    ? `Grouped into a single <b>${escapeHtml(result.rackDeviceName)}</b> on your track.`
    : `Inserted ungrouped — see the group step in the checklist below.`;
  const summaryHtml =
    `<!doctype html><html><head><meta charset="UTF-8"/><style>` +
    `*{box-sizing:border-box;margin:0}body{background:#050505;color:#fff;font-family:Inter,system-ui,sans-serif;` +
    `font-size:12.5px;padding:18px;display:flex;flex-direction:column;gap:10px}` +
    `h1{font-size:14px;color:#eecd2b}.k{color:rgba(235,235,245,0.6)}b{color:#eecd2b;font-weight:600}` +
    `ul{margin:0;padding-left:18px;color:rgba(235,235,245,0.85);line-height:1.5}` +
    `button{margin-top:8px;padding:10px;border-radius:10px;border:none;background:#eecd2b;color:#1a1300;` +
    `font:inherit;font-weight:600;cursor:pointer}</style></head><body>` +
    `<h1>Vocal-Max rack ready</h1>` +
    `<div class="k">${groupLine}</div>` +
    `<div class="k">Inserted ${deviceCount} device(s) · ${result.paramsSet} parameter(s) set · ${result.manual.length} manual step(s)</div>` +
    (manualPreview.length
      ? `<div class="k">Manual checklist:</div><ul>${manualPreview.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>`
      : `<div class="k">No manual steps — fully applied. Sing.</div>`) +
    `<button onclick="(window.webkit&&window.webkit.messageHandlers.live?window.webkit.messageHandlers.live:window.chrome.webview).postMessage({method:'close_and_send',params:['ok']})">Close</button>` +
    `</body></html>`;
  await ctx.ui.showModalDialog(dataUrl(summaryHtml), 460, 380);
}

/**
 * Right-click an audio track / clip / slot → "Enhance vocals with FXI (Vocal-Max
 * rack)…". Resolve the enclosing AudioTrack and build a native, instant, FREE pro
 * vocal Audio Effect Rack on it — no gateway, no credits, no API round-trip.
 */
async function runVocalMaxRack(ctx: Ctx, handle: ableton.Handle): Promise<void> {
  try {
    const obj = ctx.getObjectFromHandle(handle, ableton.DataModelObject);
    let track: InstanceType<typeof ableton.AudioTrack> | null = null;
    if (obj instanceof ableton.AudioTrack) {
      track = obj;
    } else {
      let cur = obj.parent;
      for (let i = 0; i < 8 && cur; i++) {
        if (cur instanceof ableton.AudioTrack) { track = cur; break; }
        cur = cur.parent;
      }
    }
    if (!track) {
      await notify(
        ctx,
        "No vocal track found",
        "Right-click the audio track with your vocal (or a clip on it), then choose the Vocal-Max rack.",
      );
      return;
    }

    const vocalTrack = track;
    const result = await ctx.ui.withinProgressDialog(
      "Building your Vocal-Max rack…",
      { progress: 0 },
      async (update) => {
        await update("Inserting native devices…", 40);
        const r = await applyVocalMaxRack(ctx, vocalTrack);
        await update("Done", 100);
        return r;
      },
    );
    await showVocalMaxSummary(ctx, result as VocalMaxResult);
  } catch (err) {
    await notify(ctx, "Vocal-Max failed", errorMessage(err, "Couldn't build the rack. Please try again."));
  }
}

async function pollUntilDone(
  ctx: Ctx,
  jobId: string,
): Promise<{ ready: fxi.Sample[]; error: string | null; errorCode: string | null }> {
  let latest: fxi.Sample[] = [];
  let jobError: string | null = null;
  let jobErrorCode: string | null = null;
  await ctx.ui.withinProgressDialog("Composing…", { progress: 0 }, async (update, signal) => {
    let tick = 0;
    let done = 0;
    let total = 1;
    let finished = false;
    for (;;) {
      if (signal.aborted) return;
      // Poll status every ~4s (every 20 animation ticks); animate the wave at
      // 200ms so the dialog reads as alive between polls.
      if (tick % 20 === 0) {
        const status = await fxi.getStatus(jobId);
        latest = status.samples;
        if (status.message) jobError = status.message; // whole-job failure reason
        if (status.error) jobErrorCode = status.error; // stable code (copyright_lyrics…)
        done = status.samples.filter((s) => s.status === "complete").length;
        total = status.samples.length || 1;
        if (status.done) finished = true;
      }
      await update(fxiWaveLabel(tick, `Composing ${done}/${total}`), Math.round((done / total) * 100));
      if (finished) return;
      tick += 1;
      await delay(200);
    }
  });
  const ready = latest.filter((s) => s.status === "complete" && s.audioUrl);
  // No usable take → surface a specific reason (e.g. copyrighted lyrics) from a
  // failed sample so the caller shows WHY, not a generic "Nothing came back".
  if (ready.length === 0) {
    const failed = latest.find((s) => s.status === "failed" && (s.error || s.errorCode));
    if (!jobError) jobError = failed?.error ?? null;
    if (!jobErrorCode) jobErrorCode = failed?.errorCode ?? null;
  }
  return { ready, error: jobError, errorCode: jobErrorCode };
}

/**
 * True when a failed take was rejected by the upstream AI singing model's
 * copyright detector. This is a KNOWN false-positive from that third-party
 * provider — it flags common, traditional, and public-domain lines (even
 * original ones) as "copyrighted." We blame the provider, not the user, and
 * fall the Re-Sing path back to Vocal-Max. Match the stable code first, then
 * the mapped message as a safety net.
 */
function isProviderCopyrightFalsePositive(
  code: string | null,
  message: string | null,
): boolean {
  if (code === "copyright_lyrics") return true;
  return /copyright|copyrighted material/i.test(message ?? "");
}
