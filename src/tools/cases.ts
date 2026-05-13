import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mycaseGet, MyCaseApiError } from "../mycase-client.js";
import { auditLog } from "../audit/logger.js";
import { loadTokens } from "../auth/token-store.js";

export function registerCaseTools(server: McpServer): void {
  server.tool(
    "list-cases",
    "List cases from MyCase, optionally filtered by status.",
    {
      status: z
        .enum(["open", "closed"])
        .optional()
        .describe('Filter by case status: "open" or "closed". Omit for all cases.'),
      page_size: z.number().int().min(1).max(1000).optional().default(25),
      page_token: z.string().optional().describe("Cursor token for the next page, from a previous response."),
      updated_after: z.string().optional().describe("ISO 8601 date — return only cases created or updated after this date."),
    },
    async ({ status, page_size, page_token, updated_after }) => {
      const tokens = await loadTokens();
      try {
        const params: Record<string, string | number | undefined> = { page_size };
        if (status) params["filter[status]"] = status;
        if (page_token) params["page_token"] = page_token;
        if (updated_after) params["filter[updated_after]"] = updated_after;

        const cases = await mycaseGet("/cases", params) as Array<{
          id: number;
          name?: string;
          case_number?: string | null;
          status?: string;
          description?: string;
          opened_date?: string | null;
          closed_date?: string | null;
          practice_area?: string | null;
          case_stage?: string | null;
          clients?: Array<{ id: number }>;
          updated_at?: string;
          created_at?: string;
        }>;

        const list = Array.isArray(cases) ? cases : [];
        await auditLog({
          tool: "list-cases",
          args: { status, page_size, page_token, updated_after },
          outcome: "success",
          user_id: tokens?.user_id,
          result_count: list.length,
        });

        return {
          content: [{ type: "text", text: JSON.stringify({ cases: list }) }],
        };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({ tool: "list-cases", args: { status, page_size, page_token, updated_after }, outcome: "error", user_id: tokens?.user_id, error: msg });
        return { content: [{ type: "text", text: `Error listing cases: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    "get-case",
    "Get full details for a single MyCase case by its ID.",
    {
      case_id: z.string().describe("The MyCase case ID."),
    },
    async ({ case_id }) => {
      const tokens = await loadTokens();
      try {
        const data = await mycaseGet(`/cases/${case_id}`);

        await auditLog({ tool: "get-case", args: { case_id }, outcome: "success", user_id: tokens?.user_id, case_id, result_count: 1 });
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      } catch (err: unknown) {
        if (err instanceof MyCaseApiError && err.status === 404) {
          await auditLog({ tool: "get-case", args: { case_id }, outcome: "success", user_id: tokens?.user_id, case_id, result_count: 0 });
          return { content: [{ type: "text", text: JSON.stringify({ error: `Case ${case_id} not found.` }) }] };
        }
        const msg = (err as Error).message;
        await auditLog({ tool: "get-case", args: { case_id }, outcome: "error", user_id: tokens?.user_id, case_id, error: msg });
        return { content: [{ type: "text", text: `Error fetching case: ${msg}` }], isError: true };
      }
    }
  );
}
