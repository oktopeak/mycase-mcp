/**
 * HTTP server integration tests.
 *
 * All external dependencies are mocked. The Express app is started on a random
 * port so tests make real HTTP requests via fetch — this catches routing, middleware,
 * and response-shape bugs that unit tests can't.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import type { AddressInfo } from "node:net";
import type http from "node:http";

// ── Mock all external dependencies before any imports ──────────────────────

vi.mock("../../src/http/api-keys.js", () => ({
  loadApiKeys: vi.fn().mockResolvedValue(undefined),
  resolveUserId: vi.fn().mockImplementation((key: string) => {
    const keys: Record<string, string> = {
      "sk_alice": "alice@firm.com",
      "sk_bob": "bob@firm.com",
    };
    return keys[key];
  }),
}));

vi.mock("../../src/server-factory.js", () => ({
  createMcpServer: vi.fn().mockReturnValue({
    connect: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => {
  return {
    // Must use `function` keyword so `new StreamableHTTPServerTransport(...)` works as a constructor.
    StreamableHTTPServerTransport: vi.fn().mockImplementation(function (this: any, options: {
      sessionIdGenerator?: () => string;
      onsessioninitialized?: (id: string) => void | Promise<void>;
      onsessionclosed?: (id: string) => void | Promise<void>;
    }) {
      this._options = options;
      this._sessionId = undefined as string | undefined;

      this.start = vi.fn().mockResolvedValue(undefined);
      this.close = vi.fn().mockImplementation(async () => {
        if (this._sessionId) {
          await options.onsessionclosed?.(this._sessionId);
        }
      });

      this.handleRequest = vi.fn().mockImplementation(async (req: any, res: any) => {
        const incomingSessionId = req.headers?.["mcp-session-id"] as string | undefined;

        if (!incomingSessionId && options.sessionIdGenerator) {
          // Simulate new session initialization (MCP initialize request).
          const newId = options.sessionIdGenerator();
          this._sessionId = newId;
          await options.onsessioninitialized?.(newId);
          res.setHeader("Mcp-Session-Id", newId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "test", version: "1.0.0" } } }));
        } else if (req.method === "DELETE") {
          // Simulate session termination — fires onsessionclosed.
          if (this._sessionId) {
            await options.onsessionclosed?.(this._sessionId);
            this._sessionId = undefined;
          }
          res.writeHead(200);
          res.end();
        } else {
          // Subsequent POST or GET on an existing session.
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ handled: true }));
        }
      });
    }),
  };
});

vi.mock("../../src/http/oauth-callbacks.js", () => ({
  consumePendingState: vi.fn(),
}));

vi.mock("../../src/auth/oauth.js", () => ({
  exchangeCodeForTokens: vi.fn(),
}));

vi.mock("../../src/auth/token-store.js", () => ({
  saveTokens: vi.fn().mockResolvedValue(undefined),
}));

// ── Import after mocks ─────────────────────────────────────────────────────

import { createExpressApp } from "../../src/http/server.js";
import { consumePendingState } from "../../src/http/oauth-callbacks.js";
import { exchangeCodeForTokens } from "../../src/auth/oauth.js";
import { createMcpServer } from "../../src/server-factory.js";

// ── Server lifecycle ───────────────────────────────────────────────────────

let serverInstance: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = createExpressApp();
  await new Promise<void>((resolve) => {
    serverInstance = app.listen(0, resolve) as http.Server;
  });
  const addr = serverInstance.address() as AddressInfo;
  baseUrl = `http://localhost:${addr.port}`;
});

afterAll(async () => {
  (serverInstance as any).closeAllConnections?.();
  await new Promise<void>((resolve) =>
    serverInstance.close(() => resolve())
  );
});

beforeEach(() => vi.clearAllMocks());

// ── /health ────────────────────────────────────────────────────────────────

describe("GET /health", () => {
  it("returns 200 with status=ok and transport=http", async () => {
    const res = await fetch(`${baseUrl}/health`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.transport).toBe("http");
  });

  it("includes a sessions count", async () => {
    const res = await fetch(`${baseUrl}/health`);
    const body = await res.json();

    expect(typeof body.sessions).toBe("number");
  });

  it("requires no authentication", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
  });
});

// ── POST /mcp — authentication ─────────────────────────────────────────────

describe("POST /mcp — authentication", () => {
  it("returns 401 with no Authorization header", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/Unauthorized/i);
  });

  it("returns 401 with an invalid API key", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: "Bearer sk_invalid",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 with a malformed Authorization header (no Bearer prefix)", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: "sk_alice",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });
});

// ── POST /mcp — session cap ────────────────────────────────────────────────

describe("POST /mcp — session cap", () => {
  it("returns 429 when a user has reached the MAX_SESSIONS_PER_USER limit", async () => {
    const MAX = 10;
    const sessionsAtCap = new Map<string, { transport: unknown; userId: string }>();
    for (let i = 0; i < MAX; i++) {
      sessionsAtCap.set(`pre-session-${i}`, { transport: {}, userId: "alice@firm.com" });
    }

    const cappedApp = createExpressApp(sessionsAtCap as any);
    let cappedServer!: http.Server;
    const cappedPort = await new Promise<number>((resolve) => {
      cappedServer = cappedApp.listen(0, () =>
        resolve((cappedServer.address() as AddressInfo).port)
      ) as http.Server;
    });

    const res = await fetch(`http://localhost:${cappedPort}/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer sk_alice", "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toContain("Too many concurrent sessions");

    (cappedServer as any).closeAllConnections?.();
    await new Promise<void>((r) => cappedServer.close(() => r()));
  });

  it("allows a connection when one below the per-user cap", async () => {
    const sessionsOneBelowCap = new Map<string, { transport: unknown; userId: string }>();
    for (let i = 0; i < 9; i++) {
      sessionsOneBelowCap.set(`pre-session-${i}`, { transport: {}, userId: "alice@firm.com" });
    }

    const app = createExpressApp(sessionsOneBelowCap as any);
    let srv!: http.Server;
    const port = await new Promise<number>((resolve) => {
      srv = app.listen(0, () => resolve((srv.address() as AddressInfo).port)) as http.Server;
    });

    const res = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer sk_alice", "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);

    (srv as any).closeAllConnections?.();
    await new Promise<void>((r) => srv.close(() => r()));
  });
});

// ── POST /mcp — new session ────────────────────────────────────────────────

describe("POST /mcp — new session", () => {
  it("returns 200 with Mcp-Session-Id header for a valid key", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer sk_alice", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
  });

  it("calls createMcpServer once per new session", async () => {
    await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer sk_alice", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });

    expect(createMcpServer).toHaveBeenCalledOnce();
  });
});

// ── GET /mcp — authentication ──────────────────────────────────────────────

describe("GET /mcp — authentication", () => {
  it("returns 401 with no Authorization header", async () => {
    const res = await fetch(`${baseUrl}/mcp`);
    expect(res.status).toBe(401);
  });

  it("returns 400 with valid auth but no Mcp-Session-Id", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      headers: { Authorization: "Bearer sk_alice" },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Mcp-Session-Id");
  });

  it("returns 200 when Mcp-Session-Id belongs to the authenticated user", async () => {
    // Create a session first
    const initRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer sk_alice", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    const sessionId = initRes.headers.get("mcp-session-id")!;
    expect(sessionId).toBeTruthy();

    // Open SSE stream on that session
    const res = await fetch(`${baseUrl}/mcp`, {
      headers: {
        Authorization: "Bearer sk_alice",
        "mcp-session-id": sessionId,
      },
    });

    expect(res.status).toBe(200);
  });

  it("returns 403 when Mcp-Session-Id belongs to a different user", async () => {
    // Create a session as alice
    const initRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer sk_alice", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    const sessionId = initRes.headers.get("mcp-session-id")!;

    // Try to GET the session stream as bob
    const res = await fetch(`${baseUrl}/mcp`, {
      headers: {
        Authorization: "Bearer sk_bob",
        "mcp-session-id": sessionId,
      },
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("different user");
  });
});

// ── POST /mcp — routing ────────────────────────────────────────────────────

describe("POST /mcp — routing", () => {
  it("returns 404 when Mcp-Session-Id references a non-existent session", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: "Bearer sk_alice",
        "Content-Type": "application/json",
        "mcp-session-id": "session-does-not-exist",
      },
      body: JSON.stringify({}),
    });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toContain("Session not found");
  });

  it("routes messages to the correct session transport", async () => {
    // Step 1: initialize a session
    const initRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer sk_alice", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get("mcp-session-id")!;
    expect(sessionId).toBeTruthy();

    // Step 2: send a message to that session
    const msgRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: "Bearer sk_alice",
        "Content-Type": "application/json",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });

    expect(msgRes.status).toBe(200);
    const body = await msgRes.json();
    expect(body.handled).toBe(true);
  });

  it("returns 403 when a different user's API key is used for an existing session", async () => {
    // Initialize a session as alice
    const initRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer sk_alice", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    const sessionId = initRes.headers.get("mcp-session-id")!;

    // Try to send a message as bob using alice's session ID
    const msgRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: "Bearer sk_bob",       // bob's key
        "Content-Type": "application/json",
        "mcp-session-id": sessionId,          // alice's session
      },
      body: JSON.stringify({}),
    });

    expect(msgRes.status).toBe(403);
    const body = await msgRes.json();
    expect(body.error).toContain("different user");
  });
});

// ── DELETE /mcp — session termination ─────────────────────────────────────

describe("DELETE /mcp — session termination", () => {
  it("returns 404 for a non-existent session", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: {
        Authorization: "Bearer sk_alice",
        "mcp-session-id": "no-such-session",
      },
    });
    expect(res.status).toBe(404);
  });

  it("returns 403 when attempting to delete a session belonging to a different user", async () => {
    // Create a session as alice
    const initRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer sk_alice", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    const sessionId = initRes.headers.get("mcp-session-id")!;

    // Try to DELETE as bob
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: {
        Authorization: "Bearer sk_bob",
        "mcp-session-id": sessionId,
      },
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("different user");
  });

  it("terminates an existing session and removes it from the sessions map", async () => {
    // Create a session
    const initRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer sk_alice", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    const sessionId = initRes.headers.get("mcp-session-id")!;

    // Delete it
    const delRes = await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: {
        Authorization: "Bearer sk_alice",
        "mcp-session-id": sessionId,
      },
    });
    expect(delRes.status).toBe(200);

    // A subsequent message should now get 404
    const msgRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: "Bearer sk_alice",
        "Content-Type": "application/json",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({}),
    });
    expect(msgRes.status).toBe(404);
  });
});

// ── /oauth/callback ────────────────────────────────────────────────────────

describe("GET /oauth/callback", () => {
  it("returns 400 when state parameter is missing", async () => {
    const res = await fetch(`${baseUrl}/oauth/callback?code=abc`);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("Missing state");
  });

  it("returns 400 when state is unknown or expired", async () => {
    vi.mocked(consumePendingState).mockReturnValue(undefined);

    const res = await fetch(`${baseUrl}/oauth/callback?state=unknown-state&code=abc`);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("Unknown or expired");
  });

  it("returns 400 and surfaces OAuth error parameter", async () => {
    vi.mocked(consumePendingState).mockReturnValue({
      userId: "alice@firm.com",
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://mycase-mcp.lawfirm.com/oauth/callback",
    });

    const res = await fetch(
      `${baseUrl}/oauth/callback?state=valid-state&error=access_denied`
    );
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("Authentication failed");
    expect(text).toContain("access_denied");
  });

  it("returns 400 when state is valid but no code is provided", async () => {
    vi.mocked(consumePendingState).mockReturnValue({
      userId: "alice@firm.com",
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://mycase-mcp.lawfirm.com/oauth/callback",
    });

    const res = await fetch(`${baseUrl}/oauth/callback?state=valid-state`);
    expect(res.status).toBe(400);
  });

  it("exchanges code for tokens and returns 200 success page on happy path", async () => {
    const pending = {
      userId: "alice@firm.com",
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://mycase-mcp.lawfirm.com/oauth/callback",
    };
    vi.mocked(consumePendingState).mockReturnValue(pending);
    vi.mocked(exchangeCodeForTokens).mockResolvedValue({
      access_token: "new-token",
      refresh_token: "new-refresh",
      expires_at: Date.now() + 86400_000,
      firm_uuid: "firm-abc",
    });

    const res = await fetch(
      `${baseUrl}/oauth/callback?state=valid-state&code=auth-code-123`
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Authentication successful");

    expect(exchangeCodeForTokens).toHaveBeenCalledWith(
      "auth-code-123",
      "client-id",
      "client-secret",
      "https://mycase-mcp.lawfirm.com/oauth/callback"
    );
  });

  it("returns 500 when exchangeCodeForTokens throws", async () => {
    vi.mocked(consumePendingState).mockReturnValue({
      userId: "alice@firm.com",
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://mycase-mcp.lawfirm.com/oauth/callback",
    });
    vi.mocked(exchangeCodeForTokens).mockRejectedValue(
      new Error("Token exchange failed (401): Unauthorized")
    );

    const res = await fetch(
      `${baseUrl}/oauth/callback?state=valid-state&code=bad-code`
    );

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toContain("Authentication error");
  });

  it("HTML-escapes OAuth error values to prevent XSS", async () => {
    vi.mocked(consumePendingState).mockReturnValue({
      userId: "alice@firm.com",
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://mycase-mcp.lawfirm.com/oauth/callback",
    });

    const res = await fetch(
      `${baseUrl}/oauth/callback?state=valid-state&error=${encodeURIComponent("<script>alert(1)</script>")}`
    );
    const text = await res.text();

    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;");
  });
});
