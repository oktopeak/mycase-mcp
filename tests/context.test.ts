import { describe, it, expect } from "vitest";
import { getCurrentUserId, runWithUserId } from "../src/context.js";

describe("getCurrentUserId", () => {
  it("returns 'stdio' when no context is active", () => {
    expect(getCurrentUserId()).toBe("stdio");
  });

  it("returns the userId set by runWithUserId", async () => {
    const id = await runWithUserId("alice@firm.com", async () => getCurrentUserId());
    expect(id).toBe("alice@firm.com");
  });

  it("restores 'stdio' after runWithUserId completes", async () => {
    await runWithUserId("alice@firm.com", async () => {});
    expect(getCurrentUserId()).toBe("stdio");
  });

  it("nested runWithUserId: inner context wins", async () => {
    const outer = await runWithUserId("alice@firm.com", async () => {
      const inner = await runWithUserId("bob@firm.com", async () => getCurrentUserId());
      return { inner, outer: getCurrentUserId() };
    });
    expect(outer.inner).toBe("bob@firm.com");
    expect(outer.outer).toBe("alice@firm.com");
  });

  it("concurrent runWithUserId calls are isolated from each other", async () => {
    const [id1, id2] = await Promise.all([
      runWithUserId("alice@firm.com", async () => {
        await new Promise((r) => setTimeout(r, 20));
        return getCurrentUserId();
      }),
      runWithUserId("bob@firm.com", async () => {
        await new Promise((r) => setTimeout(r, 10));
        return getCurrentUserId();
      }),
    ]);

    expect(id1).toBe("alice@firm.com");
    expect(id2).toBe("bob@firm.com");
  });

  it("outer context is not polluted by concurrent inner contexts", async () => {
    const outer = getCurrentUserId(); // 'stdio'

    await Promise.all([
      runWithUserId("alice@firm.com", async () => {
        await new Promise((r) => setTimeout(r, 10));
      }),
      runWithUserId("bob@firm.com", async () => {
        await new Promise((r) => setTimeout(r, 5));
      }),
    ]);

    expect(getCurrentUserId()).toBe(outer);
  });
});
