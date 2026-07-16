# SECURITY REVIEW — FXI SoundStage public distribution

**Date:** 2026-07-14 · **Version reviewed:** 1.6.0 · **Scope:** `apps/ableton-extension/src/`, `build.ts`, `dist/extension.js`, `fxi-soundstage-1.6.0.ablx`

## Verdict

**CLEAR TO PUBLISH source + releases.** No hardcoded secrets, no internal URLs, no tokens found in source or the shipped bundle. All embedded identifiers are public-by-design.

## Findings

### Public-by-design values (OK to ship — intentional)

| Location | Value | Assessment |
|---|---|---|
| `build.ts:15` | `https://www.fxi.studio` (default `__FXI_WEB_BASE__`) | Public prod web origin. OK. |
| `build.ts:18` | `https://otngoodabsitxuakbove.supabase.co` (default `__FXI_SUPABASE_URL__`) | Public Supabase project URL. Ships in every client by necessity; protected by RLS + gateway auth. OK. |
| `build.ts:22` | `sb_publishable_4i8WCFGI0hHmftIdgn5HAQ_zVY23GW6` | Supabase **publishable (anon)** key — designed to ship in clients (see comment at `src/config.ts:1-4`). NOT a secret key. OK. |
| `src/config.ts:26-29` | Derived endpoints: `/functions/v1/soundstage-extension` gateway, `/auth/extension`, `/api/auth/extension/exchange`, `/auth/v1/token` | All public prod endpoints the client must call. No internal edge-function names leak — client speaks only the gateway contract (`src/api/fxi-client.ts:7-8`). OK. |
| `src/auth/sign-in.ts:44,97,104` | `127.0.0.1` loopback listener, ephemeral port | Standard PKCE loopback redirect (RFC 8252). Local-only. OK. |

### Confirmed absent (verified by scan)

- **No JWTs** (`eyJ…` pattern) in `src/` or `dist/extension.js`
- **No secret keys** (`sb_secret_`, `service_role`, `sk-…`) anywhere
- **No internal infrastructure**: no `api.fxi.studio` (GX10 gateway), no Tailscale/LAN IPs (`100.115.x.x`, `192.168.x.x`), no `:8188`/`:8080` ComfyUI ports in `src/` or `dist/`
- **No third-party API keys** (Replicate, KIE, ElevenLabs, Suno) — all provider calls happen server-side behind the gateway
- **`.ablx` archive contents**: exactly `manifest.json` + `dist/extension.js` — no sourcemap, no `.env`, no source

### Good patterns observed

- `src/config.ts:1-10` — explicit "no secrets ever live in the extension" architecture; config injected as esbuild `define` literals, overridable per-build via `FXI_*` env vars
- `src/api/fxi-client.ts:159-163` — publishable key as `apikey` header; user session token as `Bearer`; typed gateway-only contract ("never internal edge-function shapes")
- `src/auth/session-store.ts:24-26` — tokens persisted via keytar (OS keychain), never plaintext files
- `src/auth/pkce.ts` — PKCE code exchange, no client secret

### Items requiring care (not blockers)

| # | Item | Location | Action |
|---|---|---|---|
| 1 | Local `.env` exists with `EXTENSION_HOST_PATH` (machine path, e.g. Live 12 Beta app path). Not a secret, but reveals local setup. | `apps/ableton-extension/.env` | Already gitignored. Ensure public repo's `.gitignore` includes `.env`; ship `.env.example` only. |
| 2 | `dist/extension.js.map` present locally — sourcemap of the full bundled source. | `apps/ableton-extension/dist/extension.js.map` | Not in the `.ablx` (verified). Do not commit `dist/` to the public repo. |
| 3 | Vendored Ableton SDK/CLI tarballs (`vendor/*.tgz`, 1.0.0-beta.0). Redistribution rights unconfirmed — Ableton beta SDK likely under NDA/beta terms. | `apps/ableton-extension/vendor/` | **Do NOT commit `vendor/` to the public repo** until Ableton's redistribution terms are confirmed. Document "obtain SDK from Ableton" in build docs instead. |
| 4 | Old `.ablx` archives (1.0.0–1.6.0) sit in the extension root. | `apps/ableton-extension/*.ablx` | Attach to GitHub Releases per-version; don't commit binaries to the repo. |
| 5 | Supabase project ref `otngoodabsitxuakbove` becomes permanently public. | `build.ts:18` | Acceptable (already ships in every web client). Confirm RLS coverage + gateway rate limiting before publishing. |
| 6 | Internal `README.md` at extension root references `.env` setup and internal scripts. | `apps/ableton-extension/README.md` | Replace with `public-release/README.md` in the public repo; write a public BUILDING doc if source-included. |

## Re-scan procedure (run before every public push)

```sh
cd apps/ableton-extension
grep -rniE "(sb_secret|service_role|sk-[A-Za-z0-9]{10,}|eyJ[A-Za-z0-9_-]{20,})" src build.ts
grep -rnE "(100\.115|192\.168|api\.fxi\.studio|:8188)" src build.ts
```

Both should print nothing.
