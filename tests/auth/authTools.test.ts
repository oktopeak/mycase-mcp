import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerAuthTools } from "../../src/auth/authTools.js";
import { createMockServer, parseResult, MOCK_TOKENS } from "../helpers.js";
import { runWithUserId } from "../../src/context.js";

vi.mock("../../src/auth/oauth.js", () => ({
  runOAuthFlow: vi.fn(),
}));
vi.mock("../../src/auth/token-store.js", () => ({
  loadTokens: vi.fn(),
  clearTokens: vi.fn(),
  clearEncryptionKey: vi.fn(),
}));
vi.mock("../../src/audit/logger.js", () => ({ auditLog: vi.fn() }));

import { runOAuthFlow } from "../../src/auth/oauth.js";
import { loadTokens, clearTokens, clearEncryptionKey } from "../../src/auth/token-store.js";

// ── authenticate — stdio mode ────────────────────────────────────────────────

describe("authenticate (stdio mode)", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerAuthTools(mock.server);
  });

  it("runs OAuth flow and returns success with firm_uuid", async () => {
    vi.mocked(runOAuthFlow).mockResolvedValue(undefined);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);

    const result = await mock.call("authenticate", {});
    const data = parseResult(result);

    expect(data.success).toBe(true);
    expect(data.firm_uuid).toBe("firm-123");
    expect(runOAuthFlow).toHaveBeenCalledOnce();
    // stdio mode: called without serverMode option
    expect(vi.mocked(runOAuthFlow).mock.calls[0][0]).toBeUndefined();
  });

  it("returns isError when OAuth flow fails", async () => {
    vi.mocked(runOAuthFlow).mockRejectedValue(new Error("Browser failed to open"));

    const result = await mock.call("authenticate", {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Authentication failed");
  });
});

// ── authenticate — HTTP mode ────────────────────────────────────────────────

describe("authenticate (HTTP mode)", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerAuthTools(mock.server);
  });

  it("returns authorization_url and action_required when called in HTTP context", async () => {
    const authUrl = "https://auth.mycase.com/login_sessions/new?state=abc&client_id=x";
    vi.mocked(runOAuthFlow).mockResolvedValue(authUrl);

    const result = await runWithUserId("alice@firm.com", () =>
      mock.call("authenticate", {})
    );
    const data = parseResult(result);

    expect(data.action_required).toBe(true);
    expect(data.authorization_url).toBe(authUrl);
    expect(data.message).toContain("browser");
  });

  it("calls runOAuthFlow with { serverMode: true } in HTTP mode", async () => {
    vi.mocked(runOAuthFlow).mockResolvedValue("https://auth.mycase.com/...");

    await runWithUserId("alice@firm.com", () => mock.call("authenticate", {}));

    expect(runOAuthFlow).toHaveBeenCalledWith({ serverMode: true });
  });

  it("does not call loadTokens in HTTP mode (returns URL immediately)", async () => {
    vi.mocked(runOAuthFlow).mockResolvedValue("https://auth.mycase.com/...");

    await runWithUserId("alice@firm.com", () => mock.call("authenticate", {}));

    // loadTokens is only called in stdio mode to report firm_uuid after auth
    expect(loadTokens).not.toHaveBeenCalled();
  });

  it("returns isError if runOAuthFlow throws in HTTP mode", async () => {
    vi.mocked(runOAuthFlow).mockRejectedValue(new Error("MYCASE_HTTP_BASE_URL must be set"));

    const result = await runWithUserId("alice@firm.com", () =>
      mock.call("authenticate", {})
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Authentication failed");
  });

  it("result is not isError on success in HTTP mode", async () => {
    vi.mocked(runOAuthFlow).mockResolvedValue("https://auth.mycase.com/...");

    const result = await runWithUserId("alice@firm.com", () =>
      mock.call("authenticate", {})
    );

    expect(result.isError).toBeUndefined();
  });
});

// ── auth-status ──────────────────────────────────────────────────────────────

describe("auth-status", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerAuthTools(mock.server);
  });

  it("returns authenticated=true with expiry when token exists", async () => {
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);

    const result = await mock.call("auth-status", {});
    const data = parseResult(result);

    expect(data.authenticated).toBe(true);
    expect(data.is_expired).toBe(false);
    expect(typeof data.expires_at).toBe("string");
  });

  it("returns authenticated=false when no token", async () => {
    vi.mocked(loadTokens).mockResolvedValue(null);

    const result = await mock.call("auth-status", {});
    const data = parseResult(result);

    expect(data.authenticated).toBe(false);
  });

  it("reports is_expired=true for an expired token", async () => {
    vi.mocked(loadTokens).mockResolvedValue({
      ...MOCK_TOKENS,
      expires_at: Date.now() - 1000,
    });

    const result = await mock.call("auth-status", {});
    const data = parseResult(result);

    expect(data.is_expired).toBe(true);
  });

  it("works the same in HTTP mode (reads per-user tokens via context)", async () => {
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);

    const result = await runWithUserId("alice@firm.com", () =>
      mock.call("auth-status", {})
    );
    const data = parseResult(result);

    expect(data.authenticated).toBe(true);
    expect(data.firm_uuid).toBe("firm-123");
  });
});

// ── logout ───────────────────────────────────────────────────────────────────

describe("logout", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerAuthTools(mock.server);
  });

  it("clears tokens and returns success", async () => {
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
    vi.mocked(clearTokens).mockResolvedValue(undefined);

    const result = await mock.call("logout", {});
    const data = parseResult(result);

    expect(data.success).toBe(true);
    expect(clearTokens).toHaveBeenCalledOnce();
    expect(clearEncryptionKey).toHaveBeenCalledOnce();
  });

  it("returns isError if clearTokens throws", async () => {
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
    vi.mocked(clearTokens).mockRejectedValue(new Error("Permission denied"));

    const result = await mock.call("logout", {});

    expect(result.isError).toBe(true);
  });

  it("logout in HTTP mode clears only current user's context (via mocked store)", async () => {
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
    vi.mocked(clearTokens).mockResolvedValue(undefined);

    const result = await runWithUserId("alice@firm.com", () =>
      mock.call("logout", {})
    );
    const data = parseResult(result);

    expect(data.success).toBe(true);
    // The per-user path resolution is tested in token-store-per-user.test.ts;
    // here we just confirm the tool delegates correctly.
    expect(clearTokens).toHaveBeenCalledOnce();
  });
});
