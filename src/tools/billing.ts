import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mycaseGet, mycasePost, mycaseDelete } from "../mycase-client.js";
import { auditLog } from "../audit/logger.js";
import { loadTokens } from "../auth/token-store.js";

type TimeEntryResponse = {
  id?: number;
  activity_name?: string;
  description?: string;
  billable?: boolean;
  entry_date?: string;
  rate?: string;
  hours?: number;
  flat_fee?: boolean;
  case?: { id?: number };
  staff?: { id?: number };
  invoices?: Array<{ id?: number }>;
  created_at?: string;
  updated_at?: string;
};

function mapEntry(e: TimeEntryResponse) {
  return {
    id: e.id,
    activity_name: e.activity_name,
    description: e.description,
    billable: e.billable,
    entry_date: e.entry_date,
    rate: e.rate,
    hours: e.hours,
    flat_fee: e.flat_fee,
    case: e.case,
    staff: e.staff,
    created_at: e.created_at,
    updated_at: e.updated_at,
  };
}

export const listTimeEntriesSchema = {
  case_id: z.string().optional().describe("Filter time entries by case ID."),
  updated_after: z.string().regex(/^\d{4}-\d{2}-\d{2}(T[\d:]+(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/).optional().describe("Return entries created or updated after this date/time (ISO 8601, e.g. 2025-01-01 or 2025-01-01T00:00:00Z)."),
  page_size: z.number().int().min(1).max(1000).optional().default(25).describe("Number of results per page (1–1000)."),
  page_token: z.string().optional().describe("Pagination cursor from a previous response."),
};

export const logTimeEntrySchema = {
  case_id: z.number().int().positive().describe("The MyCase case ID to log time against."),
  staff_id: z.number().int().positive().describe("The staff member ID performing the work."),
  activity_name: z.string().min(1).describe("Activity name associated with this time entry (e.g. 'Research', 'Drafting')."),
  hours: z.number().positive().describe("Duration in hours (decimal, e.g. 1.5)."),
  entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Date of the time entry (YYYY-MM-DD)."),
  rate: z.number().positive().describe("Hourly billing rate in dollars."),
  description: z.string().optional().describe("Description of the work performed."),
  billable: z.boolean().optional().default(true).describe("Whether this entry is billable. Defaults to true."),
  flat_fee: z.boolean().optional().describe("Whether this is a flat fee rather than an hourly entry."),
};

export function registerBillingTools(server: McpServer): void {
  server.tool(
    "list-time-entries",
    "List time entries from MyCase, optionally filtered by case or updated date.",
    listTimeEntriesSchema,
    async ({ case_id, updated_after, page_size, page_token }) => {
      const tokens = await loadTokens();
      try {
        const params: Record<string, string | number | undefined> = { page_size };
        if (case_id) params["case_id"] = case_id;
        if (updated_after) params["filter[updated_after]"] = updated_after;
        if (page_token) params["page_token"] = page_token;

        const data = await mycaseGet("/time_entries", params) as TimeEntryResponse[];

        const entries = Array.isArray(data) ? data : [];
        await auditLog({ tool: "list-time-entries", args: { case_id, updated_after, page_size, page_token }, outcome: "success", firm_uuid: tokens?.firm_uuid, case_id, result_count: entries.length });

        return {
          content: [{ type: "text", text: JSON.stringify({ time_entries: entries.map(mapEntry) }) }],
        };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({ tool: "list-time-entries", args: { case_id, updated_after, page_size, page_token }, outcome: "error", firm_uuid: tokens?.firm_uuid, case_id, error: msg });
        return { content: [{ type: "text", text: `Error listing time entries: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    "get-time-entry",
    "Get an individual time entry by ID from MyCase.",
    {
      id: z.number().int().positive().describe("The time entry ID."),
    },
    async ({ id }) => {
      const tokens = await loadTokens();
      try {
        const data = await mycaseGet(`/time_entries/${id}`) as TimeEntryResponse;
        const caseId = data?.case?.id?.toString();

        await auditLog({ tool: "get-time-entry", args: { id }, outcome: "success", firm_uuid: tokens?.firm_uuid, case_id: caseId, result_count: 1 });

        return {
          content: [{ type: "text", text: JSON.stringify(mapEntry(data)) }],
        };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({ tool: "get-time-entry", args: { id }, outcome: "error", firm_uuid: tokens?.firm_uuid, error: msg });
        return { content: [{ type: "text", text: `Error fetching time entry: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    "log-time-entry",
    "Create a time entry in MyCase for a case.",
    logTimeEntrySchema,
    async ({ case_id, staff_id, activity_name, hours, entry_date, rate, description, billable, flat_fee }) => {
      const tokens = await loadTokens();
      try {
        const body: Record<string, unknown> = {
          activity_name,
          entry_date,
          rate,
          hours,
          case: { id: case_id },
          staff: { id: staff_id },
          billable: billable ?? true,
          ...(description !== undefined && { description }),
          ...(flat_fee !== undefined && { flat_fee }),
        };

        const data = await mycasePost("/time_entries", body) as TimeEntryResponse;
        if (!data) throw new Error("API returned an empty response for time entry creation");

        await auditLog({
          tool: "log-time-entry",
          args: { case_id: String(case_id), staff_id, activity_name, hours, entry_date, rate, description, billable, flat_fee },
          outcome: "success",
          firm_uuid: tokens?.firm_uuid,
          case_id: String(case_id),
          result_count: 1,
        });

        return {
          content: [{ type: "text", text: JSON.stringify(mapEntry(data)) }],
        };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({
          tool: "log-time-entry",
          args: { case_id: String(case_id), staff_id, activity_name, hours, entry_date, rate, description, billable, flat_fee },
          outcome: "error",
          firm_uuid: tokens?.firm_uuid,
          case_id: String(case_id),
          error: msg,
        });
        return { content: [{ type: "text", text: `Error logging time entry: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    "delete-time-entry",
    "Delete an individual time entry by ID from MyCase.",
    {
      id: z.number().int().positive().describe("The time entry ID to delete."),
    },
    async ({ id }) => {
      const tokens = await loadTokens();
      try {
        await mycaseDelete(`/time_entries/${id}`);

        await auditLog({ tool: "delete-time-entry", args: { id }, outcome: "success", firm_uuid: tokens?.firm_uuid });

        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, id }) }],
        };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({ tool: "delete-time-entry", args: { id }, outcome: "error", firm_uuid: tokens?.firm_uuid, error: msg });
        return { content: [{ type: "text", text: `Error deleting time entry: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    "get-billing-summary",
    "Get a billing summary for a MyCase case: total billed, outstanding, and invoices.",
    {
      case_id: z.string().describe("The MyCase case ID."),
    },
    async ({ case_id }) => {
      const tokens = await loadTokens();
      try {
        const data = await mycaseGet("/invoices", { case_id, per_page: 200 }) as {
          invoices?: Array<{
            id: number | string;
            invoice_number?: string;
            status?: string;
            issued_at?: string;
            due_date?: string;
            total?: number;
            balance?: number;
            paid_amount?: number;
          }>;
          meta?: { total_billed?: number; total_outstanding?: number; total_paid?: number };
        };

        const invoices = data?.invoices ?? [];
        let totalBilled = data?.meta?.total_billed ?? 0;
        let totalOutstanding = data?.meta?.total_outstanding ?? 0;
        let totalPaid = data?.meta?.total_paid ?? 0;

        if (data?.meta?.total_billed === undefined) {
          for (const inv of invoices) {
            if (inv.status !== "void" && inv.status !== "draft") {
              totalBilled += inv.total ?? 0;
              totalOutstanding += inv.balance ?? 0;
              totalPaid += inv.paid_amount ?? 0;
            }
          }
        }

        const lastInvoice = invoices
          .filter((i) => i.status !== "void" && i.status !== "draft")
          .sort((a, b) => (b.issued_at ?? "").localeCompare(a.issued_at ?? ""))[0];

        await auditLog({ tool: "get-billing-summary", args: { case_id }, outcome: "success", firm_uuid: tokens?.firm_uuid, case_id, result_count: invoices.length });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                case_id,
                total_billed: totalBilled,
                total_outstanding: totalOutstanding,
                total_paid: totalPaid,
                last_invoice_date: lastInvoice?.issued_at ?? null,
                invoice_count: invoices.filter((i) => i.status !== "void" && i.status !== "draft").length,
                invoices: invoices.map((i) => ({
                  id: i.id,
                  invoice_number: i.invoice_number,
                  status: i.status,
                  issued_at: i.issued_at,
                  due_date: i.due_date,
                  total: i.total,
                  balance: i.balance,
                })),
              }),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({ tool: "get-billing-summary", args: { case_id }, outcome: "error", firm_uuid: tokens?.firm_uuid, case_id, error: msg });
        return { content: [{ type: "text", text: `Error fetching billing summary: ${msg}` }], isError: true };
      }
    }
  );
}
