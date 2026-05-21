import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mycaseGetPaged, mycasePost } from "../mycase-client.js";
import { auditLog } from "../audit/logger.js";
import { loadTokens } from "../auth/token-store.js";

export function registerCalendarTools(server: McpServer): void {
  server.tool(
    "list-calendar-events",
    "List calendar events from MyCase.",
    {
      updated_after: z.string().optional().describe("Return only events created or updated after this date/time (ISO 8601, e.g. '2025-05-01T00:00:00Z')."),
      case_id: z.number().int().optional().describe("Filter events by case ID (applied client-side)."),
      page_size: z.number().int().min(1).max(1000).optional().default(25),
      page_token: z.string().optional().describe("Cursor token for the next page, from a previous response."),
    },
    async ({ updated_after, case_id, page_size, page_token }) => {
      const tokens = await loadTokens();
      try {
        const params: Record<string, string | number | undefined> = {
          page_size,
          ...(updated_after && { "filter[updated_after]": updated_after }),
          ...(page_token && { page_token }),
        };

        const { body, nextPageToken } = await mycaseGetPaged("/events", params);
        const raw = body as Array<{
          id: number | string;
          name?: string;
          description?: string;
          start?: string;
          end?: string;
          all_day?: boolean;
          private?: boolean;
          event_type?: string;
          location?: { id: number };
          case?: { id: number | string };
          staff?: Array<{ id: number | string }>;
          created_at?: string;
          updated_at?: string;
        }>;

        let events = Array.isArray(raw) ? raw : [];
        if (case_id !== undefined) {
          events = events.filter((e) => e.case?.id === case_id);
        }

        await auditLog({
          tool: "list-calendar-events",
          args: { updated_after, case_id, page_size, page_token },
          outcome: "success",
          firm_uuid: tokens?.firm_uuid,
          case_id: case_id !== undefined ? String(case_id) : undefined,
          result_count: events.length,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                events: events.map((e) => ({
                  id: e.id,
                  title: e.name,
                  description: e.description,
                  start_at: e.start,
                  end_at: e.end,
                  all_day: e.all_day,
                  location: e.location,
                  case: e.case,
                  staff: e.staff,
                })),
                ...(nextPageToken && { next_page_token: nextPageToken }),
              }),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({
          tool: "list-calendar-events",
          args: { updated_after, case_id, page_size, page_token },
          outcome: "error",
          firm_uuid: tokens?.firm_uuid,
          case_id: case_id !== undefined ? String(case_id) : undefined,
          error: msg,
        });
        return { content: [{ type: "text", text: `Error listing calendar events: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    "create-calendar-event",
    "Create a calendar event in MyCase for hearings, deadlines, or appointments.",
    {
      title: z.string().min(1).describe("Event title (e.g. 'Hearing', 'Deposition', 'Client Meeting')."),
      start_at: z.string().describe("Start date/time in ISO 8601 format (e.g. '2025-06-01T09:00:00')."),
      end_at: z.string().describe("End date/time in ISO 8601 format."),
      case_id: z.number().int().optional().describe("ID of the case to associate with this event."),
      staff_ids: z.array(z.number().int()).optional().describe("IDs of staff members to invite. At least one is recommended."),
      location_id: z.number().int().optional().describe("ID of a MyCase location to associate with this event."),
      notes: z.string().optional().describe("Additional notes or description for the event."),
      all_day: z.boolean().optional().describe("Whether this is an all-day event. Defaults to false."),
    },
    async ({ title, start_at, end_at, case_id, staff_ids, location_id, notes, all_day }) => {
      const tokens = await loadTokens();
      try {
        const body: Record<string, unknown> = {
          name: title,
          start: start_at,
          end: end_at,
          ...(all_day !== undefined && { all_day }),
          ...(notes !== undefined && { description: notes }),
          ...(case_id !== undefined && { case: { id: case_id } }),
          ...(location_id !== undefined && { location: { id: location_id } }),
          staff: staff_ids?.length ? staff_ids.map((id) => ({ id, required: true })) : [],
        };

        const data = await mycasePost("/events", body) as { id?: number | string };
        await auditLog({
          tool: "create-calendar-event",
          args: { title, start_at, end_at, case_id, staff_ids },
          outcome: "success",
          firm_uuid: tokens?.firm_uuid,
          case_id: case_id !== undefined ? String(case_id) : undefined,
          result_count: 1,
        });

        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, event_id: data?.id, event: data }) }],
        };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({
          tool: "create-calendar-event",
          args: { title, start_at, end_at, case_id, staff_ids },
          outcome: "error",
          firm_uuid: tokens?.firm_uuid,
          case_id: case_id !== undefined ? String(case_id) : undefined,
          error: msg,
        });
        return { content: [{ type: "text", text: `Error creating calendar event: ${msg}` }], isError: true };
      }
    }
  );
}
