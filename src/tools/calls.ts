import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mycasePost } from "../mycase-client.js";
import { auditLog } from "../audit/logger.js";
import { loadTokens } from "../auth/token-store.js";

export function registerCallTools(server: McpServer): void {
  server.tool(
    "log-call",
    "Log a phone call in MyCase, optionally linked to a case and contact.",
    {
      subject: z.string().min(1).describe("Call subject or summary."),
      notes: z.string().optional().describe("Call notes or description."),
      case_id: z.string().optional().describe("Case ID to associate the call with."),
      contact_id: z.string().optional().describe("Contact ID of the person called."),
      date: z
        .string()
        .optional()
        .describe("Date the call occurred (YYYY-MM-DD). Defaults to today."),
      duration_minutes: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Duration of the call in minutes."),
      direction: z
        .enum(["inbound", "outbound"])
        .optional()
        .describe("Whether the call was inbound or outbound."),
    },
    async ({ subject, notes, case_id, contact_id, date, duration_minutes, direction }) => {
      const tokens = await loadTokens();

      if (!case_id && !contact_id) {
        return {
          content: [{ type: "text", text: "Error: provide at least one of case_id or contact_id." }],
          isError: true,
        };
      }

      try {
        const today = new Date().toISOString().split("T")[0];
        // Confirm exact endpoint and body shape against MyCase docs
        // MyCase may use /calls or /activities (call type)
        const body: Record<string, unknown> = {
          call: {
            subject,
            date: date ?? today,
            ...(notes && { notes }),
            ...(case_id && { case_id }),
            ...(contact_id && { contact_id }),
            ...(duration_minutes && { duration_minutes }),
            ...(direction && { direction }),
          },
        };

        const data = await mycasePost("/calls", body) as {
          call?: { id: number | string; subject?: string };
        };

        await auditLog({ tool: "log-call", args: { subject, case_id, contact_id, date, duration_minutes, direction }, outcome: "success", user_id: tokens?.user_id, case_id, result_count: 1 });

        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, call: data?.call ?? data }) }],
        };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({ tool: "log-call", args: { subject, case_id, contact_id, date, duration_minutes, direction }, outcome: "error", user_id: tokens?.user_id, case_id, error: msg });
        return { content: [{ type: "text", text: `Error logging call: ${msg}` }], isError: true };
      }
    }
  );
}
