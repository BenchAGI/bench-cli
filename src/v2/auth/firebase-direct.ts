// Firebase Direct browser-handoff — SPEC §4.3 (post-ANVIL P0 fix).
// Pure browser-to-listener: page JS POSTs tokens directly to 127.0.0.1:port.
// V1 ships this plumbing for v1.1 cloud-bound subcommands; not required
// for V1 local-only chat.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { saveCreds, type FirebaseCreds } from "../state/keychain.js";

export type LoginOptions = {
  authPageUrl?: string;     // override https://benchagi.com/auth/cli
  timeoutMs?: number;
  port?: number;            // override random port
  // For tests: skip the real browser launch
  openBrowser?: (url: string) => Promise<void>;
};

const DEFAULT_AUTH_PAGE = "https://benchagi.com/auth/cli";
const DEFAULT_TIMEOUT_MS = 90_000;
const ALLOWED_ORIGIN = "https://benchagi.com";

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Browser-handoff login flow with EADDRINUSE retry per ADR-002
 * (V1.1 — Item 6). If the listener can't bind because the
 * randomly-picked port is in use, pick a fresh port once and retry.
 * After a second collision we give up.
 *
 * If the caller supplied an explicit `opts.port`, we don't retry —
 * they asked for that exact port.
 */
export async function loginFlow(opts: LoginOptions = {}): Promise<{
  email: string;
  uid: string;
}> {
  return await retryOnAddrInUse(loginFlowAttempt, opts);
}

/**
 * Run `attempt(opts)`. If it throws an EADDRINUSE error AND the
 * caller did not pin the port, retry exactly once with a fresh
 * random port. All other errors bubble up untouched. Exported for
 * unit testing — production callers should use `loginFlow`.
 * V1.1 — Item 6.
 */
export async function retryOnAddrInUse<T>(
  attempt: (opts: LoginOptions) => Promise<T>,
  opts: LoginOptions,
): Promise<T> {
  try {
    return await attempt(opts);
  } catch (err) {
    if (opts.port === undefined && isAddrInUseError(err)) {
      return await attempt({ ...opts, port: randomInt(8000, 10_000) });
    }
    throw err;
  }
}

export function isAddrInUseError(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" &&
    (err as { code?: string }).code === "EADDRINUSE",
  );
}

async function loginFlowAttempt(opts: LoginOptions = {}): Promise<{
  email: string;
  uid: string;
}> {
  const port = opts.port ?? randomInt(8000, 10_000);
  const state = randomBytes(16).toString("base64url");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const authPage = opts.authPageUrl ?? DEFAULT_AUTH_PAGE;

  const url = new URL(authPage);
  url.searchParams.set("port", String(port));
  url.searchParams.set("state", state);

  return await new Promise((resolve, reject) => {
    let resolved = false;

    const server = createServer(async (req, res) => {
      try {
        await handle(req, res, state, (creds) => {
          if (resolved) return;
          resolved = true;
          server.close();
          if (creds.kind === "ok") {
            saveCreds(creds.creds).then(
              () => resolve({ email: creds.creds.email, uid: creds.creds.uid }),
              (err) => reject(err),
            );
          } else {
            reject(new Error(creds.error));
          }
        });
      } catch (err) {
        try {
          res.writeHead(500).end("internal error");
        } catch {
          // ignore
        }
        if (!resolved) {
          resolved = true;
          server.close();
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      server.close();
      reject(
        new Error(
          `auth login timed out after ${timeoutMs}ms. If your browser isn't on this machine, the loopback handoff can't complete — re-run \`benchagi auth login --paste\` and paste the sign-in bundle the auth page shows.`,
        ),
      );
    }, timeoutMs);

    server.on("close", () => clearTimeout(timer));

    server.listen(port, "127.0.0.1", () => {
      const opener = opts.openBrowser ?? defaultOpenBrowser;
      opener(url.toString()).catch(() => {
        // Print fallback URL on browser-launch failure.
        process.stderr.write(`Open this URL in your browser: ${url.toString()}\n`);
      });
      process.stderr.write(`Listening on http://127.0.0.1:${port} (90s timeout)\n`);
    });

    server.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      reject(err);
    });
  });
}

type CallbackResult =
  | { kind: "ok"; creds: FirebaseCreds }
  | { kind: "err"; error: string };

/**
 * Validate + normalize a sign-in bundle (the JSON the auth page produces).
 * Shared by the loopback callback (`handle`) and the `--paste` escape hatch so
 * both enforce the exact same shape — idToken, refreshToken, uid, email,
 * expiresAt. Returns a tagged result rather than throwing so each caller can
 * shape its own response.
 */
export function parseFirebaseCredsBundle(raw: string): CallbackResult {
  let parsed: Partial<FirebaseCreds>;
  try {
    parsed = JSON.parse(raw) as Partial<FirebaseCreds>;
  } catch {
    return { kind: "err", error: "invalid JSON" };
  }
  if (
    typeof parsed.idToken !== "string" ||
    typeof parsed.refreshToken !== "string" ||
    typeof parsed.uid !== "string" ||
    typeof parsed.email !== "string" ||
    typeof parsed.expiresAt !== "number"
  ) {
    return { kind: "err", error: "missing fields" };
  }
  return {
    kind: "ok",
    creds: {
      idToken: parsed.idToken,
      refreshToken: parsed.refreshToken,
      uid: parsed.uid,
      email: parsed.email,
      expiresAt: parsed.expiresAt,
    },
  };
}

/**
 * `--paste` escape hatch: persist a sign-in bundle obtained out-of-band
 * (the auth page's manual copy box) instead of via the loopback listener.
 * This is the durable fallback for the case where the browser is NOT on the
 * same machine as the CLI — the loopback handoff POSTs to 127.0.0.1:<port>,
 * which only the local browser can reach, so a remote/screen-shared browser
 * fails with "couldn't reach the CLI listener". Reuses the same validation and
 * `saveCreds` persistence as the loopback path, so refresh tokens are retained.
 */
export async function loginWithPastedCredsBundle(
  raw: string,
): Promise<{ email: string; uid: string }> {
  const result = parseFirebaseCredsBundle(raw.trim());
  if (result.kind === "err") {
    throw new Error(
      `Pasted sign-in bundle is invalid (${result.error}). Paste the full JSON the auth page shows (idToken, refreshToken, uid, email, expiresAt).`,
    );
  }
  await saveCreds(result.creds);
  return { email: result.creds.email, uid: result.creds.uid };
}

/**
 * The HTTP request handler for the cli-callback listener. Exported so
 * the PNA preflight regression test can exercise it directly without
 * spinning up the full `loginFlow` (which would call `saveCreds` and
 * write fake tokens to the real macOS Keychain — Codex Anvil flagged
 * this as a BLOCK on the original test). Production use stays through
 * `loginFlow` → `loginFlowAttempt` → `handle`.
 */
export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  expectedState: string,
  done: (result: CallbackResult) => void,
): Promise<void> {
  // CORS preflight only for the allowed origin and only the callback path.
  //
  // Chrome's Private Network Access (PNA) sends an additional preflight
  // when a public-internet origin (https://benchagi.com) tries to fetch
  // a private/loopback address (http://127.0.0.1:<port>). Without our
  // explicit consent header (`Access-Control-Allow-Private-Network`),
  // Chrome 130+ blocks the POST before it ever reaches us — failing
  // closed with "Permission was denied for this request to access the
  // loopback address space". We MUST acknowledge the PNA preflight on
  // the OPTIONS response, and we only do it for the allowed origin.
  // Spec: https://wicg.github.io/private-network-access/
  // Chrome rollout: https://developer.chrome.com/blog/private-network-access-preflight
  if (req.method === "OPTIONS" && req.url?.startsWith("/cli-callback")) {
    if (req.headers.origin === ALLOWED_ORIGIN) {
      const headers: Record<string, string> = {
        "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "Content-Type",
      };
      // Echo PNA consent only if the browser actually asked for it. This
      // keeps the surface tight: we don't advertise PNA support to clients
      // that aren't doing PNA, and we still gate on the origin check above.
      if (req.headers["access-control-request-private-network"] === "true") {
        headers["Access-Control-Allow-Private-Network"] = "true";
      }
      res.writeHead(204, headers);
    } else {
      res.writeHead(403);
    }
    res.end();
    return;
  }

  if (req.method !== "POST" || !req.url?.startsWith("/cli-callback")) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }

  if (req.headers.origin !== ALLOWED_ORIGIN) {
    res.writeHead(403);
    res.end("forbidden origin");
    return;
  }

  const u = new URL(req.url, "http://127.0.0.1");
  const state = u.searchParams.get("state") ?? "";
  if (!constantTimeEq(state, expectedState)) {
    res.writeHead(400, { "Access-Control-Allow-Origin": ALLOWED_ORIGIN });
    res.end("state mismatch");
    done({ kind: "err", error: "CSRF state mismatch" });
    return;
  }

  let body = "";
  for await (const chunk of req) {
    body += chunk.toString();
    if (body.length > 64 * 1024) {
      res.writeHead(413, { "Access-Control-Allow-Origin": ALLOWED_ORIGIN });
      res.end("payload too large");
      done({ kind: "err", error: "payload too large" });
      return;
    }
  }

  const result = parseFirebaseCredsBundle(body);
  if (result.kind === "err") {
    res.writeHead(400, { "Access-Control-Allow-Origin": ALLOWED_ORIGIN });
    res.end(result.error); // "invalid JSON" | "missing fields"
    done(result);
    return;
  }

  res.writeHead(200, {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify({ ok: true }));
  done(result);
}

async function defaultOpenBrowser(url: string): Promise<void> {
  const cmd =
    process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "start" :
    "xdg-open";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, [url], { detached: true, stdio: "ignore" });
    child.on("error", reject);
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
