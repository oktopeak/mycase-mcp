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
    connect: vi.fn().mockImplementation(async (transport: { start: () => Promise<void> }) => {
      await transport.start();
    }),
  }),
}));

vi.mock("@modelcontextprotocol/sdk/server/sse.js", () => {
  let counter = 0;
  return {
  // Must use `function` keyword so `new SSEServerTransport(...)` works as a constructor.
  // Returning an explicit object from a constructor uses that object as the result of `new`.
  SSEServerTransport: vi.fn().mockImplementation(function (_endpoint: string, res: any) {
    const sessionId = `mock-session-${++counter}`;
    return {
      sessionId,
      onclose: undefined as (() => void) | undefined,
      start: vi.fn().mockImplementation(async () => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });
        // flushHeaders() sends the status + headers to the client immediately
        // so that fetch() resolves as soon as headers arrive (SSE bodies are unbounded).
        res.flushHeaders();
      }),
      handlePostMessage: vi.fn().mockImplementation(async (_req: unknown, postRes: any) => {
        postRes.writeHead(200, { "Content-Type": "application/json" });
        postRes.end(JSON.stringify({ handled: true }));
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
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
  // Force-close any lingering SSE connections so server.close() can complete.
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
    // Health check is intentionally unauthenticated
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
  });
});

// ── /sse — authentication ──────────────────────────────────────────────────

describe("GET /sse — authentication", () => {
  it("returns 401 with no Authorization header", async () => {
    const res = await fetch(`${baseUrl}/sse`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/Unauthorized/i);
  });

  it("returns 401 with an invalid API key", async () => {
    const res = await fetch(`${baseUrl}/sse`, {
      headers: { Authorization: "Bearer sk_invalid" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 with a malformed Authorization header (no Bearer prefix)", async () => {
    const res = await fetch(`${baseUrl}/sse`, {
      headers: { Authorization: "sk_alice" },
    });
    expect(res.status).toBe(401);
  });
});

// ── /sse — successful connection ───────────────────────────────────────────

describe("GET /sse — successful connection", () => {
  it("returns 200 SSE stream with correct content-type for a valid key", async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/sse`, {
      headers: { Authorization: "Bearer sk_alice" },
      signal: controller.signal,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    controller.abort();
    // Drain the aborted stream to avoid unhandled rejection
    await res.body?.cancel().catch(() => {});
  });

  it("calls createMcpServer once per connection", async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/sse`, {
      headers: { Authorization: "Bearer sk_alice" },
      signal: controller.signal,
    });

    expect(createMcpServer).toHaveBeenCalledOnce();

    controller.abort();
    await res.body?.cancel().catch(() => {});
  });
});

// ── /message — routing ─────────────────────────────────────────────────────

describe("POST /message — routing", () => {
  it("returns 401 with no Authorization header", async () => {
    const res = await fetch(`${baseUrl}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("returns 400 when mcp-session-id header is missing", async () => {
    const res = await fetch(`${baseUrl}/message`, {
      method: "POST",
      headers: {
        Authorization: "Bearer sk_alice",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("mcp-session-id");
  });

  it("returns 404 when mcp-session-id references a non-existent session", async () => {
    const res = await fetch(`${baseUrl}/message`, {
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
    // Step 1: open an SSE connection to create a session
    const sseController = new AbortController();
    const sseRes = await fetch(`${baseUrl}/sse`, {
      headers: { Authorization: "Bearer sk_alice" },
      signal: sseController.signal,
    });
    expect(sseRes.status).toBe(200);

    // Step 2: extract the session ID from the mock transport
    const { SSEServerTransport } = await import("@modelcontextprotocol/sdk/server/sse.js");
    const transportInstance = vi.mocked(SSEServerTransport).mock.results[
      vi.mocked(SSEServerTransport).mock.results.length - 1
    ].value as { sessionId: string };
    const sessionId = transportInstance.sessionId;

    // Step 3: post a message to that session
    const msgRes = await fetch(`${baseUrl}/message`, {
      method: "POST",
      headers: {
        Authorization: "Bearer sk_alice",
        "Content-Type": "application/json",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({ method: "ping" }),
    });

    expect(msgRes.status).toBe(200);
    const body = await msgRes.json();
    expect(body.handled).toBe(true);

    sseController.abort();
    await sseRes.body?.cancel().catch(() => {});
  });

  it("returns 403 when a different user's API key is used for an existing session", async () => {
    // Open SSE as alice
    const sseController = new AbortController();
    const sseRes = await fetch(`${baseUrl}/sse`, {
      headers: { Authorization: "Bearer sk_alice" },
      signal: sseController.signal,
    });
    expect(sseRes.status).toBe(200);

    const { SSEServerTransport } = await import("@modelcontextprotocol/sdk/server/sse.js");
    const transportInstance = vi.mocked(SSEServerTransport).mock.results[
      vi.mocked(SSEServerTransport).mock.results.length - 1
    ].value as { sessionId: string };
    const sessionId = transportInstance.sessionId;

    // Try to send a message as bob using alice's session ID
    const msgRes = await fetch(`${baseUrl}/message`, {
      method: "POST",
      headers: {
        Authorization: "Bearer sk_bob", // bob's key
        "Content-Type": "application/json",
        "mcp-session-id": sessionId,    // alice's session
      },
      body: JSON.stringify({}),
    });

    expect(msgRes.status).toBe(403);
    const body = await msgRes.json();
    expect(body.error).toContain("different user");

    sseController.abort();
    await sseRes.body?.cancel().catch(() => {});
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
