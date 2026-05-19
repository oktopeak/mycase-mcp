import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerAuthTools } from "../../src/auth/authTools.js";
import { createMockServer, parseResult, MOCK_TOKENS } from "../helpers.js";

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
import { loadTokens, clearTokens } from "../../src/auth/token-store.js";

describe("authenticate", () => {
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
  });

  it("returns isError when OAuth flow fails", async () => {
    vi.mocked(runOAuthFlow).mockRejectedValue(new Error("Browser failed to open"));

    const result = await mock.call("authenticate", {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Authentication failed");
  });
});

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
});

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
  });

  it("returns isError if clearTokens throws", async () => {
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
    vi.mocked(clearTokens).mockRejectedValue(new Error("Permission denied"));

    const result = await mock.call("logout", {});

    expect(result.isError).toBe(true);
  });
});
