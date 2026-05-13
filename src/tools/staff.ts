import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mycaseGet, MyCaseApiError } from "../mycase-client.js";
import { auditLog } from "../audit/logger.js";
import { loadTokens } from "../auth/token-store.js";

export function registerStaffTools(server: McpServer): void {
  server.tool(
    "list-staff",
    "List all staff members in the MyCase firm.",
    {
      page_size: z.number().int().min(1).max(1000).optional().default(25),
      page_token: z.string().optional().describe("Cursor token for the next page, from a previous response."),
      updated_after: z.string().optional().describe("ISO 8601 date — return only staff created or updated after this date."),
    },
    async ({ page_size, page_token, updated_after }) => {
      const tokens = await loadTokens();
      try {
        const params: Record<string, string | number | undefined> = { page_size };
        if (page_token) params["page_token"] = page_token;
        if (updated_after) params["filter[updated_after]"] = updated_after;

        const staff = await mycaseGet("/staff", params) as Array<{
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
        }>;

        const list = Array.isArray(staff) ? staff : [];
        await auditLog({
          tool: "list-staff",
          args: { page_size, page_token, updated_after },
          outcome: "success",
          user_id: tokens?.user_id,
          result_count: list.length,
        });

        return {
          content: [{ type: "text", text: JSON.stringify({ staff: list }) }],
        };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({ tool: "list-staff", args: { page_size, page_token, updated_after }, outcome: "error", user_id: tokens?.user_id, error: msg });
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

        await auditLog({ tool: "get-staff", args: { staff_id }, outcome: "success", user_id: tokens?.user_id, result_count: 1 });
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      } catch (err: unknown) {
        if (err instanceof MyCaseApiError && err.status === 404) {
          await auditLog({ tool: "get-staff", args: { staff_id }, outcome: "success", user_id: tokens?.user_id, result_count: 0 });
          return { content: [{ type: "text", text: JSON.stringify({ error: `Staff member ${staff_id} not found.` }) }] };
        }
        const msg = (err as Error).message;
        await auditLog({ tool: "get-staff", args: { staff_id }, outcome: "error", user_id: tokens?.user_id, error: msg });
        return { content: [{ type: "text", text: `Error fetching staff member: ${msg}` }], isError: true };
      }
    }
  );
}
