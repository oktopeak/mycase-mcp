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
        .enum(["active", "pending", "closed", "all"])
        .optional()
        .default("active")
        .describe('Filter by case status. Defaults to "active".'),
      limit: z.number().int().min(1).max(200).optional().default(25),
      page: z.number().int().min(1).optional().default(1),
    },
    async ({ status, limit, page }) => {
      const tokens = await loadTokens();
      try {
        const params: Record<string, string | number | undefined> = {
          per_page: limit,
          page,
        };
        if (status && status !== "all") params["status"] = status;

        const data = await mycaseGet("/cases", params) as {
          cases?: Array<{
            id: number | string;
            name?: string;
            case_number?: string;
            status?: string;
            description?: string;
            open_date?: string;
            close_date?: string;
            client?: { id: number | string; name?: string };
            practice_area?: { id: number | string; name?: string };
            responsible_attorney?: { id: number | string; name?: string };
          }>;
          meta?: { total?: number; page?: number; per_page?: number };
        };

        const cases = data?.cases ?? [];
        await auditLog({
          tool: "list-cases",
          args: { status, limit, page },
          outcome: "success",
          user_id: tokens?.user_id,
          result_count: cases.length,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                cases: cases.map((c) => ({
                  id: c.id,
                  name: c.name,
                  case_number: c.case_number,
                  status: c.status,
                  description: c.description,
                  open_date: c.open_date,
                  close_date: c.close_date,
                  client: c.client,
                  practice_area: c.practice_area,
                  responsible_attorney: c.responsible_attorney,
                })),
                total: data?.meta?.total,
                page: data?.meta?.page,
              }),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({ tool: "list-cases", args: { status, limit, page }, outcome: "error", user_id: tokens?.user_id, error: msg });
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
        const data = await mycaseGet(`/cases/${case_id}`) as {
          case?: {
            id: number | string;
            name?: string;
            case_number?: string;
            status?: string;
            description?: string;
            open_date?: string;
            close_date?: string;
            client?: { id: number | string; name?: string; email?: string };
            practice_area?: { id: number | string; name?: string };
            responsible_attorney?: { id: number | string; name?: string };
            originating_attorney?: { id: number | string; name?: string };
            office?: { id: number | string; name?: string };
            custom_fields?: Record<string, unknown>;
            created_at?: string;
            updated_at?: string;
          };
        };

        await auditLog({ tool: "get-case", args: { case_id }, outcome: "success", user_id: tokens?.user_id, case_id, result_count: 1 });
        return { content: [{ type: "text", text: JSON.stringify(data?.case ?? data) }] };
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
