import http from "http";
import crypto from "crypto";
import { loadTokens, saveTokens, clearTokens } from "./token-store.js";
import { getCurrentUserId } from "../context.js";
import { registerPendingState } from "../http/oauth-callbacks.js";
import open from "open";

export interface MyCaseTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  firm_uuid?: string;
  scope?: string;
}

function getAuthUrl(): string {
  return process.env.MYCASE_AUTH_URL ?? "https://auth.mycase.com/login_sessions/new";
}

function getTokenUrl(): string {
  return process.env.MYCASE_TOKEN_URL ?? "https://auth.mycase.com/tokens";
}

function getRedirectPort(): number {
  return parseInt(process.env.MYCASE_REDIRECT_PORT ?? "5678", 10);
}

function getStdioRedirectUri(): string {
  return `http://127.0.0.1:${getRedirectPort()}/callback`;
}

function getHttpRedirectUri(): string {
  const base = process.env.MYCASE_HTTP_BASE_URL?.replace(/\/$/, "");
  if (!base) throw new Error("MYCASE_HTTP_BASE_URL must be set in HTTP transport mode.");
  return `${base}/oauth/callback`;
}

export interface OAuthFlowOptions {
  serverMode?: boolean;
}

/**
 * In stdio mode (default): opens a browser and waits for the local callback server.
 * In HTTP server mode: registers a pending state and returns the auth URL as a string
 * for the caller to surface to the user — the browser redirect is handled by the
 * main HTTP server's /oauth/callback route.
 */
export async function runOAuthFlow(opts?: OAuthFlowOptions): Promise<void | string> {
  const clientId = process.env.MYCASE_CLIENT_ID;
  const clientSecret = process.env.MYCASE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("MYCASE_CLIENT_ID and MYCASE_CLIENT_SECRET must be set in .env");
  }

  const state = crypto.randomBytes(16).toString("hex");
  const redirectUri = opts?.serverMode ? getHttpRedirectUri() : getStdioRedirectUri();

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
  });

  const authUrl = `${getAuthUrl()}?${params.toString()}`;

  if (opts?.serverMode) {
    const userId = getCurrentUserId();
    registerPendingState(state, { userId, clientId, clientSecret, redirectUri });
    return authUrl;
  }

  console.error(`[oauth] Opening browser for MyCase authorization...`);
  console.error(`[oauth] If the browser doesn't open, visit:\n  ${authUrl}`);
  await open(authUrl);

  const code = await waitForCallback(state);
  const tokens = await exchangeCodeForTokens(code, clientId, clientSecret, redirectUri);
  await saveTokens(tokens);
  console.error(`[oauth] Authenticated${tokens.firm_uuid ? ` for firm ${tokens.firm_uuid}` : ""}.`);
}

async function waitForCallback(expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const port = getRedirectPort();
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      if (url.pathname !== "/callback") return;

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<html><body><h2>${error ? "Authentication failed." : "Authentication successful!"}</h2>` +
          `<p>You can close this tab and return to Claude.</p></body></html>`
      );
      server.close();

      if (error) return reject(new Error(`OAuth error: ${error}`));
      if (state !== expectedState)
        return reject(new Error("OAuth state mismatch — possible CSRF attack"));
      if (!code) return reject(new Error("No authorization code received"));
      resolve(code);
    });

    server.listen(port, "127.0.0.1", () =>
      console.error(`[oauth] Waiting for callback on 127.0.0.1:${port}...`)
    );
    server.on("error", (err) =>
      reject(new Error(`Failed to start callback server: ${err.message}`))
    );
    setTimeout(() => {
      server.close();
      reject(new Error("OAuth callback timed out after 5 minutes"));
    }, 5 * 60 * 1000);
  });
}

export async function exchangeCodeForTokens(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<MyCaseTokens> {
  const res = await fetch(getTokenUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in?: number;
    firm_uuid?: string;
    scope?: string;
  };

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in ?? 86400) * 1000,
    firm_uuid: data.firm_uuid,
    scope: data.scope,
  };
}

// Per-user inflight refresh deduplication to prevent concurrent refresh storms.
const inflightRefreshes = new Map<string, Promise<MyCaseTokens>>();

export function refreshAccessToken(): Promise<MyCaseTokens> {
  const userId = getCurrentUserId();
  let p = inflightRefreshes.get(userId);
  if (!p) {
    p = doRefresh().finally(() => inflightRefreshes.delete(userId));
    inflightRefreshes.set(userId, p);
  }
  return p;
}

async function doRefresh(): Promise<MyCaseTokens> {
  const tokens = await loadTokens();
  if (!tokens?.refresh_token) {
    throw new Error("No refresh token available. Please authenticate first.");
  }

  const res = await fetch(getTokenUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: process.env.MYCASE_CLIENT_ID!,
      client_secret: process.env.MYCASE_CLIENT_SECRET!,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };

  const updated: MyCaseTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? tokens.refresh_token,
    expires_at: Date.now() + (data.expires_in ?? 86400) * 1000,
    firm_uuid: tokens.firm_uuid,
    scope: data.scope ?? tokens.scope,
  };

  await saveTokens(updated);
  return updated;
}

export async function getValidAccessToken(): Promise<string> {
  const tokens = await loadTokens();
  if (!tokens) {
    throw new Error(
      'Not authenticated. Use the "authenticate" tool to connect to MyCase.'
    );
  }

  if (Date.now() >= tokens.expires_at - 5 * 60 * 1000) {
    console.error("[oauth] Token near expiry, refreshing...");
    const refreshed = await refreshAccessToken();
    return refreshed.access_token;
  }

  return tokens.access_token;
}

export { clearTokens };
