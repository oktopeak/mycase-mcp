import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mycaseGet, mycaseGetAll, MyCaseApiError } from "../mycase-client.js";
import { auditLog } from "../audit/logger.js";
import { loadTokens } from "../auth/token-store.js";

type DocumentItem = {
  id: number | string;
  name?: string;
  filename?: string;
  content_type?: string;
  size?: number;
  created_at?: string;
  updated_at?: string;
  case?: { id: number | string; name?: string };
  created_by?: { id: number | string; name?: string };
};

export function registerDocumentTools(server: McpServer): void {
  server.tool(
    "list-documents",
    "List documents in MyCase, optionally filtered by case. Pages through the full list and says whether the result is complete.",
    {
      case_id: z.string().optional().describe("Filter documents by case ID."),
      limit: z.number().int().min(1).max(1000).optional().default(200).describe("Max documents to return after filtering."),
    },
    async ({ case_id, limit }) => {
      const tokens = await loadTokens();
      try {
        // MyCase list endpoints return a bare array, and a server-side case filter on
        // /documents is unconfirmed. Fetch every page and filter here, the same way
        // list-tasks does; reading a `documents` key off the response is what made
        // this tool return [] for every case.
        const result = await mycaseGetAll<DocumentItem>("/documents");
        let docs = result.items;
        if (case_id !== undefined) docs = docs.filter((d) => String(d.case?.id) === String(case_id));
        const matched = docs.length;
        const cap = limit ?? 200;
        docs = docs.slice(0, cap);

        await auditLog({ tool: "list-documents", args: { case_id, limit }, outcome: "success", firm_uuid: tokens?.firm_uuid, case_id, result_count: docs.length });

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
                count: docs.length,
                matched,
                complete: result.complete && matched <= cap,
                ...(!result.complete
                  ? { warning: `INCOMPLETE RESULT — not the full document list. ${result.incompleteReason} Verify in MyCase.` }
                  : matched > cap
                    ? { warning: `Showing ${cap} of ${matched} matching documents. Raise limit to see the rest.` }
                    : {}),
              }),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({ tool: "list-documents", args: { case_id, limit }, outcome: "error", firm_uuid: tokens?.firm_uuid, case_id, error: msg });
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
