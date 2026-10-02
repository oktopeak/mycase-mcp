import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mycaseGet, mycaseGetAll, mycaseGetPage, mycasePost, MyCaseApiError } from "../mycase-client.js";
import { auditLog } from "../audit/logger.js";
import { loadTokens } from "../auth/token-store.js";

export function registerCaseTools(server: McpServer): void {
  server.tool(
    "list-cases",
    "List cases from MyCase, optionally filtered by status. Without page_token it pages through every case and says whether the list is complete; with page_token it returns that one page and the next cursor.",
    {
      status: z
        .enum(["open", "closed"])
        .optional()
        .describe('Filter by case status: "open" or "closed". Omit for all cases.'),
      page_size: z.number().int().min(1).max(100).optional().default(100).describe("Page size, used only when paging manually with page_token."),
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

        // A bare first page looked like the whole list (25 of 35 open matters, no
        // warning). Default to every page; manual paging stays available.
        let list: unknown[];
        let complete = true;
        let nextPageToken: string | undefined;
        let incompleteReason: string | undefined;
        if (page_token) {
          const page = await mycaseGetPage("/cases", params);
          list = page.items;
          nextPageToken = page.nextPageToken;
          complete = !nextPageToken;
        } else {
          const { page_size: _ignored, ...filters } = params;
          const result = await mycaseGetAll("/cases", filters);
          list = result.items;
          complete = result.complete;
          incompleteReason = result.incompleteReason;
        }

        await auditLog({
          tool: "list-cases",
          args: { status, page_size, page_token, updated_after },
          outcome: "success",
          firm_uuid: tokens?.firm_uuid,
          result_count: list.length,
        });

        return {
          content: [{ type: "text", text: JSON.stringify({
            cases: list,
            count: list.length,
            complete,
            ...(nextPageToken ? { next_page_token: nextPageToken } : {}),
            ...(!complete && !page_token ? { warning: `INCOMPLETE RESULT — not the full case list. ${incompleteReason ?? ""} Verify in MyCase.` } : {}),
          }) }],
        };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({ tool: "list-cases", args: { status, page_size, page_token, updated_after }, outcome: "error", firm_uuid: tokens?.firm_uuid, error: msg });
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

        await auditLog({ tool: "get-case", args: { case_id }, outcome: "success", firm_uuid: tokens?.firm_uuid, case_id, result_count: 1 });
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      } catch (err: unknown) {
        if (err instanceof MyCaseApiError && err.status === 404) {
          await auditLog({ tool: "get-case", args: { case_id }, outcome: "success", firm_uuid: tokens?.firm_uuid, case_id, result_count: 0 });
          // Returning JSON (not isError) so the LLM treats "not found" as data, not a tool failure
          return { content: [{ type: "text", text: JSON.stringify({ error: `Case ${case_id} not found.` }) }] };
        }
        const msg = (err as Error).message;
        await auditLog({ tool: "get-case", args: { case_id }, outcome: "error", firm_uuid: tokens?.firm_uuid, case_id, error: msg });
        return { content: [{ type: "text", text: `Error fetching case: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    "create-case",
    "Create a new case in MyCase.",
    {
      name: z.string().min(1).describe("The case name. Must be unique within your firm."),
      status: z.enum(["open", "closed"]).optional().default("open"),
      case_number: z.string().optional().describe("Your firm's own identifier for this case."),
      opened_date: z.string().optional().describe("Date the case was opened, YYYY-MM-DD."),
      description: z.string().optional(),
      practice_area: z.string().optional().describe("Must match a practice area name in MyCase (case-insensitive)."),
      case_stage: z.string().optional().describe("Must match a case stage name in MyCase (case-insensitive)."),
      sol_date: z.string().optional().describe("Statute of limitations date, YYYY-MM-DD."),
      client_ids: z.array(z.number().int()).optional().describe("IDs of clients to associate with the case."),
      company_ids: z.array(z.number().int()).optional().describe("IDs of companies to associate with the case."),
      staff: z.array(z.object({
        id: z.number().int().describe("Staff member ID."),
        lead_lawyer: z.boolean().optional(),
        originating_lawyer: z.boolean().optional(),
      })).optional().describe("Staff members to associate with the case."),
    },
    async ({ name, status, case_number, opened_date, description, practice_area, case_stage, sol_date, client_ids, company_ids, staff }) => {
      const tokens = await loadTokens();
      try {
        const body: Record<string, unknown> = {
          name,
          status,
          ...(case_number && { case_number }),
          ...(opened_date && { opened_date }),
          ...(description && { description }),
          ...(practice_area && { practice_area }),
          ...(case_stage && { case_stage }),
          ...(sol_date && { sol_date }),
          ...(client_ids?.length && { clients: client_ids.map((id) => ({ id })) }),
          ...(company_ids?.length && { companies: company_ids.map((id) => ({ id })) }),
          ...(staff?.length && { staff }),
        };

        const data = await mycasePost("/cases", body);
        await auditLog({ tool: "create-case", args: { name, status }, outcome: "success", firm_uuid: tokens?.firm_uuid, result_count: 1 });
        return { content: [{ type: "text", text: JSON.stringify({ success: true, case: data }) }] };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({ tool: "create-case", args: { name, status }, outcome: "error", firm_uuid: tokens?.firm_uuid, error: msg });
        return { content: [{ type: "text", text: `Error creating case: ${msg}` }], isError: true };
      }
    }
  );
}
