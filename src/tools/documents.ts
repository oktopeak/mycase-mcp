import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mycaseGet, MyCaseApiError } from "../mycase-client.js";
import { auditLog } from "../audit/logger.js";
import { loadTokens } from "../auth/token-store.js";

export function registerDocumentTools(server: McpServer): void {
  server.tool(
    "list-documents",
    "List documents in MyCase, optionally filtered by case.",
    {
      case_id: z.string().optional().describe("Filter documents by case ID (undocumented param — may not work for all firms)."),
      page_size: z.number().int().min(1).max(1000).optional().default(25),
      page_token: z.string().optional().describe("Cursor token for the next page."),
    },
    async ({ case_id, page_size, page_token }) => {
      const tokens = await loadTokens();
      try {
        const params: Record<string, string | number | undefined> = { page_size };
        if (page_token) params["page_token"] = page_token;
        if (case_id) params["case_id"] = case_id;

        type DocItem = {
          id: number | string;
          name?: string;
          filename?: string;
          path?: string;
          description?: string;
          assigned_date?: string;
          case?: { id: number | string };
          created_at?: string;
          updated_at?: string;
          self_url?: string;
          folder?: { id: number | string };
        };

        const result = await mycaseGet("/documents", params);
        const docs = Array.isArray(result.data) ? result.data as DocItem[] : [];
        const next_page_token = result.next_page_token;
        const total = result.total;

        await auditLog({ tool: "list-documents", args: { case_id, page_size, page_token }, outcome: "success", firm_uuid: tokens?.firm_uuid, case_id, result_count: docs.length });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                documents: docs.map((d) => ({
                  id: d.id,
                  name: d.name,
                  filename: d.filename,
                  path: d.path,
                  description: d.description,
                  assigned_date: d.assigned_date,
                  case: d.case,
                  created_at: d.created_at,
                  updated_at: d.updated_at,
                  self_url: d.self_url,
                })),
                ...(total !== undefined && { total }),
                ...(next_page_token && { next_page_token }),
              }),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({ tool: "list-documents", args: { case_id, page_size, page_token }, outcome: "error", firm_uuid: tokens?.firm_uuid, case_id, error: msg });
        return { content: [{ type: "text", text: `Error listing documents: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    "get-document-url",
    "Get the download URL for a document by its ID.",
    {
      document_id: z.string().describe("The MyCase document ID."),
    },
    async ({ document_id }) => {
      const tokens = await loadTokens();
      try {
        const result = await mycaseGet(`/documents/${document_id}`);
        const data = result.data as {
          document?: {
            id: number | string;
            name?: string;
            filename?: string;
            content_type?: string;
            size?: number;
            download_url?: string;
            url?: string;
            expires_at?: string;
          };
        };

        const doc = data?.document ?? (data as typeof data["document"]);
        // Prefer download_url, fall back to url
        const downloadUrl = (doc as { download_url?: string; url?: string })?.download_url
          ?? (doc as { url?: string })?.url;

        await auditLog({ tool: "get-document-url", args: { document_id }, outcome: "success", firm_uuid: tokens?.firm_uuid, result_count: 1 });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                id: document_id,
                name: (doc as { name?: string; filename?: string })?.name ?? (doc as { filename?: string })?.filename,
                download_url: downloadUrl,
                content_type: (doc as { content_type?: string })?.content_type,
                size: (doc as { size?: number })?.size,
                expires_at: (doc as { expires_at?: string })?.expires_at,
              }),
            },
          ],
        };
      } catch (err: unknown) {
        if (err instanceof MyCaseApiError && err.status === 404) {
          await auditLog({ tool: "get-document-url", args: { document_id }, outcome: "success", firm_uuid: tokens?.firm_uuid, result_count: 0 });
          return { content: [{ type: "text", text: JSON.stringify({ error: `Document ${document_id} not found.` }) }] };
        }
        const msg = (err as Error).message;
        await auditLog({ tool: "get-document-url", args: { document_id }, outcome: "error", firm_uuid: tokens?.firm_uuid, error: msg });
        return { content: [{ type: "text", text: `Error fetching document URL: ${msg}` }], isError: true };
      }
    }
  );
}
