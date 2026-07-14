import { loadSession, saveSession, clearSession, type StoredSession } from "./session-store.js";
import type { ActiveSession } from "./sign-in.js";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, TOKEN_REFRESH_URL } from "../config.js";

// Holds the live session in memory and refreshes the short-lived access token
// from the persisted refresh token on demand. The refresh token rotates on each
// refresh (Supabase default) — we persist the rotated value every time.

export class NotSignedInError extends Error {
  constructor() {
    super("not signed in");
    this.name = "NotSignedInError";
  }
}

let stored: StoredSession | null = null;
let accessToken: string | null = null;
let accessExpiresAtMs = 0;

function jwtExpMs(token: string): number {
  try {
    const part = token.split(".")[1];
    if (!part) return 0;
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/** Load any persisted session at activation. Returns true if one exists. */
export async function initSession(): Promise<boolean> {
  stored = await loadSession();
  return stored !== null;
}

export function isSignedIn(): boolean {
  return stored !== null;
}

export function currentEmail(): string | null {
  return stored?.email ?? null;
}

/** Record the result of an interactive sign-in. */
export function setActiveSession(active: ActiveSession): void {
  stored = active.stored;
  accessToken = active.accessToken;
  accessExpiresAtMs = jwtExpMs(active.accessToken) || Date.now() + 50 * 60 * 1000;
}

export async function signOut(): Promise<void> {
  stored = null;
  accessToken = null;
  accessExpiresAtMs = 0;
  await clearSession();
}

interface RefreshResponse {
  access_token: string;
  refresh_token: string;
}

/** Return a valid access token, refreshing if it expires within 60s. */
export async function getAccessToken(): Promise<string> {
  if (!stored) throw new NotSignedInError();
  if (accessToken && Date.now() < accessExpiresAtMs - 60_000) {
    return accessToken;
  }

  const res = await fetch(TOKEN_REFRESH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_PUBLISHABLE_KEY,
    },
    body: JSON.stringify({ refresh_token: stored.refreshToken }),
  });
  if (!res.ok) {
    // Refresh token revoked/expired → force a fresh interactive sign-in.
    await signOut();
    throw new NotSignedInError();
  }
  const data = (await res.json()) as RefreshResponse;
  accessToken = data.access_token;
  accessExpiresAtMs = jwtExpMs(data.access_token) || Date.now() + 50 * 60 * 1000;
  stored = { ...stored, refreshToken: data.refresh_token };
  await saveSession(stored);
  return accessToken;
}

export { SUPABASE_URL };
