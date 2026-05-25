import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * api-keys.ts has module-level state (keyList). We use vi.resetModules() and
 * dynamic imports so each test group gets a fresh module with keyList = null.
 */

vi.mock("fs/promises", () => ({
  default: {
    readFile: vi.fn(),
  },
}));

// Import fs so we can configure its mock in each test
import fs from "fs/promises";

describe("loadApiKeys — env var source (MYCASE_HTTP_API_KEYS)", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.MYCASE_HTTP_API_KEYS;
    delete process.env.MYCASE_API_KEYS_FILE;
  });

  it("loads users from a comma-separated env var", async () => {
    process.env.MYCASE_HTTP_API_KEYS = "alice@firm.com:sk_alice,bob@firm.com:sk_bob";
    vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

    const { loadApiKeys, resolveUserId } = await import("../../src/http/api-keys.js");
    await loadApiKeys();

    expect(resolveUserId("sk_alice")).toBe("alice@firm.com");
    expect(resolveUserId("sk_bob")).toBe("bob@firm.com");
  });

  it("ignores malformed pairs (no colon, empty parts)", async () => {
    process.env.MYCASE_HTTP_API_KEYS = "bad-pair,alice@firm.com:sk_alice,:no-user,no-key:";
    vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

    const { loadApiKeys, resolveUserId } = await import("../../src/http/api-keys.js");
    await loadApiKeys();

    expect(resolveUserId("sk_alice")).toBe("alice@firm.com");
    // malformed entries should not throw — just silently skipped
  });

  it("resolveUserId returns undefined for unknown keys", async () => {
    process.env.MYCASE_HTTP_API_KEYS = "alice@firm.com:sk_alice";
    vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

    const { loadApiKeys, resolveUserId } = await import("../../src/http/api-keys.js");
    await loadApiKeys();

    expect(resolveUserId("sk_unknown")).toBeUndefined();
  });
});

describe("loadApiKeys — JSON file source", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.MYCASE_HTTP_API_KEYS;
    delete process.env.MYCASE_API_KEYS_FILE;
  });

  it("loads users from the JSON file when env var is absent", async () => {
    vi.mocked(fs.readFile).mockResolvedValue(
      JSON.stringify({ keys: { sk_alice: "alice@firm.com", sk_bob: "bob@firm.com" } })
    );

    const { loadApiKeys, resolveUserId } = await import("../../src/http/api-keys.js");
    await loadApiKeys();

    expect(resolveUserId("sk_alice")).toBe("alice@firm.com");
    expect(resolveUserId("sk_bob")).toBe("bob@firm.com");
  });

  it("reads from MYCASE_API_KEYS_FILE path when set", async () => {
    process.env.MYCASE_API_KEYS_FILE = "/custom/path/keys.json";
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ keys: { sk_custom: "custom@firm.com" } }));

    const { loadApiKeys, resolveUserId } = await import("../../src/http/api-keys.js");
    await loadApiKeys();

    // Verify readFile was called with the custom path (no encoding arg — we read raw bytes for BOM detection)
    expect(vi.mocked(fs.readFile)).toHaveBeenCalledWith("/custom/path/keys.json");
    expect(resolveUserId("sk_custom")).toBe("custom@firm.com");

    delete process.env.MYCASE_API_KEYS_FILE;
  });

  it("merges env var keys and JSON file keys", async () => {
    process.env.MYCASE_HTTP_API_KEYS = "carol@firm.com:sk_carol";
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ keys: { sk_alice: "alice@firm.com" } }));

    const { loadApiKeys, resolveUserId } = await import("../../src/http/api-keys.js");
    await loadApiKeys();

    expect(resolveUserId("sk_carol")).toBe("carol@firm.com");
    expect(resolveUserId("sk_alice")).toBe("alice@firm.com");

    delete process.env.MYCASE_HTTP_API_KEYS;
  });

  it("silently ignores a missing JSON file (ENOENT) when env var provides keys", async () => {
    process.env.MYCASE_HTTP_API_KEYS = "alice@firm.com:sk_alice";
    vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

    const { loadApiKeys, resolveUserId } = await import("../../src/http/api-keys.js");
    await expect(loadApiKeys()).resolves.toBeUndefined();
    expect(resolveUserId("sk_alice")).toBe("alice@firm.com");

    delete process.env.MYCASE_HTTP_API_KEYS;
  });

  it("throws when JSON file has a non-ENOENT read error", async () => {
    vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error("Permission denied"), { code: "EACCES" }));

    const { loadApiKeys } = await import("../../src/http/api-keys.js");
    await expect(loadApiKeys()).rejects.toThrow("Permission denied");
  });

  it("throws with a helpful message when no keys are found anywhere", async () => {
    vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

    const { loadApiKeys } = await import("../../src/http/api-keys.js");
    await expect(loadApiKeys()).rejects.toThrow("No API keys configured");
  });

  it("throws when JSON file is valid JSON but has no keys object", async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ other: "stuff" }));

    const { loadApiKeys } = await import("../../src/http/api-keys.js");
    await expect(loadApiKeys()).rejects.toThrow("No API keys configured");
  });

  it("skips entries where userId is not a string", async () => {
    vi.mocked(fs.readFile).mockResolvedValue(
      JSON.stringify({ keys: { sk_bad: 123, sk_good: "alice@firm.com" } })
    );

    const { loadApiKeys, resolveUserId } = await import("../../src/http/api-keys.js");
    await loadApiKeys();

    expect(resolveUserId("sk_good")).toBe("alice@firm.com");
    expect(resolveUserId("sk_bad")).toBeUndefined();
  });
});

describe("resolveUserId — before loadApiKeys", () => {
  beforeEach(() => vi.resetModules());

  it("returns undefined when called before loadApiKeys (keyList is null)", async () => {
    const { resolveUserId } = await import("../../src/http/api-keys.js");
    expect(resolveUserId("any-key")).toBeUndefined();
  });
});

describe("loadApiKeys — idempotency", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.MYCASE_HTTP_API_KEYS;
  });

  afterEach(() => {
    delete process.env.MYCASE_HTTP_API_KEYS;
  });

  it("calling loadApiKeys twice is a no-op (second call does not overwrite first)", async () => {
    process.env.MYCASE_HTTP_API_KEYS = "alice@firm.com:sk_alice";
    vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

    const { loadApiKeys, resolveUserId } = await import("../../src/http/api-keys.js");
    await loadApiKeys();

    // Change the env var — a non-idempotent second call would pick it up.
    process.env.MYCASE_HTTP_API_KEYS = "bob@firm.com:sk_bob";
    await loadApiKeys(); // should be a no-op

    // First call's data should still be in effect.
    expect(resolveUserId("sk_alice")).toBe("alice@firm.com");
    // The second env var should NOT have been loaded.
    expect(resolveUserId("sk_bob")).toBeUndefined();
  });
});
