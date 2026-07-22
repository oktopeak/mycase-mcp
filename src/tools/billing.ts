import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages, MAX_PAGE_SIZE } from "../utils/pagination.js";
import { auditLog } from "../audit/logger.js";
import { loadTokens } from "../auth/token-store.js";

type TimeEntryItem = {
  id: number | string;
  date?: string;
  hours?: number;
  rate?: number;
  amount?: number;
  description?: string;
  billable?: boolean;
  billed?: boolean;
  case?: { id: number | string; name?: string };
  user?: { id: number | string; name?: string };
  activity_type?: string;
};

type InvoiceItem = {
  id: number | string;
  invoice_number?: string;
  status?: string;
  issued_at?: string;
  due_date?: string;
  total?: number;
  balance?: number;
  paid_amount?: number;
};

// MyCase list endpoints return a bare JSON array with no envelope. Kept as a
// fallback in case these endpoints are ever observed to still wrap results.
function extractTimeEntries(data: unknown): TimeEntryItem[] {
  if (Array.isArray(data)) return data as TimeEntryItem[];
  const entries = (data as { time_entries?: TimeEntryItem[] } | null)?.time_entries;
  return entries ?? [];
}

function extractInvoices(data: unknown): InvoiceItem[] {
  if (Array.isArray(data)) return data as InvoiceItem[];
  const invoices = (data as { invoices?: InvoiceItem[] } | null)?.invoices;
  return invoices ?? [];
}

export function registerBillingTools(server: McpServer): void {
  server.tool(
    "list-time-entries",
    "List billable time entries from MyCase, optionally filtered by case or date range. Always pages through every result. The response's `complete` field reports whether every page was fetched.",
    {
      case_id: z.string().optional().describe("Filter time entries by case ID."),
      start_date: z.string().optional().describe("Filter entries on or after this date (YYYY-MM-DD)."),
      end_date: z.string().optional().describe("Filter entries on or before this date (YYYY-MM-DD)."),
      limit: z.number().int().min(1).max(MAX_PAGE_SIZE).optional().default(25),
      page: z.number().int().min(1).optional().default(1),
    },
    async ({ case_id, start_date, end_date, limit, page }) => {
      const tokens = await loadTokens();
      try {
        const params: Record<string, string | number | undefined> = { page_size: limit };
        if (case_id) params["case_id"] = case_id;
        if (start_date) params["start_date"] = start_date;
        if (end_date) params["end_date"] = end_date;

        const { items, complete, next_page_token, truncated_reason } = await fetchAllPages<TimeEntryItem>(
          "/time_entries",
          params,
          { extractItems: extractTimeEntries }
        );

        await auditLog({ tool: "list-time-entries", args: { case_id, start_date, end_date, limit, page }, outcome: "success", firm_uuid: tokens?.firm_uuid, case_id, result_count: items.length });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                time_entries: items.map((e) => ({
                  id: e.id,
                  date: e.date,
                  hours: e.hours,
                  rate: e.rate,
                  amount: e.amount,
                  description: e.description,
                  billable: e.billable,
                  billed: e.billed,
                  case: e.case,
                  user: e.user,
                  activity_type: e.activity_type,
                })),
                total: complete ? items.length : undefined,
                total_hours: complete ? items.reduce((sum, e) => sum + (e.hours ?? 0), 0) : undefined,
                total_amount: complete ? items.reduce((sum, e) => sum + (e.amount ?? 0), 0) : undefined,
                complete,
                ...(next_page_token && { next_page_token }),
                ...(truncated_reason && { truncated_reason }),
              }),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({ tool: "list-time-entries", args: { case_id, start_date, end_date, limit, page }, outcome: "error", firm_uuid: tokens?.firm_uuid, case_id, error: msg });
        return { content: [{ type: "text", text: `Error listing time entries: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    "get-billing-summary",
    "Get a billing summary for a MyCase case: total billed, outstanding, and invoices. Always pages through every invoice for the case before totaling. The response's `complete` field reports whether every page was fetched — treat totals as a lower bound when false.",
    {
      case_id: z.string().describe("The MyCase case ID."),
    },
    async ({ case_id }) => {
      const tokens = await loadTokens();
      try {
        const { items: invoices, complete, next_page_token, truncated_reason } = await fetchAllPages<InvoiceItem>(
          "/invoices",
          { case_id, page_size: MAX_PAGE_SIZE },
          { extractItems: extractInvoices }
        );

        let totalBilled = 0;
        let totalOutstanding = 0;
        let totalPaid = 0;
        for (const inv of invoices) {
          if (inv.status !== "void" && inv.status !== "draft") {
            totalBilled += inv.total ?? 0;
            totalOutstanding += inv.balance ?? 0;
            totalPaid += inv.paid_amount ?? 0;
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
                complete,
                ...(next_page_token && { next_page_token }),
                ...(truncated_reason && { truncated_reason }),
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
