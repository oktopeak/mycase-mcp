import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mycaseGet, MyCaseApiError } from "../mycase-client.js";
import { fetchAllPages, MAX_PAGE_SIZE } from "../utils/pagination.js";
import { auditLog } from "../audit/logger.js";
import { loadTokens } from "../auth/token-store.js";

type StaffItem = {
  id: number;
  email?: string;
  first_name?: string;
  middle_initial?: string;
  last_name?: string;
  address?: {
    address1?: string;
    address2?: string;
    city?: string;
    state?: string;
    zip_code?: string;
    country?: string;
  };
  cell_phone_number?: string;
  work_phone_number?: string;
  home_phone_number?: string;
  type?: string;
  title?: string;
  active?: boolean;
  default_hourly_rate?: number;
  created_at?: string;
  updated_at?: string;
};

export function registerStaffTools(server: McpServer): void {
  server.tool(
    "list-staff",
    "List all staff members in the MyCase firm. Always pages through every result. The response's `complete` field reports whether every page was fetched; if false, pass `page_token` back in to continue.",
    {
      page_size: z.number().int().min(1).max(MAX_PAGE_SIZE).optional().default(25),
      page_token: z.string().optional().describe("Cursor token to resume pagination from, e.g. after a truncated response."),
      updated_after: z.string().optional().describe("ISO 8601 date — return only staff created or updated after this date."),
    },
    async ({ page_size, page_token, updated_after }) => {
      const tokens = await loadTokens();
      try {
        const params: Record<string, string | number | undefined> = { page_size };
        if (updated_after) params["filter[updated_after]"] = updated_after;

        const { items, complete, next_page_token, truncated_reason } = await fetchAllPages<StaffItem>(
          "/staff",
          params,
          { startCursor: page_token }
        );

        await auditLog({
          tool: "list-staff",
          args: { page_size, page_token, updated_after },
          outcome: "success",
          firm_uuid: tokens?.firm_uuid,
          result_count: items.length,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              staff: items,
              complete,
              ...(next_page_token && { next_page_token }),
              ...(truncated_reason && { truncated_reason }),
            }),
          }],
        };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({ tool: "list-staff", args: { page_size, page_token, updated_after }, outcome: "error", firm_uuid: tokens?.firm_uuid, error: msg });
        return { content: [{ type: "text", text: `Error listing staff: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    "get-staff",
    "Get full details for a single MyCase staff member by their ID.",
    {
      staff_id: z.string().describe("The MyCase staff member ID."),
    },
    async ({ staff_id }) => {
      const tokens = await loadTokens();
      try {
        const data = await mycaseGet(`/staff/${staff_id}`);

        await auditLog({ tool: "get-staff", args: { staff_id }, outcome: "success", firm_uuid: tokens?.firm_uuid, result_count: 1 });
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      } catch (err: unknown) {
        if (err instanceof MyCaseApiError && err.status === 404) {
          await auditLog({ tool: "get-staff", args: { staff_id }, outcome: "success", firm_uuid: tokens?.firm_uuid, result_count: 0 });
          // Returning JSON (not isError) so the LLM treats "not found" as data, not a tool failure
          return { content: [{ type: "text", text: JSON.stringify({ error: `Staff member ${staff_id} not found.` }) }] };
        }
        const msg = (err as Error).message;
        await auditLog({ tool: "get-staff", args: { staff_id }, outcome: "error", firm_uuid: tokens?.firm_uuid, error: msg });
        return { content: [{ type: "text", text: `Error fetching staff member: ${msg}` }], isError: true };
      }
    }
  );
}
