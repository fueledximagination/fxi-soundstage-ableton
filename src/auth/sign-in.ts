import * as http from "node:http";
import { spawn } from "node:child_process";
import { createPkcePair, createState } from "./pkce.js";
import { saveSession, type StoredSession } from "./session-store.js";
import { WEB_AUTH_URL, TOKEN_EXCHANGE_URL } from "../config.js";

export interface ActiveSession {
  accessToken: string;
  stored: StoredSession;
}

interface ExchangeResponse {
  access_token: string;
  refresh_token: string;
  user: { id: string; email: string };
}

const SUCCESS_HTML =
  "<!doctype html><meta charset=utf-8><title>FXI Studio</title>" +
  "<body style='font-family:Inter,system-ui;background:#050505;color:#EBEBF5;display:grid;place-items:center;height:100vh;margin:0'>" +
  "<div style='text-align:center'><h2 style='color:#eecd2b'>Signed in</h2>" +
  "<p>You can close this tab and return to Ableton Live.</p></div>";

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
}

/**
 * Drive the loopback PKCE sign-in: open the system browser to the FXI sign-in
 * page, capture the one-time code on a local 127.0.0.1 listener, exchange it for
 * a session, and persist it. Rejects on timeout / state mismatch / exchange
 * failure.
 */
export function signIn(timeoutMs = 180_000): Promise<ActiveSession> {
  const { verifier, challenge } = createPkcePair();
  const state = createState();

  return new Promise<ActiveSession>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname !== "/callback") {
          res.writeHead(404).end();
          return;
        }
        const code = url.searchParams.get("code");
        const returnedState = url.searchParams.get("state");
        if (!code || returnedState !== state) {
          res.writeHead(400).end("Invalid sign-in response.");
          cleanup();
          reject(new Error("sign-in state mismatch"));
          return;
        }

        const exchange = await fetch(TOKEN_EXCHANGE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, code_verifier: verifier }),
        });
        if (!exchange.ok) {
          res.writeHead(502).end("Sign-in failed.");
          cleanup();
          reject(new Error(`exchange failed (${exchange.status})`));
          return;
        }
        const data = (await exchange.json()) as ExchangeResponse;
        const stored: StoredSession = {
          refreshToken: data.refresh_token,
          userId: data.user.id,
          email: data.user.email,
        };
        await saveSession(stored);

        res.writeHead(200, { "Content-Type": "text/html" }).end(SUCCESS_HTML);
        cleanup();
        resolve({ accessToken: data.access_token, stored });
      } catch (err) {
        res.writeHead(500).end("Sign-in error.");
        cleanup();
        reject(err instanceof Error ? err : new Error("sign-in error"));
      }
    });

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("sign-in timed out"));
    }, timeoutMs);

    function cleanup(): void {
      clearTimeout(timer);
      server.close();
    }

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        cleanup();
        reject(new Error("could not bind loopback listener"));
        return;
      }
      const redirectUri = `http://127.0.0.1:${addr.port}/callback`;
      const authUrl =
        `${WEB_AUTH_URL}?challenge=${encodeURIComponent(challenge)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&state=${encodeURIComponent(state)}`;
      openBrowser(authUrl);
    });
  });
}
