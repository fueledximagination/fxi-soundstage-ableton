import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Persists the desktop session. The REFRESH TOKEN is the sensitive value — it is
// stored in the OS keychain when `keytar` is available (preferred), otherwise in
// a 0600 file under the user's home dir. The short-lived access token is kept in
// memory only and re-derived from the refresh token on demand.

export interface StoredSession {
  refreshToken: string;
  userId: string;
  email: string;
}

const SERVICE = "com.fueledximagination.fxistudio.ableton";
const ACCOUNT = "session";
const FALLBACK_DIR = path.join(os.homedir(), ".fxi-ableton");
const FALLBACK_FILE = path.join(FALLBACK_DIR, "session.json");

// keytar is an OPTIONAL native dependency — load it lazily and degrade
// gracefully if its prebuilt binary isn't present for this platform.
type Keytar = {
  getPassword(s: string, a: string): Promise<string | null>;
  setPassword(s: string, a: string, p: string): Promise<void>;
  deletePassword(s: string, a: string): Promise<boolean>;
};

async function loadKeytar(): Promise<Keytar | null> {
  try {
    const mod = (await import("keytar")) as unknown as { default?: Keytar } & Keytar;
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

export async function saveSession(session: StoredSession): Promise<void> {
  const payload = JSON.stringify(session);
  const keytar = await loadKeytar();
  if (keytar) {
    await keytar.setPassword(SERVICE, ACCOUNT, payload);
    return;
  }
  fs.mkdirSync(FALLBACK_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(FALLBACK_FILE, payload, { mode: 0o600 });
}

export async function loadSession(): Promise<StoredSession | null> {
  const keytar = await loadKeytar();
  if (keytar) {
    const raw = await keytar.getPassword(SERVICE, ACCOUNT);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  }
  try {
    return JSON.parse(fs.readFileSync(FALLBACK_FILE, "utf8")) as StoredSession;
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  const keytar = await loadKeytar();
  if (keytar) {
    await keytar.deletePassword(SERVICE, ACCOUNT);
    return;
  }
  try {
    fs.rmSync(FALLBACK_FILE);
  } catch {
    /* already gone */
  }
}
