import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

// Must be hoisted before the import of logger so vitest replaces fs/promises
// before the module initialises.
vi.mock("fs/promises", () => {
  const fns = {
    mkdir: vi.fn().mockResolvedValue(undefined),
    // Return size 0 so rotation is never triggered.
    stat: vi.fn().mockResolvedValue({ size: 0 }),
    appendFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn(),
    rename: vi.fn(),
  };
  // Provide both the default export (used by `import fs from "fs/promises"`)
  // and named exports so either import style works.
  return { default: fns, ...fns };
});

import fs from "fs/promises";
import { auditLog, initAuditSession, type AuditEntry } from "../../src/audit/logger.js";

// Helper: parse the JSON written to appendFile in the last call.
function lastWritten(): Record<string, unknown> {
  const calls = (fs.appendFile as Mock).mock.calls;
  if (calls.length === 0) throw new Error("appendFile was never called");
  const line = calls[calls.length - 1][1] as string;
  return JSON.parse(line.trim()) as Record<string, unknown>;
}

describe("auditLog — session fields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fs.mkdir as Mock).mockResolvedValue(undefined);
    (fs.stat as Mock).mockResolvedValue({ size: 0 });
    (fs.appendFile as Mock).mockResolvedValue(undefined);
  });

  it("includes session_id and machine_ip set by initAuditSession", async () => {
    initAuditSession("abc-session-uuid", "10.0.0.1");
    await auditLog({ tool: "test-tool", args: {}, outcome: "success" });

    const entry = lastWritten();
    expect(entry.session_id).toBe("abc-session-uuid");
    expect(entry.machine_ip).toBe("10.0.0.1");
  });

  it("session_id cannot be forged by passing it inside the entry object", async () => {
    initAuditSession("real-session", "192.168.1.1");
    // @ts-expect-error — deliberately bypassing AuditInput to verify the runtime
    // override still wins even when the type guard is circumvented.
    await (auditLog as (e: AuditEntry) => Promise<void>)({
      tool: "test-tool",
      args: {},
      outcome: "success",
      session_id: "injected-fake-session",
    });

    const entry = lastWritten();
    expect(entry.session_id).toBe("real-session");
  });

  it("machine_ip cannot be forged by passing it inside the entry object", async () => {
    initAuditSession("real-session", "192.168.1.1");
    // @ts-expect-error — deliberately bypassing AuditInput to verify the runtime
    // override still wins even when the type guard is circumvented.
    await (auditLog as (e: AuditEntry) => Promise<void>)({
      tool: "test-tool",
      args: {},
      outcome: "success",
      machine_ip: "evil-ip",
    });

    const entry = lastWritten();
    expect(entry.machine_ip).toBe("192.168.1.1");
  });

  it("updates to session values are reflected immediately", async () => {
    initAuditSession("session-v1", "1.1.1.1");
    await auditLog({ tool: "t", args: {}, outcome: "success" });
    expect(lastWritten().session_id).toBe("session-v1");

    initAuditSession("session-v2", "2.2.2.2");
    await auditLog({ tool: "t", args: {}, outcome: "success" });
    expect(lastWritten().session_id).toBe("session-v2");
    expect(lastWritten().machine_ip).toBe("2.2.2.2");
  });
});

describe("auditLog — log entry structure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fs.mkdir as Mock).mockResolvedValue(undefined);
    (fs.stat as Mock).mockResolvedValue({ size: 0 });
    (fs.appendFile as Mock).mockResolvedValue(undefined);
    initAuditSession("test-sid", "127.0.0.1");
  });

  it("writes timestamp, tool, outcome, and args", async () => {
    await auditLog({ tool: "my-tool", args: { foo: "bar" }, outcome: "success" });

    const entry = lastWritten();
    expect(typeof entry.timestamp).toBe("string");
    expect(entry.tool).toBe("my-tool");
    expect(entry.outcome).toBe("success");
    expect((entry.args as Record<string, unknown>).foo).toBe("bar");
  });

  it("includes error field when provided", async () => {
    await auditLog({ tool: "t", args: {}, outcome: "error", error: "something broke" });

    expect(lastWritten().error).toBe("something broke");
  });

  it("redacts access_token in args", async () => {
    await auditLog({
      tool: "t",
      args: { access_token: "super-secret", safe: "visible" },
      outcome: "success",
    });

    const args = lastWritten().args as Record<string, unknown>;
    expect(args.access_token).toBe("[REDACTED]");
    expect(args.safe).toBe("visible");
  });

  it("redacts refresh_token, client_secret, and password in args", async () => {
    await auditLog({
      tool: "t",
      args: { refresh_token: "rt", client_secret: "cs", password: "pw" },
      outcome: "success",
    });

    const args = lastWritten().args as Record<string, unknown>;
    expect(args.refresh_token).toBe("[REDACTED]");
    expect(args.client_secret).toBe("[REDACTED]");
    expect(args.password).toBe("[REDACTED]");
  });

  it("forwards optional fields (firm_uuid, case_id, result_count)", async () => {
    await auditLog({
      tool: "t",
      args: {},
      outcome: "success",
      firm_uuid: "firm-abc",
      case_id: "case-42",
      result_count: 7,
    });

    const entry = lastWritten();
    expect(entry.firm_uuid).toBe("firm-abc");
    expect(entry.case_id).toBe("case-42");
    expect(entry.result_count).toBe(7);
  });

  it("does not throw when appendFile fails — swallows write errors gracefully", async () => {
    (fs.appendFile as Mock).mockRejectedValue(new Error("disk full"));
    await expect(
      auditLog({ tool: "t", args: {}, outcome: "success" })
    ).resolves.toBeUndefined();
  });
});
