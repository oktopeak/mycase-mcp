import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerPendingState, consumePendingState } from "../../src/http/oauth-callbacks.js";

const ENTRY = {
  userId: "alice@firm.com",
  clientId: "client-id",
  clientSecret: "client-secret",
  redirectUri: "https://mycase-mcp.lawfirm.com/oauth/callback",
};

describe("registerPendingState / consumePendingState", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("consumePendingState returns the registered entry and removes it", () => {
    registerPendingState("state-abc", ENTRY);

    const result = consumePendingState("state-abc");

    expect(result).toEqual(ENTRY);
    // Consuming again should return undefined (removed after first consume).
    expect(consumePendingState("state-abc")).toBeUndefined();
  });

  it("consumePendingState returns undefined for an unknown state", () => {
    expect(consumePendingState("state-does-not-exist")).toBeUndefined();
  });

  it("different states are stored independently", () => {
    const entryAlice = { ...ENTRY, userId: "alice@firm.com" };
    const entryBob = { ...ENTRY, userId: "bob@firm.com" };

    registerPendingState("state-alice", entryAlice);
    registerPendingState("state-bob", entryBob);

    expect(consumePendingState("state-alice")?.userId).toBe("alice@firm.com");
    expect(consumePendingState("state-bob")?.userId).toBe("bob@firm.com");
  });

  it("entry is automatically removed after 10 minutes", () => {
    registerPendingState("state-expiring", ENTRY);

    // Advance time by 10 minutes (the auto-expiry timeout)
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);

    expect(consumePendingState("state-expiring")).toBeUndefined();
  });

  it("entry is still available before the 10 minute expiry", () => {
    registerPendingState("state-fresh", ENTRY);

    vi.advanceTimersByTime(9 * 60 * 1000); // 9 min — not yet expired

    expect(consumePendingState("state-fresh")).toEqual(ENTRY);
  });

  it("consuming once prevents a second consume (not a replay attack surface)", () => {
    registerPendingState("state-once", ENTRY);

    const first = consumePendingState("state-once");
    const second = consumePendingState("state-once");

    expect(first).toEqual(ENTRY);
    expect(second).toBeUndefined();
  });

  it("stores all required fields (userId, clientId, clientSecret, redirectUri)", () => {
    registerPendingState("state-fields", ENTRY);

    const result = consumePendingState("state-fields")!;
    expect(result.userId).toBe(ENTRY.userId);
    expect(result.clientId).toBe(ENTRY.clientId);
    expect(result.clientSecret).toBe(ENTRY.clientSecret);
    expect(result.redirectUri).toBe(ENTRY.redirectUri);
  });
});
