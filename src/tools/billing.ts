import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mycaseGet } from "../mycase-client.js";
import { auditLog } from "../audit/logger.js";
import { loadTokens } from "../auth/token-store.js";

export function registerBillingTools(server: McpServer): void {
  server.tool(
    "list-time-entries",
    "List billable time entries from MyCase, optionally filtered by case or date range.",
    {
      case_id: z.string().optional().describe("Filter time entries by case ID."),
      start_date: z.string().optional().describe("Filter entries on or after this date (YYYY-MM-DD)."),
      end_date: z.string().optional().describe("Filter entries on or before this date (YYYY-MM-DD)."),
      limit: z.number().int().min(1).max(200).optional().default(25),
      page: z.number().int().min(1).optional().default(1),
    },
    async ({ case_id, start_date, end_date, limit, page }) => {
      const tokens = await loadTokens();
      try {
        const params: Record<string, string | number | undefined> = { per_page: limit, page };
        if (case_id) params["case_id"] = case_id;
        if (start_date) params["start_date"] = start_date;
        if (end_date) params["end_date"] = end_date;

        const data = await mycaseGet("/time_entries", params) as {
          time_entries?: Array<{
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
          }>;
          meta?: { total?: number; total_hours?: number; total_amount?: number };
        };

        const entries = data?.time_entries ?? [];
        await auditLog({ tool: "list-time-entries", args: { case_id, start_date, end_date, limit, page }, outcome: "success", user_id: tokens?.user_id, case_id, result_count: entries.length });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                time_entries: entries.map((e) => ({
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
                total: data?.meta?.total,
                total_hours: data?.meta?.total_hours,
                total_amount: data?.meta?.total_amount,
              }),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({ tool: "list-time-entries", args: { case_id, start_date, end_date, limit, page }, outcome: "error", user_id: tokens?.user_id, case_id, error: msg });
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

        if (!data?.meta?.total_billed) {
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

        await auditLog({ tool: "get-billing-summary", args: { case_id }, outcome: "success", user_id: tokens?.user_id, case_id, result_count: invoices.length });

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
        await auditLog({ tool: "get-billing-summary", args: { case_id }, outcome: "error", user_id: tokens?.user_id, case_id, error: msg });
        return { content: [{ type: "text", text: `Error fetching billing summary: ${msg}` }], isError: true };
      }
    }
  );
}
