# RELEASING — FXI SoundStage (internal checklist)

Internal process doc. Do not publish this file to the public repo unless deliberately choosing transparent-release-process.

## 1. Version bump (two files, two indent styles)

| File | Field | Indentation |
|---|---|---|
| `apps/ableton-extension/manifest.json` | `"version"` | **4-space** |
| `apps/ableton-extension/package.json` | `"version"` | **2-space** |

Both MUST match. The `.ablx` filename and the in-Live version come from `manifest.json`; npm tooling reads `package.json`. Keep the existing indentation of each file — do not reformat.

## 2. Build & package

```sh
cd apps/ableton-extension
npm run package        # tsc --noEmit → esbuild --production → extensions-cli package
```

Output: `fxi-soundstage-<version>.ablx` in the extension root.

Sanity check the build banner: `[build] WEB_BASE = "https://www.fxi.studio"` — if it shows localhost or a staging URL, an `FXI_*` env var leaked into the shell. Rebuild in a clean shell.

## 3. Verify the archive before uploading

```sh
unzip -l fxi-soundstage-<version>.ablx
```

Expected contents — EXACTLY two files:
- `manifest.json`
- `dist/extension.js`

Must NOT contain: `.env`, `extension.js.map`, `node_modules/`, `vendor/`, `src/`, anything else.

Secret scan the bundle (should print nothing):

```sh
grep -oE "eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+" dist/extension.js   # no JWTs
grep -oE "(sb_secret|service_role|sk-[A-Za-z0-9]{10,})" dist/extension.js            # no secret keys
grep -oE "https?://[a-zA-Z0-9./_?=&-]+" dist/extension.js | sort -u                  # only public URLs
```

Allowed strings in the bundle (public by design):
- `https://www.fxi.studio`
- `https://otngoodabsitxuakbove.supabase.co`
- `sb_publishable_…` (Supabase publishable/anon key — designed to ship in clients)
- `http://127.0.0.1` (PKCE loopback)

## 4. Smoke test

Install the fresh `.ablx` in Live (double-click), then verify:
- [ ] Sign-in flow completes (browser → loopback → keychain)
- [ ] Generate on audio track produces a take
- [ ] Library browse loads
- [ ] Isolate Vocals / Isolate Instrumental on an audio clip
- [ ] Match mix dialog opens

## 5. Tag & GitHub Release

```sh
git tag v<version>          # scheme: v1.6.0 — matches manifest version exactly
git push origin v<version>
```

Create the GitHub Release on the tag:
- Title: `FXI SoundStage v<version>`
- Attach: `fxi-soundstage-<version>.ablx` (the release asset users download)
- Body: user-facing changelog (features, fixes — no internal ticket refs, no backend details)

## 6. What must NEVER ship / be committed to the public repo

- `.env` (contains local `EXTENSION_HOST_PATH` — machine path, gitignored; `.env.example` is fine)
- `dist/` build output and `extension.js.map` (releases carry the `.ablx`; the repo carries source)
- Old `.ablx` archives from the private repo root (attach per-release only)
- Any `sb_secret_*` / service-role key, Replicate/KIE/ElevenLabs keys — none exist in this codebase today; keep it that way
- Internal infra references (GX10, `api.fxi.studio` gateway, Tailscale IPs) — verified absent from `src/` and `dist/` as of v1.6.0
- Internal docs: this file's private notes, `memory/`, marketing packs

## 7. Post-release

- [ ] Update download link / version on fxi.studio if referenced
- [ ] Bump `memory/session-log.md` in the private repo
