import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("../../src/audit/logger.js", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
  LOG_FILE_PATH: "/mocked/audit.log",
}));

vi.mock("fs/promises", () => {
  const fns = {
    readFile: vi.fn(),
    mkdir: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ size: 0 }),
    appendFile: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn(),
  };
  return { default: fns, ...fns };
});

import fs from "fs/promises";
import { registerAuditExportTool } from "../../src/tools/auditExport.js";
import { auditLog } from "../../src/audit/logger.js";
import { createMockServer, parseResult } from "../helpers.js";

// Three synthetic log entries spanning 2025.
const JAN = JSON.stringify({
  timestamp: "2025-01-15T10:00:00Z",
  tool: "list-cases",
  outcome: "success",
  session_id: "sid-1",
  machine_ip: "10.0.0.1",
});
const JUN = JSON.stringify({
  timestamp: "2025-06-15T10:00:00Z",
  tool: "get-case",
  outcome: "error",
  session_id: "sid-1",
  machine_ip: "10.0.0.1",
});
// 2025-12-20 at 18:00 UTC — used to verify bare end_date end-of-day behaviour.
const DEC = JSON.stringify({
  timestamp: "2025-12-20T18:00:00Z",
  tool: "list-contacts",
  outcome: "success",
  session_id: "sid-2",
  machine_ip: "10.0.0.2",
});

const SAMPLE_LOG = [JAN, JUN, DEC].join("\n") + "\n";

describe("export-audit-log", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerAuditExportTool(mock.server);
    (fs.readFile as Mock).mockResolvedValue(SAMPLE_LOG);
  });

  // ── basic retrieval ────────────────────────────────────────────────────────

  it("returns all entries when no filters are provided", async () => {
    const result = await mock.call("export-audit-log", {});
    const data = parseResult(result);

    expect(data.count).toBe(3);
    expect(data.entries).toHaveLength(3);
  });

  it("count field always equals entries.length", async () => {
    const result = await mock.call("export-audit-log", {});
    const data = parseResult(result);
    expect(data.count).toBe(data.entries.length);
  });

  it("entries contain all original fields including session_id and machine_ip", async () => {
    const result = await mock.call("export-audit-log", {});
    const data = parseResult(result);
    const first = data.entries[0] as Record<string, unknown>;

    expect(first.session_id).toBe("sid-1");
    expect(first.machine_ip).toBe("10.0.0.1");
    expect(first.tool).toBe("list-cases");
  });

  // ── date filtering ─────────────────────────────────────────────────────────

  it("filters by start_date (ISO datetime) — excludes earlier entries", async () => {
    const result = await mock.call("export-audit-log", { start_date: "2025-06-01T00:00:00Z" });
    const data = parseResult(result);

    expect(data.count).toBe(2);
    const tools = (data.entries as Array<{ tool: string }>).map((e) => e.tool);
    expect(tools).toContain("get-case");
    expect(tools).toContain("list-contacts");
    expect(tools).not.toContain("list-cases");
  });

  it("filters by end_date (ISO datetime) — excludes later entries", async () => {
    const result = await mock.call("export-audit-log", { end_date: "2025-06-30T23:59:59Z" });
    const data = parseResult(result);

    expect(data.count).toBe(2);
    const tools = (data.entries as Array<{ tool: string }>).map((e) => e.tool);
    expect(tools).toContain("list-cases");
    expect(tools).toContain("get-case");
    expect(tools).not.toContain("list-contacts");
  });

  it("bare end_date (YYYY-MM-DD) includes entries up to 23:59:59.999Z on that day", async () => {
    // DEC entry is at 18:00 UTC on 2025-12-20.
    // Without end-of-day coercion, bare "2025-12-20" would be midnight UTC and
    // the 18:00 entry would be excluded. With the fix it must be included.
    const result = await mock.call("export-audit-log", { end_date: "2025-12-20" });
    const data = parseResult(result);

    const tools = (data.entries as Array<{ tool: string }>).map((e) => e.tool);
    expect(tools).toContain("list-contacts");
  });

  it("bare start_date (YYYY-MM-DD) uses midnight UTC as the lower bound", async () => {
    // JAN entry is at 10:00 UTC on 2025-01-15; start_date of that day should include it.
    const result = await mock.call("export-audit-log", { start_date: "2025-01-15" });
    const data = parseResult(result);

    expect(data.count).toBe(3);
  });

  it("combines start_date and end_date to narrow the window", async () => {
    const result = await mock.call("export-audit-log", {
      start_date: "2025-01-20T00:00:00Z",
      end_date: "2025-11-30T23:59:59Z",
    });
    const data = parseResult(result);

    expect(data.count).toBe(1);
    expect((data.entries[0] as { tool: string }).tool).toBe("get-case");
  });

  // ── edge cases ─────────────────────────────────────────────────────────────

  it("returns empty result when the log file does not exist", async () => {
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    (fs.readFile as Mock).mockRejectedValue(enoent);

    const result = await mock.call("export-audit-log", {});
    const data = parseResult(result);

    expect(data.count).toBe(0);
    expect(data.entries).toHaveLength(0);
  });

  it("skips malformed JSONL lines without crashing", async () => {
    const mixed = JAN + "\nnot valid json at all\n" + DEC + "\n";
    (fs.readFile as Mock).mockResolvedValue(mixed);

    const result = await mock.call("export-audit-log", {});
    const data = parseResult(result);

    expect(data.count).toBe(2);
  });

  it("skips blank / whitespace-only lines", async () => {
    const withBlanks = "\n\n" + JAN + "\n  \n" + JUN + "\n";
    (fs.readFile as Mock).mockResolvedValue(withBlanks);

    const result = await mock.call("export-audit-log", {});
    const data = parseResult(result);

    expect(data.count).toBe(2);
  });

  // ── input validation ───────────────────────────────────────────────────────

  it("returns isError for an invalid start_date without reading the file", async () => {
    const result = await mock.call("export-audit-log", { start_date: "not-a-date" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid start_date");
    // File must NOT have been read — validation should short-circuit before I/O.
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it("returns isError for an invalid end_date without reading the file", async () => {
    const result = await mock.call("export-audit-log", { end_date: "not-a-date" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid end_date");
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  // ── self-auditing ──────────────────────────────────────────────────────────

  it("calls auditLog with outcome:success after a successful export", async () => {
    await mock.call("export-audit-log", {});

    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "export-audit-log", outcome: "success" })
    );
  });

  it("calls auditLog with outcome:error when the file read throws unexpectedly", async () => {
    (fs.readFile as Mock).mockRejectedValue(new Error("permission denied"));

    const result = await mock.call("export-audit-log", {});

    expect(result.isError).toBe(true);
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "export-audit-log", outcome: "error" })
    );
  });

  it("includes result_count in the success audit entry", async () => {
    await mock.call("export-audit-log", {});

    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ result_count: 3 })
    );
  });
});
