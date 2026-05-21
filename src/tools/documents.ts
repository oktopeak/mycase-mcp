import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mycaseGet, mycasePost, s3Put, MyCaseApiError } from "../mycase-client.js";
import { auditLog } from "../audit/logger.js";
import { loadTokens } from "../auth/token-store.js";

// Defense-in-depth guardrail against accidental uploads of well-known secret files.
// This list is intentionally not exhaustive — it catches common mistakes, not all cases.
const BLOCKED_FILE_PATTERNS = [
  /\.env(\.|$)/i,
  /\.(pem|key|pfx|p12|p8|crt|cer)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(keystore|jks)$/i,
  /credentials/i,
  /\.secret$/i,
  /audit\.log$/i,
];

function assertSafeFilePath(filePath: string): void {
  const base = path.basename(filePath);
  if (BLOCKED_FILE_PATTERNS.some((re) => re.test(base))) {
    throw new Error(`Refusing to upload a potentially sensitive file: ${base}`);
  }
}

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

  server.tool(
    "upload-document",
    [
      "Upload a document to a MyCase case.",
      "",
      "IMPORTANT — two mutually exclusive input modes, use exactly one:",
      "",
      "Mode A · file_content_base64 (USE THIS when running inside Claude.ai or any other",
      "         AI assistant environment):",
      "  1. Read the file from disk using your file-reading tool (e.g. the Read tool).",
      "  2. Base64-encode the raw bytes.",
      "  3. Pass the result as file_content_base64 together with the filename parameter.",
      "  Do NOT pass the original file path — the MCP server runs in a separate process and",
      "  cannot access paths like /mnt/user-data/uploads/... or any Claude-side filesystem path.",
      "",
      "Mode B · file_path (only for files already on the MCP server's local filesystem):",
      "  Pass the absolute path to a file the MCP server process itself can open.",
      "  This will NOT work for files uploaded to Claude.ai.",
    ].join("\n"),
    {
      case_id: z.string().describe("The MyCase case ID to attach the document to."),
      name: z.string().optional().describe("Display name for the document. Defaults to the filename."),
      file_content_base64: z.string().optional().describe(
        "PREFERRED: Base64-encoded file content. Read the file with your file tool, encode it, and pass the result here. Required alongside 'filename'. Do not use file_path when running in Claude.ai."
      ),
      filename: z.string().optional().describe(
        "Filename including extension (e.g. 'report.pdf'). Required when using file_content_base64."
      ),
      file_path: z.string().optional().describe(
        "Absolute path to a file the MCP server process can open directly. Does NOT work for Claude.ai uploads — use file_content_base64 instead."
      ),
    },
    async ({ file_path, file_content_base64, filename: inputFilename, case_id, name }) => {
      const tokens = await loadTokens();
      // Compute best-effort filename for audit logs before any validation that might throw.
      const auditFilename = file_path ? path.basename(file_path) : (inputFilename ?? "unknown");

      try {
        if (!file_path && !file_content_base64) {
          throw new Error("Provide either file_path or file_content_base64 + filename");
        }
        if (file_path && file_content_base64) {
          throw new Error("Provide either file_path or file_content_base64, not both");
        }
        if (file_content_base64 && !inputFilename) {
          throw new Error("filename is required when using file_content_base64");
        }

        let fileContent: Buffer;
        let filename: string;

        if (file_path) {
          assertSafeFilePath(file_path);
          if (!path.isAbsolute(file_path)) {
            throw new Error("file_path must be an absolute path");
          }
          filename = path.basename(file_path);
          try {
            fileContent = await fs.readFile(file_path);
          } catch {
            throw new Error(`File not found: ${file_path}`);
          }
        } else {
          // file_content_base64 mode — MCP server never touches the filesystem.
          filename = inputFilename!;
          assertSafeFilePath(filename);
          fileContent = Buffer.from(file_content_base64!, "base64");
        }

        const displayName = name ?? filename;

        const MAX_SIZE = 50 * 1024 * 1024;
        if (fileContent.byteLength > MAX_SIZE) {
          throw new Error(`File size ${(fileContent.byteLength / (1024 * 1024)).toFixed(1)} MB exceeds the 50 MB limit`);
        }

        // Step 1: Create the document record in MyCase → receive a pre-signed S3 upload URL.
        const createData = await mycasePost(`/cases/${case_id}/documents`, {
          path: displayName,
          filename,
        }) as {
          id?: number | string;
          name?: string;
          put_url?: string;
          put_headers?: Record<string, string>;
        };

        if (!createData?.id || !createData?.put_url) {
          throw new Error("API did not return a document ID or S3 upload URL");
        }

        // Step 2: PUT raw bytes to the S3 pre-signed URL.
        // The MyCase API requires Content-Type: application/octet-stream regardless of file type.
        await s3Put(createData.put_url, createData.put_headers ?? {}, new Uint8Array(fileContent));

        await auditLog({
          tool: "upload-document",
          args: { case_id, filename },
          outcome: "success",
          firm_uuid: tokens?.firm_uuid,
          case_id,
          result_count: 1,
        });

        return {
          content: [{ type: "text", text: JSON.stringify({ id: createData.id, name: createData.name ?? displayName }) }],
        };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({
          tool: "upload-document",
          args: { case_id, filename: auditFilename },
          outcome: "error",
          firm_uuid: tokens?.firm_uuid,
          case_id,
          error: msg,
        });
        return { content: [{ type: "text", text: `Error uploading document: ${msg}` }], isError: true };
      }
    }
  );
}
