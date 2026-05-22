import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ size: 0 }),
    appendFile: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
  },
}));

import fs from "fs/promises";
import { auditLog } from "../../src/audit/logger.js";
import { runWithUserId } from "../../src/context.js";

function lastLoggedEntry(): Record<string, unknown> {
  const calls = vi.mocked(fs.appendFile).mock.calls;
  const lastLine = calls[calls.length - 1][1] as string;
  return JSON.parse(lastLine.trim());
}

describe("auditLog — stdio mode (no context)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes a JSON line with timestamp and entry fields", async () => {
    await auditLog({ tool: "list-cases", args: {}, outcome: "success", result_count: 5 });

    const entry = lastLoggedEntry();
    expect(entry.tool).toBe("list-cases");
    expect(entry.outcome).toBe("success");
    expect(entry.result_count).toBe(5);
    expect(typeof entry.timestamp).toBe("string");
    expect(new Date(entry.timestamp as string).getTime()).toBeGreaterThan(0);
  });

  it("omits user_id in stdio mode", async () => {
    await auditLog({ tool: "auth-status", args: {}, outcome: "success" });

    const entry = lastLoggedEntry();
    expect(entry.user_id).toBeUndefined();
  });

  it("redacts sensitive keys in args", async () => {
    await auditLog({
      tool: "authenticate",
      args: { access_token: "secret", client_secret: "secret2", safe_field: "visible" },
      outcome: "success",
    });

    const entry = lastLoggedEntry();
    const args = entry.args as Record<string, unknown>;
    expect(args.access_token).toBe("[REDACTED]");
    expect(args.client_secret).toBe("[REDACTED]");
    expect(args.safe_field).toBe("visible");
  });

  it("includes error message on failure outcome", async () => {
    await auditLog({ tool: "list-cases", args: {}, outcome: "error", error: "Network timeout" });

    const entry = lastLoggedEntry();
    expect(entry.outcome).toBe("error");
    expect(entry.error).toBe("Network timeout");
  });

  it("includes optional fields when provided", async () => {
    await auditLog({
      tool: "get-case",
      args: {},
      outcome: "success",
      firm_uuid: "firm-abc",
      case_id: "case-42",
      result_count: 1,
    });

    const entry = lastLoggedEntry();
    expect(entry.firm_uuid).toBe("firm-abc");
    expect(entry.case_id).toBe("case-42");
    expect(entry.result_count).toBe(1);
  });

  it("does not throw when appendFile fails — logs warning to stderr instead", async () => {
    vi.mocked(fs.appendFile).mockRejectedValueOnce(new Error("Disk full"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      auditLog({ tool: "list-cases", args: {}, outcome: "success" })
    ).resolves.toBeUndefined();

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Disk full"));
    errSpy.mockRestore();
  });
});

describe("auditLog — HTTP mode (with context)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("includes user_id when running inside runWithUserId", async () => {
    await runWithUserId("alice@firm.com", () =>
      auditLog({ tool: "list-cases", args: {}, outcome: "success" })
    );

    const entry = lastLoggedEntry();
    expect(entry.user_id).toBe("alice@firm.com");
  });

  it("user_id reflects the current context, not other concurrent contexts", async () => {
    await Promise.all([
      runWithUserId("alice@firm.com", () =>
        auditLog({ tool: "list-cases", args: {}, outcome: "success" })
      ),
      runWithUserId("bob@firm.com", () =>
        auditLog({ tool: "get-case", args: {}, outcome: "success" })
      ),
    ]);

    const calls = vi.mocked(fs.appendFile).mock.calls;
    const entries = calls.map((c) => JSON.parse((c[1] as string).trim()));
    const alice = entries.find((e: Record<string, unknown>) => e.tool === "list-cases");
    const bob = entries.find((e: Record<string, unknown>) => e.tool === "get-case");

    expect(alice.user_id).toBe("alice@firm.com");
    expect(bob.user_id).toBe("bob@firm.com");
  });

  it("timestamp precedes or equals current time", async () => {
    const before = Date.now();
    await runWithUserId("alice@firm.com", () =>
      auditLog({ tool: "list-cases", args: {}, outcome: "success" })
    );
    const after = Date.now();

    const entry = lastLoggedEntry();
    const ts = new Date(entry.timestamp as string).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});
