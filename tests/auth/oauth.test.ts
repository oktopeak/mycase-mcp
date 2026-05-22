import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/auth/token-store.js", () => ({
  loadTokens: vi.fn(),
  saveTokens: vi.fn().mockResolvedValue(undefined),
  clearTokens: vi.fn(),
}));

vi.mock("../../src/http/oauth-callbacks.js", () => ({
  registerPendingState: vi.fn(),
}));

vi.mock("open", () => ({ default: vi.fn().mockResolvedValue(undefined) }));

import { loadTokens, saveTokens } from "../../src/auth/token-store.js";
import { registerPendingState } from "../../src/http/oauth-callbacks.js";
import { runOAuthFlow, refreshAccessToken } from "../../src/auth/oauth.js";
import { runWithUserId } from "../../src/context.js";

const MOCK_TOKENS = {
  access_token: "new-access",
  refresh_token: "new-refresh",
  expires_at: Date.now() + 86400_000,
  firm_uuid: "firm-xyz",
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MYCASE_CLIENT_ID = "client-id";
  process.env.MYCASE_CLIENT_SECRET = "client-secret";
  process.env.MYCASE_HTTP_BASE_URL = "https://mycase-mcp.lawfirm.com";
});

afterEach(() => {
  delete process.env.MYCASE_CLIENT_ID;
  delete process.env.MYCASE_CLIENT_SECRET;
  delete process.env.MYCASE_HTTP_BASE_URL;
});

describe("runOAuthFlow — HTTP server mode", () => {
  it("returns the MyCase authorization URL as a string", async () => {
    const result = await runWithUserId("alice@firm.com", () =>
      runOAuthFlow({ serverMode: true })
    );

    expect(typeof result).toBe("string");
    expect(result as string).toContain("auth.mycase.com");
    expect(result as string).toContain("client-id");
    expect(result as string).toContain("response_type=code");
  });

  it("includes the server redirect URI in the auth URL", async () => {
    const result = await runWithUserId("alice@firm.com", () =>
      runOAuthFlow({ serverMode: true })
    );

    expect(result as string).toContain(
      encodeURIComponent("https://mycase-mcp.lawfirm.com/oauth/callback")
    );
  });

  it("registers a pending state entry with the correct userId", async () => {
    await runWithUserId("alice@firm.com", () =>
      runOAuthFlow({ serverMode: true })
    );

    expect(registerPendingState).toHaveBeenCalledOnce();
    const [state, entry] = vi.mocked(registerPendingState).mock.calls[0];
    expect(typeof state).toBe("string");
    expect(state).toHaveLength(32); // 16 random bytes as hex
    expect(entry.userId).toBe("alice@firm.com");
    expect(entry.clientId).toBe("client-id");
    expect(entry.clientSecret).toBe("client-secret");
    expect(entry.redirectUri).toBe("https://mycase-mcp.lawfirm.com/oauth/callback");
  });

  it("uses the state in the URL that was passed to registerPendingState", async () => {
    const result = await runWithUserId("alice@firm.com", () =>
      runOAuthFlow({ serverMode: true })
    );

    const [registeredState] = vi.mocked(registerPendingState).mock.calls[0];
    expect(result as string).toContain(`state=${registeredState}`);
  });

  it("throws when MYCASE_HTTP_BASE_URL is not set", async () => {
    delete process.env.MYCASE_HTTP_BASE_URL;

    await expect(
      runWithUserId("alice@firm.com", () => runOAuthFlow({ serverMode: true }))
    ).rejects.toThrow("MYCASE_HTTP_BASE_URL");
  });

  it("throws when MYCASE_CLIENT_ID is not set", async () => {
    delete process.env.MYCASE_CLIENT_ID;

    await expect(
      runWithUserId("alice@firm.com", () => runOAuthFlow({ serverMode: true }))
    ).rejects.toThrow("MYCASE_CLIENT_ID");
  });

  it("does not open a browser in server mode", async () => {
    const { default: open } = await import("open");

    await runWithUserId("alice@firm.com", () => runOAuthFlow({ serverMode: true }));

    expect(open).not.toHaveBeenCalled();
  });
});

describe("refreshAccessToken — per-user deduplication", () => {
  it("concurrent refreshes for the same user share one inflight promise", async () => {
    let resolveRefresh!: () => void;
    const refreshBarrier = new Promise<void>((r) => { resolveRefresh = r; });

    let callCount = 0;
    vi.mocked(loadTokens).mockResolvedValue({
      access_token: "old",
      refresh_token: "refresh-tok",
      expires_at: Date.now() - 1,
    });

    // Mock fetch to count calls
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      callCount++;
      await refreshBarrier;
      return new Response(JSON.stringify({ access_token: "new", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const [t1, t2] = await runWithUserId("alice@firm.com", async () => {
      const p1 = refreshAccessToken();
      const p2 = refreshAccessToken();
      resolveRefresh();
      return Promise.all([p1, p2]);
    });

    // Both should get the same token from the single fetch call
    expect(callCount).toBe(1);
    expect(t1.access_token).toBe("new");
    expect(t2.access_token).toBe("new");

    fetchSpy.mockRestore();
  });

  it("different users get independent refresh promises", async () => {
    vi.mocked(loadTokens).mockResolvedValue({
      access_token: "old",
      refresh_token: "refresh-tok",
      expires_at: Date.now() - 1,
    });

    let aliceCallCount = 0;
    let bobCallCount = 0;

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      // We can't distinguish which user is calling here in a real scenario,
      // so just count total calls — both should trigger independently.
      return new Response(JSON.stringify({ access_token: "new", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await Promise.all([
      runWithUserId("alice@firm.com", () => refreshAccessToken()).then(() => { aliceCallCount++; }),
      runWithUserId("bob@firm.com", () => refreshAccessToken()).then(() => { bobCallCount++; }),
    ]);

    // Both completed independently
    expect(aliceCallCount).toBe(1);
    expect(bobCallCount).toBe(1);
    // Two separate fetches (one per user)
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    fetchSpy.mockRestore();
  });

  it("throws when no refresh token is stored", async () => {
    vi.mocked(loadTokens).mockResolvedValue(null);

    await expect(
      runWithUserId("alice@firm.com", () => refreshAccessToken())
    ).rejects.toThrow("No refresh token available");
  });

  it("throws and surfaces HTTP status when refresh endpoint fails", async () => {
    vi.mocked(loadTokens).mockResolvedValue({
      access_token: "old",
      refresh_token: "bad-refresh",
      expires_at: Date.now() - 1,
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Unauthorized", { status: 401 })
    );

    await expect(
      runWithUserId("alice@firm.com", () => refreshAccessToken())
    ).rejects.toThrow("401");

    fetchSpy.mockRestore();
  });
});
