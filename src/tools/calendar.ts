import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mycaseGet } from "../mycase-client.js";
import { auditLog } from "../audit/logger.js";
import { loadTokens } from "../auth/token-store.js";

export function registerCalendarTools(server: McpServer): void {
  server.tool(
    "list-calendar-events",
    "List calendar events from MyCase within an optional date range.",
    {
      start_date: z.string().optional().describe("Start of date range (YYYY-MM-DD). Defaults to today."),
      end_date: z.string().optional().describe("End of date range (YYYY-MM-DD). Defaults to 30 days from start."),
      case_id: z.string().optional().describe("Filter events by case ID."),
      limit: z.number().int().min(1).max(200).optional().default(25),
      page: z.number().int().min(1).optional().default(1),
    },
    async ({ start_date, end_date, case_id, limit, page }) => {
      const tokens = await loadTokens();
      try {
        const today = new Date().toISOString().split("T")[0];
        const thirtyDaysOut = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0];

        const params: Record<string, string | number | undefined> = {
          per_page: limit,
          page,
          start_date: start_date ?? today,
          end_date: end_date ?? thirtyDaysOut,
        };
        if (case_id) params["case_id"] = case_id;

        const data = await mycaseGet("/events", params) as {
          events?: Array<{
            id: number | string;
            title?: string;
            summary?: string;
            description?: string;
            start_at?: string;
            end_at?: string;
            all_day?: boolean;
            location?: string;
            case?: { id: number | string; name?: string };
            attendees?: Array<{ id: number | string; name?: string; email?: string }>;
          }>;
          meta?: { total?: number };
        };

        const events = data?.events ?? [];
        await auditLog({ tool: "list-calendar-events", args: { start_date, end_date, case_id, limit, page }, outcome: "success", firm_uuid: tokens?.firm_uuid, case_id, result_count: events.length });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                events: events.map((e) => ({
                  id: e.id,
                  title: e.title ?? e.summary,
                  description: e.description,
                  start_at: e.start_at,
                  end_at: e.end_at,
                  all_day: e.all_day,
                  location: e.location,
                  case: e.case,
                  attendees: e.attendees,
                })),
                total: data?.meta?.total,
              }),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({ tool: "list-calendar-events", args: { start_date, end_date, case_id, limit, page }, outcome: "error", firm_uuid: tokens?.firm_uuid, case_id, error: msg });
        return { content: [{ type: "text", text: `Error listing calendar events: ${msg}` }], isError: true };
      }
    }
  );
}
