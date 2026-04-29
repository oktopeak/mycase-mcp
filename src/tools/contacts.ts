import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mycaseGet, MyCaseApiError } from "../mycase-client.js";
import { auditLog } from "../audit/logger.js";
import { loadTokens } from "../auth/token-store.js";

export function registerContactTools(server: McpServer): void {
  server.tool(
    "search-contacts",
    "Search for contacts (clients, people, companies) in MyCase.",
    {
      query: z.string().optional().describe("Search term — name, email, or phone."),
      type: z.enum(["person", "company", "all"]).optional().default("all"),
      limit: z.number().int().min(1).max(200).optional().default(25),
      page: z.number().int().min(1).optional().default(1),
    },
    async ({ query, type, limit, page }) => {
      const tokens = await loadTokens();
      try {
        const params: Record<string, string | number | undefined> = { per_page: limit, page };
        if (query) params["query"] = query;
        if (type && type !== "all") params["type"] = type;

        const data = await mycaseGet("/contacts", params) as {
          contacts?: Array<{
            id: number | string;
            name?: string;
            first_name?: string;
            last_name?: string;
            type?: string;
            email?: string;
            phone?: string;
            company?: string;
          }>;
          meta?: { total?: number };
        };

        const contacts = data?.contacts ?? [];
        await auditLog({ tool: "search-contacts", args: { query, type, limit, page }, outcome: "success", user_id: tokens?.user_id, result_count: contacts.length });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                contacts: contacts.map((c) => ({
                  id: c.id,
                  name: c.name ?? `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim(),
                  type: c.type,
                  email: c.email,
                  phone: c.phone,
                  company: c.company,
                })),
                total: data?.meta?.total,
              }),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({ tool: "search-contacts", args: { query, type, limit, page }, outcome: "error", user_id: tokens?.user_id, error: msg });
        return { content: [{ type: "text", text: `Error searching contacts: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    "get-contact",
    "Get full details for a single contact by ID.",
    {
      contact_id: z.string().describe("The MyCase contact ID."),
    },
    async ({ contact_id }) => {
      const tokens = await loadTokens();
      try {
        const data = await mycaseGet(`/contacts/${contact_id}`) as {
          contact?: {
            id: number | string;
            name?: string;
            first_name?: string;
            last_name?: string;
            type?: string;
            email?: string;
            phone?: string;
            mobile_phone?: string;
            company?: string;
            job_title?: string;
            address?: { street?: string; city?: string; state?: string; zip?: string; country?: string };
            notes?: string;
            created_at?: string;
            updated_at?: string;
          };
        };

        await auditLog({ tool: "get-contact", args: { contact_id }, outcome: "success", user_id: tokens?.user_id, result_count: 1 });
        return { content: [{ type: "text", text: JSON.stringify(data?.contact ?? data) }] };
      } catch (err: unknown) {
        if (err instanceof MyCaseApiError && err.status === 404) {
          await auditLog({ tool: "get-contact", args: { contact_id }, outcome: "success", user_id: tokens?.user_id, result_count: 0 });
          return { content: [{ type: "text", text: JSON.stringify({ error: `Contact ${contact_id} not found.` }) }] };
        }
        const msg = (err as Error).message;
        await auditLog({ tool: "get-contact", args: { contact_id }, outcome: "error", user_id: tokens?.user_id, error: msg });
        return { content: [{ type: "text", text: `Error fetching contact: ${msg}` }], isError: true };
      }
    }
  );
}
