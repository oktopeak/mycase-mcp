import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mycaseGet } from "../mycase-client.js";
import { auditLog } from "../audit/logger.js";
import { loadTokens } from "../auth/token-store.js";

export function registerCalendarTools(server: McpServer): void {
  server.tool(
    "list-calendar-events",
    "List calendar events from MyCase, optionally filtered by updated date or case.",
    {
      updated_after: z.string().optional().describe("ISO 8601 date — return only events created or updated after this date."),
      case_id: z.string().optional().describe("Filter events by case ID (undocumented param — may not work for all firms)."),
      page_size: z.number().int().min(1).max(1000).optional().default(25),
      page_token: z.string().optional().describe("Cursor token for the next page."),
    },
    async ({ updated_after, case_id, page_size, page_token }) => {
      const tokens = await loadTokens();
      try {
        const params: Record<string, string | number | undefined> = { page_size };
        if (page_token) params["page_token"] = page_token;
        if (updated_after) params["filter[updated_after]"] = updated_after;
        if (case_id) params["case_id"] = case_id;

        type EventItem = {
          id: number | string;
          name?: string;
          description?: string;
          start?: string;
          end?: string;
          all_day?: boolean;
          private?: boolean;
          event_type?: string;
          location?: { id: number | string };
          case?: { id: number | string };
          staff?: Array<{ id: number | string }>;
          created_at?: string;
          updated_at?: string;
        };

        const result = await mycaseGet("/events", params);
        const events = Array.isArray(result.data) ? result.data as EventItem[] : [];
        const next_page_token = result.next_page_token;
        const total = result.total;

        await auditLog({ tool: "list-calendar-events", args: { updated_after, case_id, page_size, page_token }, outcome: "success", firm_uuid: tokens?.firm_uuid, case_id, result_count: events.length });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                events: events.map((e) => ({
                  id: e.id,
                  name: e.name,
                  description: e.description,
                  start: e.start,
                  end: e.end,
                  all_day: e.all_day,
                  private: e.private,
                  event_type: e.event_type,
                  location: e.location,
                  case: e.case,
                  staff: e.staff,
                  created_at: e.created_at,
                  updated_at: e.updated_at,
                })),
                ...(total !== undefined && { total }),
                ...(next_page_token && { next_page_token }),
              }),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({ tool: "list-calendar-events", args: { updated_after, case_id, page_size, page_token }, outcome: "error", firm_uuid: tokens?.firm_uuid, case_id, error: msg });
        return { content: [{ type: "text", text: `Error listing calendar events: ${msg}` }], isError: true };
      }
    }
  );
}
