import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mycaseGet, mycasePost, mycasePut, mycaseDelete } from "../mycase-client.js";
import { auditLog } from "../audit/logger.js";
import { loadTokens } from "../auth/token-store.js";

const LIST_MUTEX_ERROR = "Error: provide exactly one of case_id or client_id.";
const CREATE_MUTEX_ERROR = "Error: provide exactly one of case_id, client_id, or company_id.";

type NoteItem = {
  id: number;
  subject?: string;
  note?: string;
  archived?: boolean;
  date?: string | null;
  client?: { id: number } | null;
  company?: { id: number } | null;
  case?: { id: number } | null;
  created_by?: { id: number };
  updated_by?: { id: number };
  created_at?: string;
  updated_at?: string;
};

export const createNoteSchema = {
  subject: z.string().min(1).describe("Note subject/title."),
  note: z.string().min(1).describe("Note body text — the full narrative content of the note."),
  case_id: z.number().int().positive().optional().describe("ID of the case to attach the note to. Mutually exclusive with client_id and company_id."),
  client_id: z.number().int().positive().optional().describe("ID of the client to attach the note to. Mutually exclusive with case_id and company_id."),
  company_id: z.number().int().positive().optional().describe("ID of the company to attach the note to. Mutually exclusive with case_id and client_id."),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be in YYYY-MM-DD format, e.g. 2025-01-15")
    .optional()
    .describe("Date of the note in YYYY-MM-DD format. Defaults to today."),
};

export const updateNoteSchema = {
  id: z.number().int().positive().describe("ID of the note to update."),
  subject: z.string().min(1).describe("Note subject/title."),
  note: z.string().min(1).describe("Note body text — the full narrative content of the note."),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be in YYYY-MM-DD format, e.g. 2025-01-15")
    .describe("Date of the note in YYYY-MM-DD format."),
};

export const listNotesSchema = {
  case_id: z.number().int().positive().optional().describe("ID of the case to list notes for. Mutually exclusive with client_id."),
  client_id: z.number().int().positive().optional().describe("ID of the client to list notes for. Mutually exclusive with case_id."),
  page_size: z.number().int().min(1).max(100).optional().default(25),
  page_token: z.string().optional().describe("Cursor token for the next page."),
};

export function registerNoteTools(server: McpServer): void {
  server.tool(
    "list-notes",
    "List notes from MyCase for a specific case or client. Provide exactly one of case_id or client_id.",
    listNotesSchema,
    async ({ case_id, client_id, page_size, page_token }) => {
      const tokens = await loadTokens();

      const provided = [case_id, client_id].filter((v) => v !== undefined);
      if (provided.length !== 1) {
        await auditLog({ tool: "list-notes", args: { case_id, client_id }, outcome: "error", firm_uuid: tokens?.firm_uuid, error: LIST_MUTEX_ERROR });
        return { content: [{ type: "text", text: LIST_MUTEX_ERROR }], isError: true };
      }

      const path = case_id !== undefined ? `/cases/${case_id}/notes` : `/clients/${client_id}/notes`;
      const auditCaseId = case_id !== undefined ? String(case_id) : undefined;

      try {
        const params: Record<string, string | number | undefined> = { page_size };
        if (page_token) params["page_token"] = page_token;
        const data = await mycaseGet(path, params);
        const notes = Array.isArray(data) ? data : [];
        await auditLog({ tool: "list-notes", args: { case_id, client_id, page_size, page_token }, outcome: "success", firm_uuid: tokens?.firm_uuid, case_id: auditCaseId, result_count: notes.length });
        return { content: [{ type: "text", text: JSON.stringify({ notes }) }] };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({ tool: "list-notes", args: { case_id, client_id, page_size, page_token }, outcome: "error", firm_uuid: tokens?.firm_uuid, case_id: auditCaseId, error: msg });
        return { content: [{ type: "text", text: `Error listing notes: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    "get-note",
    "Get an individual note by ID from MyCase.",
    {
      id: z.number().int().positive().describe("ID of the note to retrieve."),
    },
    async ({ id }) => {
      const tokens = await loadTokens();
      try {
        const data = await mycaseGet(`/notes/${id}`) as NoteItem;
        await auditLog({ tool: "get-note", args: { id }, outcome: "success", firm_uuid: tokens?.firm_uuid, result_count: 1 });
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({ tool: "get-note", args: { id }, outcome: "error", firm_uuid: tokens?.firm_uuid, error: msg });
        return { content: [{ type: "text", text: `Error getting note: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    "create-note",
    "Create a note in MyCase. Notes are the primary way attorneys document work narrative. Requires a subject and note body, plus exactly one of case_id, client_id, or company_id to attach the note to.",
    createNoteSchema,
    async ({ subject, note, case_id, client_id, company_id, date }) => {
      const tokens = await loadTokens();

      const provided = [case_id, client_id, company_id].filter((v) => v !== undefined);
      if (provided.length !== 1) {
        await auditLog({ tool: "create-note", args: { subject, case_id, client_id, company_id }, outcome: "error", firm_uuid: tokens?.firm_uuid, error: CREATE_MUTEX_ERROR });
        return { content: [{ type: "text", text: CREATE_MUTEX_ERROR }], isError: true };
      }

      const noteDate = date ?? new Date().toISOString().slice(0, 10);

      let path: string;
      if (case_id !== undefined) {
        path = `/cases/${case_id}/notes`;
      } else if (client_id !== undefined) {
        path = `/clients/${client_id}/notes`;
      } else {
        path = `/companies/${company_id}/notes`;
      }

      try {
        const data = await mycasePost(path, { subject, note, date: noteDate }) as NoteItem;
        await auditLog({
          tool: "create-note",
          args: { subject, case_id, client_id, company_id, date: noteDate },
          outcome: "success",
          firm_uuid: tokens?.firm_uuid,
          case_id: case_id !== undefined ? String(case_id) : undefined,
          result_count: 1,
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, id: data?.id, subject: data?.subject ?? subject }) }],
        };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({
          tool: "create-note",
          args: { subject, case_id, client_id, company_id, date: noteDate },
          outcome: "error",
          firm_uuid: tokens?.firm_uuid,
          case_id: case_id !== undefined ? String(case_id) : undefined,
          error: msg,
        });
        return { content: [{ type: "text", text: `Error creating note: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    "update-note",
    "Update an existing note in MyCase. Replaces the subject, body text, and date.",
    updateNoteSchema,
    async ({ id, subject, note, date }) => {
      const tokens = await loadTokens();
      try {
        await mycasePut(`/notes/${id}`, { subject, note, date });
        await auditLog({ tool: "update-note", args: { id, subject, date }, outcome: "success", firm_uuid: tokens?.firm_uuid });
        return { content: [{ type: "text", text: JSON.stringify({ success: true }) }] };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({ tool: "update-note", args: { id, subject, date }, outcome: "error", firm_uuid: tokens?.firm_uuid, error: msg });
        return { content: [{ type: "text", text: `Error updating note: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    "delete-note",
    "Delete a note from MyCase.",
    {
      id: z.number().int().positive().describe("ID of the note to delete."),
    },
    async ({ id }) => {
      const tokens = await loadTokens();
      try {
        await mycaseDelete(`/notes/${id}`);
        await auditLog({ tool: "delete-note", args: { id }, outcome: "success", firm_uuid: tokens?.firm_uuid });
        return { content: [{ type: "text", text: JSON.stringify({ success: true }) }] };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({ tool: "delete-note", args: { id }, outcome: "error", firm_uuid: tokens?.firm_uuid, error: msg });
        return { content: [{ type: "text", text: `Error deleting note: ${msg}` }], isError: true };
      }
    }
  );
}
