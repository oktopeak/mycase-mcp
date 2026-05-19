import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted runs before vi.mock factories and module imports,
// so mockEntry is in scope when the Entry constructor is called.
const mockEntry = vi.hoisted(() => ({
  getPassword: vi.fn(),
  setPassword: vi.fn(),
  deletePassword: vi.fn(),
}));

vi.mock("@napi-rs/keyring", () => ({
  Entry: vi.fn().mockImplementation(() => mockEntry),
}));

vi.mock("fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    // Token file not found by default — most tests don't need a real file.
    readFile: vi.fn().mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    ),
    writeFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ size: 0 }),
    appendFile: vi.fn().mockResolvedValue(undefined),
  },
}));

import { initEncryptionKey, clearEncryptionKey, loadTokens } from "../../src/auth/token-store.js";

// @napi-rs/keyring Entry methods are synchronous — use mockReturnValue throughout.

describe("token-store — encryption key management", () => {
  beforeEach(() => {
    clearEncryptionKey(); // reset the module-level key cache before clearing mock history
    vi.clearAllMocks();
    delete process.env.ENCRYPTION_KEY;
  });

  // ── keychain-only paths ──────────────────────────────────────────────────

  it("uses an existing key from the keychain without calling setPassword", async () => {
    mockEntry.getPassword.mockReturnValue("a".repeat(64));

    await initEncryptionKey();

    expect(mockEntry.getPassword).toHaveBeenCalledOnce();
    expect(mockEntry.setPassword).not.toHaveBeenCalled();
  });

  it("generates and stores a new 64-char hex key when the keychain is empty", async () => {
    mockEntry.getPassword.mockReturnValue(null);

    await initEncryptionKey();

    expect(mockEntry.setPassword).toHaveBeenCalledOnce();
    const [storedKey] = mockEntry.setPassword.mock.calls[0] as [string];
    expect(storedKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("throws an actionable error when the keychain is unavailable and no env var is set", async () => {
    mockEntry.getPassword.mockImplementation(() => { throw new Error("dbus connection failed"); });

    await expect(initEncryptionKey()).rejects.toThrow(/Keychain unavailable.*ENCRYPTION_KEY/);
  });

  // ── env-var (CI / headless) paths ────────────────────────────────────────

  it("uses ENCRYPTION_KEY directly and migrates it to the keychain on first run", async () => {
    const key = "b".repeat(64);
    process.env.ENCRYPTION_KEY = key;
    mockEntry.getPassword.mockReturnValue(null);

    await initEncryptionKey();

    expect(mockEntry.setPassword).toHaveBeenCalledWith(key);
  });

  it("skips keychain migration when the env key is already stored", async () => {
    const key = "c".repeat(64);
    process.env.ENCRYPTION_KEY = key;
    mockEntry.getPassword.mockReturnValue(key);

    await initEncryptionKey();

    expect(mockEntry.setPassword).not.toHaveBeenCalled();
  });

  it("succeeds with ENCRYPTION_KEY even when the keychain throws (headless/CI)", async () => {
    process.env.ENCRYPTION_KEY = "d".repeat(64);
    mockEntry.getPassword.mockImplementation(() => { throw new Error("no secret service"); });

    await expect(initEncryptionKey()).resolves.toBeUndefined();
    expect(mockEntry.setPassword).not.toHaveBeenCalled();
  });

  it("rejects an ENCRYPTION_KEY that is not 64 hex characters", async () => {
    process.env.ENCRYPTION_KEY = "tooshort";

    await expect(initEncryptionKey()).rejects.toThrow("64 hex characters");
  });

  // ── clearEncryptionKey ───────────────────────────────────────────────────

  it("clearEncryptionKey calls deletePassword on the keychain entry", () => {
    mockEntry.deletePassword.mockReturnValue(true);

    clearEncryptionKey();

    expect(mockEntry.deletePassword).toHaveBeenCalledOnce();
  });

  it("clearEncryptionKey flushes the in-memory cache so the next call re-reads the keychain", async () => {
    const firstKey = "f".repeat(64);
    const secondKey = "a".repeat(64);
    mockEntry.getPassword.mockReturnValueOnce(firstKey).mockReturnValueOnce(secondKey);

    await initEncryptionKey();
    clearEncryptionKey();
    await initEncryptionKey();

    expect(mockEntry.getPassword).toHaveBeenCalledTimes(2);
  });

  // ── loadTokens ───────────────────────────────────────────────────────────

  it("loadTokens returns null when the token file does not exist", async () => {
    mockEntry.getPassword.mockReturnValue("e".repeat(64));

    const result = await loadTokens();

    expect(result).toBeNull();
  });
});
