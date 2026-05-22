/**
 * Per-user namespacing tests for the token store.
 * The original token-store.test.ts covers the stdio (single-user) path;
 * this file covers the HTTP-mode per-user paths.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockEntryInstances: Map<string, ReturnType<typeof makeMockEntry>> = new Map();

function makeMockEntry() {
  return {
    getPassword: vi.fn(),
    setPassword: vi.fn(),
    deletePassword: vi.fn(),
  };
}

vi.mock("@napi-rs/keyring", () => ({
  // Must use `function` keyword — arrow functions cannot be used as constructors.
  Entry: vi.fn().mockImplementation(function (_service: string, account: string) {
    if (!mockEntryInstances.has(account)) {
      mockEntryInstances.set(account, makeMockEntry());
    }
    return mockEntryInstances.get(account)!;
  }),
}));

vi.mock("fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    ),
    writeFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ size: 0 }),
    appendFile: vi.fn().mockResolvedValue(undefined),
  },
}));

import path from "path";
import os from "os";
import { Entry } from "@napi-rs/keyring";
import { clearEncryptionKey, initEncryptionKey, saveTokens, loadTokens, clearTokens } from "../../src/auth/token-store.js";
import { runWithUserId } from "../../src/context.js";
import type { MyCaseTokens } from "../../src/auth/oauth.js";

const MOCK_TOKENS: MyCaseTokens = {
  access_token: "tok",
  refresh_token: "ref",
  expires_at: Date.now() + 86400_000,
  firm_uuid: "firm-123",
};

function getEntryFor(account: string) {
  return mockEntryInstances.get(account) ?? makeMockEntry();
}

beforeEach(async () => {
  // Clear the in-module keyCache for every userId that may have been populated
  // by previous tests in this file. Must run BEFORE clearing mock instances so
  // the Entry constructor mock still works for the deletePassword() calls.
  clearEncryptionKey(); // stdio context
  await runWithUserId("alice@firm.com", async () => { clearEncryptionKey(); });
  await runWithUserId("bob@firm.com", async () => { clearEncryptionKey(); });

  mockEntryInstances.clear();
  vi.clearAllMocks();
  delete process.env.ENCRYPTION_KEY;
});

describe("keychain account naming", () => {
  it("uses 'encryption-key' account in stdio mode", async () => {
    const mockEntry = makeMockEntry();
    mockEntryInstances.set("encryption-key", mockEntry);
    mockEntry.getPassword.mockReturnValue("a".repeat(64));

    await initEncryptionKey(); // stdio context (no runWithUserId)

    const constructorCalls = vi.mocked(Entry).mock.calls;
    expect(constructorCalls.some(([, acct]) => acct === "encryption-key")).toBe(true);
  });

  it("uses 'encryption-key:<userId>' account in HTTP mode", async () => {
    const account = "encryption-key:alice@firm.com";
    const mockEntry = makeMockEntry();
    mockEntryInstances.set(account, mockEntry);
    mockEntry.getPassword.mockReturnValue("b".repeat(64));

    await runWithUserId("alice@firm.com", () => initEncryptionKey());

    const constructorCalls = vi.mocked(Entry).mock.calls;
    expect(constructorCalls.some(([, acct]) => acct === account)).toBe(true);
  });

  it("different users get different keychain accounts", async () => {
    const aliceAccount = "encryption-key:alice@firm.com";
    const bobAccount = "encryption-key:bob@firm.com";

    const aliceEntry = makeMockEntry();
    const bobEntry = makeMockEntry();
    mockEntryInstances.set(aliceAccount, aliceEntry);
    mockEntryInstances.set(bobAccount, bobEntry);
    aliceEntry.getPassword.mockReturnValue("a".repeat(64));
    bobEntry.getPassword.mockReturnValue("b".repeat(64));

    await runWithUserId("alice@firm.com", () => initEncryptionKey());

    // Bob hasn't initialized yet — alice's entry was used
    expect(aliceEntry.getPassword).toHaveBeenCalled();
    expect(bobEntry.getPassword).not.toHaveBeenCalled();
  });

  it("clearEncryptionKey in HTTP mode only deletes the current user's keychain entry", async () => {
    const aliceAccount = "encryption-key:alice@firm.com";
    const bobAccount = "encryption-key:bob@firm.com";
    const aliceEntry = makeMockEntry();
    const bobEntry = makeMockEntry();
    mockEntryInstances.set(aliceAccount, aliceEntry);
    mockEntryInstances.set(bobAccount, bobEntry);
    aliceEntry.getPassword.mockReturnValue("a".repeat(64));
    bobEntry.getPassword.mockReturnValue("b".repeat(64));

    await runWithUserId("alice@firm.com", () => initEncryptionKey());
    await runWithUserId("alice@firm.com", () => { clearEncryptionKey(); return Promise.resolve(); });

    expect(aliceEntry.deletePassword).toHaveBeenCalledOnce();
    expect(bobEntry.deletePassword).not.toHaveBeenCalled();
  });
});

describe("token file paths", () => {
  it("saveTokens in stdio mode writes to the root tokens.enc path", async () => {
    const fs = (await import("fs/promises")).default;
    const aliceAccount = "encryption-key";
    const mockEntry = makeMockEntry();
    mockEntryInstances.set(aliceAccount, mockEntry);
    mockEntry.getPassword.mockReturnValue("a".repeat(64));

    await saveTokens(MOCK_TOKENS);

    const writePath = vi.mocked(fs.writeFile).mock.calls[0][0] as string;
    const expectedDir = path.join(os.homedir(), ".oktopeak-mycase");
    expect(writePath).toBe(path.join(expectedDir, "tokens.enc"));
  });

  it("saveTokens in HTTP mode writes under users/<userId>/tokens.enc", async () => {
    const fs = (await import("fs/promises")).default;
    const account = "encryption-key:alice@firm.com";
    const mockEntry = makeMockEntry();
    mockEntryInstances.set(account, mockEntry);
    mockEntry.getPassword.mockReturnValue("a".repeat(64));

    await runWithUserId("alice@firm.com", () => saveTokens(MOCK_TOKENS));

    const writePath = vi.mocked(fs.writeFile).mock.calls[0][0] as string;
    const expectedBase = path.join(os.homedir(), ".oktopeak-mycase", "users", "alice@firm.com");
    expect(writePath).toBe(path.join(expectedBase, "tokens.enc"));
  });

  it("different users write to different paths", async () => {
    const fs = (await import("fs/promises")).default;
    for (const userId of ["alice@firm.com", "bob@firm.com"]) {
      const account = `encryption-key:${userId}`;
      const mockEntry = makeMockEntry();
      mockEntryInstances.set(account, mockEntry);
      mockEntry.getPassword.mockReturnValue("a".repeat(64));
    }

    await runWithUserId("alice@firm.com", () => saveTokens(MOCK_TOKENS));
    await runWithUserId("bob@firm.com", () => saveTokens(MOCK_TOKENS));

    const paths = vi.mocked(fs.writeFile).mock.calls.map((c) => c[0] as string);
    expect(paths[0]).toContain("alice@firm.com");
    expect(paths[1]).toContain("bob@firm.com");
    expect(paths[0]).not.toBe(paths[1]);
  });

  it("loadTokens in HTTP mode reads from the correct per-user path", async () => {
    const fs = (await import("fs/promises")).default;
    const account = "encryption-key:alice@firm.com";
    const mockEntry = makeMockEntry();
    mockEntryInstances.set(account, mockEntry);
    mockEntry.getPassword.mockReturnValue("a".repeat(64));

    // File not found is fine — we just want to verify the path being read
    await runWithUserId("alice@firm.com", () => loadTokens());

    const readPath = vi.mocked(fs.readFile).mock.calls[0][0] as string;
    expect(readPath).toContain(path.join("users", "alice@firm.com", "tokens.enc"));
  });

  it("clearTokens in HTTP mode deletes the per-user token file", async () => {
    const fs = (await import("fs/promises")).default;
    vi.mocked(fs.unlink).mockResolvedValue(undefined);

    await runWithUserId("alice@firm.com", () => clearTokens());

    const unlinkPath = vi.mocked(fs.unlink).mock.calls[0][0] as string;
    expect(unlinkPath).toContain(path.join("users", "alice@firm.com", "tokens.enc"));
  });
});
