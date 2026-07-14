// Build-time configuration. All values here are PUBLIC (project URL + publishable
// key are designed to ship in clients). No secrets ever live in the extension —
// every privileged call goes through the gateway with a user session token.
//
// These three identifiers are replaced with string LITERALS at bundle time by
// esbuild `define` (see build.ts). Override any of them per-build via the
// matching FXI_* env var, e.g.:
//   FXI_WEB_BASE=http://localhost:3000 npm run package
// Build-time substitution means the Live runtime never needs a `process` object
// (the extension host is not guaranteed to provide one).
declare const __FXI_WEB_BASE__: string;
declare const __FXI_SUPABASE_URL__: string;
declare const __FXI_SUPABASE_PUBLISHABLE_KEY__: string;

/** FXI web origin — hosts the sign-in page + token exchange endpoint. */
export const WEB_BASE = __FXI_WEB_BASE__;

/** Supabase project — gateway URL + token-refresh endpoint. */
export const SUPABASE_URL = __FXI_SUPABASE_URL__;

/** Publishable (anon) key — public by design; sent as the `apikey` header. */
export const SUPABASE_PUBLISHABLE_KEY = __FXI_SUPABASE_PUBLISHABLE_KEY__;

export const GATEWAY_URL = `${SUPABASE_URL}/functions/v1/soundstage-extension`;
export const WEB_AUTH_URL = `${WEB_BASE}/auth/extension`;
export const TOKEN_EXCHANGE_URL = `${WEB_BASE}/api/auth/extension/exchange`;
export const TOKEN_REFRESH_URL = `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`;
