import { randomBytes, createHash } from "node:crypto";

// RFC 7636 PKCE (S256). The verifier never leaves the extension; only its SHA-256
// challenge travels in the browser URL, so intercepting the URL is useless.

export interface PkcePair {
  verifier: string;
  challenge: string;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function createPkcePair(): PkcePair {
  // 32 random bytes → 43-char base64url verifier (within the 43–128 spec range).
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** Opaque value echoed through the browser round-trip to detect tampering. */
export function createState(): string {
  return base64url(randomBytes(16));
}
