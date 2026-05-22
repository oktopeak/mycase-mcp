import fs from "fs/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { auditLog, LOG_FILE_PATH } from "../audit/logger.js";

/**
 * Matches bare date strings like "2025-12-31" (no time component).
 * Format check only — range validity (e.g. month 99) is caught downstream
 * by the isNaN guard after Date parsing.
 */
const BARE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function registerAuditExportTool(server: McpServer): void {
  server.tool(
    "export-audit-log",
    "Export the structured audit log as JSON. Supports optional start_date / end_date filters (ISO 8601). Returns all log entries from ~/.oktopeak-mycase/audit.log including session_id and machine_ip for bar-review traceability.",
    {
      start_date: z
        .string()
        .optional()
        .describe("Include entries at or after this timestamp (ISO 8601, e.g. 2025-01-01 or 2025-01-01T00:00:00Z)."),
      end_date: z
        .string()
        .optional()
        .describe(
          "Include entries on or before this date (ISO 8601). A bare date (YYYY-MM-DD) is treated as end-of-day UTC (23:59:59.999Z) so the entire day is included."
        ),
    },
    async ({ start_date, end_date }) => {
      // Validate inputs before any I/O so we don't waste a 50 MB file read on bad args.
      const startMs = start_date ? new Date(start_date).getTime() : -Infinity;
      const endMs = end_date
        ? BARE_DATE_RE.test(end_date)
          ? new Date(end_date + "T23:59:59.999Z").getTime()
          : new Date(end_date).getTime()
        : Infinity;

      if (start_date && isNaN(startMs)) {
        return { content: [{ type: "text", text: "Invalid start_date — must be ISO 8601." }], isError: true };
      }
      if (end_date && isNaN(endMs)) {
        return { content: [{ type: "text", text: "Invalid end_date — must be ISO 8601." }], isError: true };
      }

      try {
        const raw = await fs.readFile(LOG_FILE_PATH, { encoding: "utf8" }).catch((err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT") return "";
          throw err;
        });

        const entries: unknown[] = [];
        for (const line of raw.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(trimmed) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (startMs !== -Infinity || endMs !== Infinity) {
            const ts = typeof parsed.timestamp === "string" ? new Date(parsed.timestamp).getTime() : NaN;
            if (isNaN(ts) || ts < startMs || ts > endMs) continue;
          }
          entries.push(parsed);
        }

        // auditLog() swallows its own write errors, so this is safe inside try.
        await auditLog({
          tool: "export-audit-log",
          args: { start_date, end_date },
          outcome: "success",
          result_count: entries.length,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ entries, count: entries.length }),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        // auditLog() swallows its own write errors — safe to call inside catch.
        await auditLog({
          tool: "export-audit-log",
          args: { start_date, end_date },
          outcome: "error",
          error: msg,
        });
        return { content: [{ type: "text", text: `Error exporting audit log: ${msg}` }], isError: true };
      }
    }
  );
}
