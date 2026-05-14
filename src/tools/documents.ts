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
      case_id: z.string().optional().describe("Filter documents by case ID."),
      limit: z.number().int().min(1).max(200).optional().default(25),
      page: z.number().int().min(1).optional().default(1),
    },
    async ({ case_id, limit, page }) => {
      const tokens = await loadTokens();
      try {
        const params: Record<string, string | number | undefined> = { per_page: limit, page };
        if (case_id) params["case_id"] = case_id;

        const data = await mycaseGet("/documents", params) as {
          documents?: Array<{
            id: number | string;
            name?: string;
            filename?: string;
            content_type?: string;
            size?: number;
            created_at?: string;
            updated_at?: string;
            case?: { id: number | string; name?: string };
            created_by?: { id: number | string; name?: string };
          }>;
          meta?: { total?: number };
        };

        const docs = data?.documents ?? [];
        await auditLog({ tool: "list-documents", args: { case_id, limit, page }, outcome: "success", firm_uuid: tokens?.firm_uuid, case_id, result_count: docs.length });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                documents: docs.map((d) => ({
                  id: d.id,
                  name: d.name ?? d.filename,
                  content_type: d.content_type,
                  size: d.size,
                  created_at: d.created_at,
                  case: d.case,
                  created_by: d.created_by,
                })),
                total: data?.meta?.total,
              }),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({ tool: "list-documents", args: { case_id, limit, page }, outcome: "error", firm_uuid: tokens?.firm_uuid, case_id, error: msg });
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
        const data = await mycaseGet(`/documents/${document_id}`) as {
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
