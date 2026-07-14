// The Ableton Extension Host runs extension code in an embedded Node context
// with a CURATED global set that omits some standard web globals. Observed in
// Live 12 Beta: `URL` is undefined — the sign-in loopback handler threw
// "ReferenceError: URL is not defined" the moment Live redirected to it.
//
// Polyfill the globals we depend on from node: built-ins. Importing this module
// FIRST (a side-effect import at the top of extension.ts) guarantees the globals
// exist before any command handler runs. Keep this list minimal: add a global
// only after confirming the host actually omits it.
import { URL, URLSearchParams } from "node:url";

const g = globalThis as Record<string, unknown>;
if (typeof g.URL === "undefined") g.URL = URL;
if (typeof g.URLSearchParams === "undefined") g.URLSearchParams = URLSearchParams;
