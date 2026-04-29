#!/usr/bin/env node
import http from "http";
import crypto from "crypto";
import { loadTokens, saveTokens, clearTokens } from "./token-store.js";
import open from "open";

export interface MyCaseTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  user_id?: string;
}

function getAuthUrl(): string {
  return process.env.MYCASE_AUTH_URL ?? "https://auth.mycase.com/oauth/authorize";
}

function getTokenUrl(): string {
  return process.env.MYCASE_TOKEN_URL ?? "https://auth.mycase.com/oauth/token";
}

function getRedirectPort(): number {
  return parseInt(process.env.MYCASE_REDIRECT_PORT ?? "5678", 10);
}

function getRedirectUri(): string {
  return `http://localhost:${getRedirectPort()}/callback`;
}

export async function runOAuthFlow(): Promise<void> {
  const clientId = process.env.MYCASE_CLIENT_ID;
  const clientSecret = process.env.MYCASE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("MYCASE_CLIENT_ID and MYCASE_CLIENT_SECRET must be set in .env");
  }

  const state = crypto.randomBytes(16).toString("hex");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: getRedirectUri(),
    state,
  });

  const authUrl = `${getAuthUrl()}?${params.toString()}`;
  console.error(`[oauth] Opening browser for MyCase authorization...`);
  console.error(`[oauth] If the browser doesn't open, visit:\n  ${authUrl}`);
  await open(authUrl);

  const code = await waitForCallback(state);
  const tokens = await exchangeCodeForTokens(code, clientId, clientSecret);
  const userId = await fetchUserId(tokens.access_token).catch(() => undefined);
  await saveTokens({ ...tokens, user_id: userId });
  console.error(`[oauth] Authenticated${userId ? ` as user ${userId}` : ""}.`);
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

    server.listen(port, () =>
      console.error(`[oauth] Waiting for callback on port ${port}...`)
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

async function exchangeCodeForTokens(
  code: string,
  clientId: string,
  clientSecret: string
): Promise<Omit<MyCaseTokens, "user_id">> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: getRedirectUri(),
  });

  const res = await fetch(getTokenUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in?: number;
  };

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
}

export async function refreshAccessToken(): Promise<MyCaseTokens> {
  const tokens = await loadTokens();
  if (!tokens?.refresh_token) {
    throw new Error("No refresh token available. Please authenticate first.");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: process.env.MYCASE_CLIENT_ID!,
    client_secret: process.env.MYCASE_CLIENT_SECRET!,
  });

  const res = await fetch(getTokenUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const updated: MyCaseTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? tokens.refresh_token,
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
    user_id: tokens.user_id,
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

async function fetchUserId(accessToken: string): Promise<string | undefined> {
  const base = process.env.MYCASE_API_BASE ?? "https://api.mycase.com/api/v1";
  // Confirm endpoint path from MyCase docs — commonly /users/me or /me
  const res = await fetch(`${base}/users/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return undefined;
  const data = (await res.json()) as { id?: string | number };
  return data?.id != null ? String(data.id) : undefined;
}

export { clearTokens };
