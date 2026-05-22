import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mycaseGet } from "../mycase-client.js";
import { auditLog } from "../audit/logger.js";
import { loadTokens } from "../auth/token-store.js";

export function registerBillingTools(server: McpServer): void {
  server.tool(
    "list-time-entries",
    "List billable time entries from MyCase, optionally filtered by case or updated date.",
    {
      case_id: z.string().optional().describe("Filter time entries by case ID (undocumented param — may not work for all firms)."),
      updated_after: z.string().optional().describe("ISO 8601 date — return only entries created or updated after this date."),
      page_size: z.number().int().min(1).max(1000).optional().default(25),
      page_token: z.string().optional().describe("Cursor token for the next page."),
    },
    async ({ case_id, updated_after, page_size, page_token }) => {
      const tokens = await loadTokens();
      try {
        const params: Record<string, string | number | undefined> = { page_size };
        if (page_token) params["page_token"] = page_token;
        if (case_id) params["case_id"] = case_id;
        if (updated_after) params["filter[updated_after]"] = updated_after;

        type TimeEntryItem = {
          id: number | string;
          activity_name?: string;
          description?: string;
          billable?: boolean;
          entry_date?: string;
          rate?: string;
          hours?: number;
          flat_fee?: boolean;
          case?: { id: number | string };
          staff?: { id: number | string };
          created_at?: string;
          updated_at?: string;
        };

        const result = await mycaseGet("/time_entries", params);
        const entries = Array.isArray(result.data) ? result.data as TimeEntryItem[] : [];
        const next_page_token = result.next_page_token;
        const total = result.total;

        await auditLog({ tool: "list-time-entries", args: { case_id, updated_after, page_size, page_token }, outcome: "success", firm_uuid: tokens?.firm_uuid, case_id, result_count: entries.length });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                time_entries: entries.map((e) => ({
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
                })),
                ...(total !== undefined && { total }),
                ...(next_page_token && { next_page_token }),
              }),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({ tool: "list-time-entries", args: { case_id, updated_after, page_size, page_token }, outcome: "error", firm_uuid: tokens?.firm_uuid, case_id, error: msg });
        return { content: [{ type: "text", text: `Error listing time entries: ${msg}` }], isError: true };
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
        const invoiceResult = await mycaseGet("/invoices", { case_id, page_size: 200 });
        const data = invoiceResult.data as {
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
