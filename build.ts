import * as esbuild from "esbuild";
import * as fs from "node:fs";
import { animateBanner } from "./src/branding/logo.ts";

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const production = process.argv.includes("--production");

// Build-time config injection. esbuild replaces the `__FXI_*__` identifiers in
// src/config.ts with these string literals, so the bundle carries concrete URLs
// and the Live runtime never reads `process.env`. Override per-build via FXI_*
// env vars, e.g. `FXI_WEB_BASE=http://localhost:3000 npm run package` to point
// sign-in at a local web dev server while the gateway stays on prod.
const define = {
  __FXI_WEB_BASE__: JSON.stringify(
    process.env.FXI_WEB_BASE || "https://www.fxi.studio",
  ),
  __FXI_SUPABASE_URL__: JSON.stringify(
    process.env.FXI_SUPABASE_URL || "https://otngoodabsitxuakbove.supabase.co",
  ),
  __FXI_SUPABASE_PUBLISHABLE_KEY__: JSON.stringify(
    process.env.FXI_SUPABASE_PUBLISHABLE_KEY ||
      "sb_publishable_4i8WCFGI0hHmftIdgn5HAQ_zVY23GW6",
  ),
};
console.log(`[build] WEB_BASE = ${define.__FXI_WEB_BASE__}`);

await esbuild.build({
  entryPoints: ["src/extension.ts"],
  outfile: manifest.entry,
  bundle: true,
  format: "cjs",
  platform: "node",
  sourcesContent: false,
  logLevel: "info",
  minify: production,
  sourcemap: !production,
  define,
  loader: { ".html": "text" },
  // keytar is an OPTIONAL native module — never bundle it. session-store.ts
  // dynamically imports it and falls back to a 0600 file store when absent.
  external: ["keytar"],
});

// Thematic flourish shown in the DEVELOPER's terminal after a build (npm start /
// npm run build). animateEqualizer + printBanner are TTY-gated, so piped/CI
// builds print nothing extra. This is the operator's own terminal — distinct
// from the Live Extension Host stdout that activate()'s printBanner writes to.
const version = (manifest.version as string) || "1.0.0";
await animateBanner(5200, 18, version);
