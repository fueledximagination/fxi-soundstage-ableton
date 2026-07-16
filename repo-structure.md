# Public repo layout — `fueledximagination/fxi-soundstage-ableton`

## Recommendation: **Releases + source (source-included)**

Publish the client source AND attach `.ablx` binaries to GitHub Releases.

**Why source-included wins here:**
- The client is fully auditable — SECURITY_REVIEW.md confirms zero secrets in `src/`; the architecture was explicitly designed for this (`src/config.ts`: "No secrets ever live in the extension").
- Users are being asked to run third-party code *inside their DAW* that opens a local HTTP listener and touches the OS keychain. Visible source is the single strongest trust signal for that ask.
- The moat is the backend (gateway, models, credits) — it stays private. The client is a thin typed wrapper over one gateway contract; publishing it reveals nothing exploitable.
- Community leverage: issues with real stack traces, PRs for Live-version quirks, SEO for "Ableton AI music extension".

**Releases-only tradeoff (rejected unless circumstances change):**
- Pros: zero source maintenance, no license/fork questions, hides UI/UX implementation from competitors (Higgsfield, CapCut watch this space).
- Cons: unauditable binary in a DAW = trust ceiling; no community contributions; competitors can trivially unminify the bundle anyway (esbuild output is readable), so secrecy gained is near zero.

**Blocker check:** none — security review found nothing that forces releases-only. One conditional: `vendor/` (Ableton beta SDK tarballs) must be excluded regardless (redistribution rights unconfirmed).

## Proposed layout

```
fxi-soundstage-ableton/
├── README.md                 ← from public-release/README.md
├── LICENSE                   ← MIT + supplemental notices
├── CHANGELOG.md              ← user-facing, per release
├── BUILDING.md               ← how to build from source (incl. "obtain the
│                                Ableton Extensions SDK from Ableton" note)
├── .gitignore                ← .env, dist/, node_modules/, vendor/, *.ablx
├── manifest.json
├── package.json              ← deps point at SDK; document local vendor step
├── tsconfig.json
├── build.ts
├── .env.example              ← EXTENSION_HOST_PATH template only
├── src/                      ← full client source (api/, auth/, mix/, midi/,
│                                svs/, insert/, ui/, branding/, config.ts,
│                                extension.ts)
├── docs/
│   └── screenshots/          ← README images
└── .github/
    ├── ISSUE_TEMPLATE/       ← bug report (Live version, extension version),
    │                            feature request
    └── workflows/
        └── release.yml       ← optional later: tag → build → attach .ablx
```

**Excluded from public repo (kept private / release-assets only):**
- `vendor/*.tgz` — Ableton SDK redistribution unconfirmed (SECURITY_REVIEW item 3)
- `dist/` + sourcemaps — build output; the `.ablx` release asset is the artifact
- `*.ablx` history — attach per GitHub Release, not committed
- `.env` — machine-local
- `RELEASING.md` internal notes, anything referencing private infra
- `public-release/` staging folder itself (its contents graduate to repo root)

## Release flow (summary — full checklist in RELEASING.md)

1. Bump `manifest.json` (4-space) + `package.json` (2-space) in the private monorepo
2. `npm run package` → verify archive contents + secret scan
3. Sync source snapshot to the public repo (subtree push or scripted copy)
4. Tag `v<version>`, create GitHub Release, attach `fxi-soundstage-<version>.ablx`

## Open decisions for operator

- Monorepo sync strategy: `git subtree split` from `apps/ableton-extension/` vs. scripted copy. Subtree preserves history (audit history for leaked strings FIRST); scripted copy starts clean (recommended for v1).
- Whether to publish `RELEASING.md` (transparent process) or keep internal.
- CI auto-build in public repo requires vendored SDK — defer `release.yml` until SDK redistribution question is resolved; build locally and attach for now.
