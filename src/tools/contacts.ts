import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mycaseGet, MyCaseApiError } from "../mycase-client.js";
import { fetchAllPages, MAX_PAGE_SIZE } from "../utils/pagination.js";
import { auditLog } from "../audit/logger.js";
import { loadTokens } from "../auth/token-store.js";

type ClientItem = {
  id: number | string;
  first_name?: string;
  middle_name?: string;
  last_name?: string;
  email?: string;
  cell_phone_number?: string;
  work_phone_number?: string;
  home_phone_number?: string;
  fax_phone_number?: string;
  address?: { address1?: string; address2?: string; city?: string; state?: string; zip_code?: string; country?: string };
  notes?: string;
  birthdate?: string;
  archived?: boolean;
  cases?: Array<{ id: number }>;
  people_group?: { id: number };
  created_at?: string;
  updated_at?: string;
};

export function registerContactTools(server: McpServer): void {
  server.tool(
    "search-contacts",
    "Search for clients (people) in MyCase by name, email, or phone. Always pages through every result. The response's `complete` field reports whether every page was fetched; if false, pass `page_token` back in to continue.",
    {
      first_name: z.string().optional().describe("Filter by first name (exact match)."),
      last_name: z.string().optional().describe("Filter by last name (exact match)."),
      email: z.string().optional().describe("Filter by email address."),
      phone: z.string().optional().describe("Filter by cell phone number."),
      page_size: z.number().int().min(1).max(MAX_PAGE_SIZE).optional().default(25),
      page_token: z.string().optional().describe("Cursor token to resume pagination from, e.g. after a truncated response."),
    },
    async ({ first_name, last_name, email, phone, page_size, page_token }) => {
      const tokens = await loadTokens();
      try {
        const params: Record<string, string | number | undefined> = { page_size };
        if (first_name) params["filter[first_name]"] = first_name;
        if (last_name) params["filter[last_name]"] = last_name;
        if (email) params["filter[email]"] = email;
        if (phone) params["filter[cell_phone_number]"] = phone;

        const { items, complete, next_page_token, truncated_reason } = await fetchAllPages<ClientItem>(
          "/clients",
          params,
          { startCursor: page_token }
        );

        await auditLog({ tool: "search-contacts", args: { first_name, last_name, email, phone, page_size, page_token }, outcome: "success", firm_uuid: tokens?.firm_uuid, result_count: items.length });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                clients: items.map((c) => ({
                  id: c.id,
                  first_name: c.first_name,
                  last_name: c.last_name,
                  name: `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim(),
                  email: c.email,
                  cell_phone: c.cell_phone_number,
                  work_phone: c.work_phone_number,
                  archived: c.archived,
                  cases: c.cases,
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
        await auditLog({ tool: "search-contacts", args: { first_name, last_name, email, phone }, outcome: "error", firm_uuid: tokens?.firm_uuid, error: msg });
        return { content: [{ type: "text", text: `Error searching clients: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    "get-contact",
    "Get full details for a single client (person) by ID.",
    {
      contact_id: z.string().describe("The MyCase client ID."),
    },
    async ({ contact_id }) => {
      const tokens = await loadTokens();
      try {
        const data = await mycaseGet(`/clients/${contact_id}`) as ClientItem;

        await auditLog({ tool: "get-contact", args: { contact_id }, outcome: "success", firm_uuid: tokens?.firm_uuid, result_count: 1 });
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      } catch (err: unknown) {
        if (err instanceof MyCaseApiError && err.status === 404) {
          await auditLog({ tool: "get-contact", args: { contact_id }, outcome: "success", firm_uuid: tokens?.firm_uuid, result_count: 0 });
          // Returning JSON (not isError) so the LLM treats "not found" as data, not a tool failure
          return { content: [{ type: "text", text: JSON.stringify({ error: `Client ${contact_id} not found.` }) }] };
        }
        const msg = (err as Error).message;
        await auditLog({ tool: "get-contact", args: { contact_id }, outcome: "error", firm_uuid: tokens?.firm_uuid, error: msg });
        return { content: [{ type: "text", text: `Error fetching client: ${msg}` }], isError: true };
      }
    }
  );
}
