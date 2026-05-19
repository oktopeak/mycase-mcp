import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mycaseGet, mycasePost, mycasePut, mycaseDelete } from "../mycase-client.js";
import { auditLog } from "../audit/logger.js";
import { loadTokens } from "../auth/token-store.js";

const CALLER_MUTEX_ERROR = "Error: provide exactly one of caller_name, client_id, or lead_id.";

function buildCallBody(
  fields: {
    called_at: string;
    caller_phone_number: string;
    call_for_staff_id: number;
    message: string;
    caller_name?: string;
    client_id?: number;
    lead_id?: number;
    call_type?: "incoming" | "outgoing";
    resolved?: boolean;
  }
): Record<string, unknown> {
  const { called_at, caller_phone_number, call_for_staff_id, message, caller_name, client_id, lead_id, call_type, resolved } = fields;
  return {
    called_at,
    caller_phone_number,
    call_for: { id: call_for_staff_id },
    message,
    ...(caller_name !== undefined && { caller_name }),
    ...(client_id !== undefined && { client: { id: client_id } }),
    ...(lead_id !== undefined && { lead: { id: lead_id } }),
    ...(call_type !== undefined && { call_type }),
    ...(resolved !== undefined && { resolved }),
  };
}

const callWriteSchema = {
  called_at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/, "Must be a full ISO 8601 timestamp with timezone, e.g. 2024-01-15T14:30:00Z")
    .describe("ISO 8601 timestamp of when the call happened (e.g. 2024-01-15T14:30:00Z)."),
  caller_phone_number: z
    .string()
    .regex(/^\+?[\d\s\-(). ]{7,20}$/, "Must be a valid phone number, e.g. +1 555-123-4567")
    .describe("The caller's phone number."),
  call_for_staff_id: z.number().int().positive().describe("ID of the staff member this call is for."),
  message: z.string().min(1).describe("Description of the call."),
  caller_name: z.string().min(1).optional().describe("Caller's name. Mutually exclusive with client_id and lead_id."),
  client_id: z.number().int().positive().optional().describe("Client ID to associate with the call. Mutually exclusive with caller_name and lead_id."),
  lead_id: z.number().int().positive().optional().describe("Lead ID to associate with the call. Mutually exclusive with caller_name and client_id."),
  call_type: z.enum(["incoming", "outgoing"]).optional().describe("Whether the call was incoming or outgoing (default: incoming)."),
  resolved: z.boolean().optional().describe("Whether the call is resolved (default: false)."),
};

export function registerCallTools(server: McpServer): void {
  server.tool(
    "list-calls",
    "List calls from the MyCase call log.",
    {
      page_size: z.number().int().min(1).max(1000).optional().default(25).describe("Number of calls to return (max 1000)."),
      updated_after: z.string().optional().describe("ISO 8601 date — return only calls created or updated after this date."),
      page_token: z.string().optional().describe("Cursor token for the next page, from a previous response."),
    },
    async ({ page_size, updated_after, page_token }) => {
      const tokens = await loadTokens();
      try {
        const params: Record<string, string | number | undefined> = { page_size };
        if (updated_after) params["filter[updated_after]"] = updated_after;
        if (page_token) params["page_token"] = page_token;

        const data = await mycaseGet("/calls", params);
        // API returns a bare array; guard in case the contract changes to an envelope.
        const calls = Array.isArray(data) ? data : [];
        await auditLog({ tool: "list-calls", args: { page_size, updated_after, page_token }, outcome: "success", firm_uuid: tokens?.firm_uuid, result_count: calls.length });
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({ tool: "list-calls", args: { page_size, updated_after, page_token }, outcome: "error", firm_uuid: tokens?.firm_uuid, error: msg });
        return { content: [{ type: "text", text: `Error listing calls: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    "log-call",
    "Log a phone call in MyCase. Requires exactly one of caller_name, client_id, or lead_id.",
    callWriteSchema,
    async ({ called_at, caller_phone_number, call_for_staff_id, message, caller_name, client_id, lead_id, call_type, resolved }) => {
      const tokens = await loadTokens();

      const provided = [caller_name, client_id, lead_id].filter((v) => v !== undefined);
      if (provided.length !== 1) {
        return { content: [{ type: "text", text: CALLER_MUTEX_ERROR }], isError: true };
      }

      try {
        const body = buildCallBody({ called_at, caller_phone_number, call_for_staff_id, message, caller_name, client_id, lead_id, call_type, resolved });
        const data = await mycasePost("/calls", body);
        await auditLog({ tool: "log-call", args: { called_at, call_for_staff_id, client_id, lead_id, caller_name }, outcome: "success", firm_uuid: tokens?.firm_uuid, result_count: 1 });
        // POST /calls returns 202 with no body; include call data only if the API ever returns it.
        return { content: [{ type: "text", text: JSON.stringify({ success: true, ...(data ? { call: data } : {}) }) }] };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({ tool: "log-call", args: { called_at, call_for_staff_id, client_id, lead_id, caller_name }, outcome: "error", firm_uuid: tokens?.firm_uuid, error: msg });
        return { content: [{ type: "text", text: `Error logging call: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    "update-call",
    "Update an existing call in the MyCase call log.",
    {
      id: z.number().int().positive().describe("ID of the call to update (id field from list-calls)."),
      ...callWriteSchema,
    },
    async ({ id, called_at, caller_phone_number, call_for_staff_id, message, caller_name, client_id, lead_id, call_type, resolved }) => {
      const tokens = await loadTokens();

      const provided = [caller_name, client_id, lead_id].filter((v) => v !== undefined);
      if (provided.length !== 1) {
        return { content: [{ type: "text", text: CALLER_MUTEX_ERROR }], isError: true };
      }

      try {
        const body = buildCallBody({ called_at, caller_phone_number, call_for_staff_id, message, caller_name, client_id, lead_id, call_type, resolved });
        await mycasePut(`/calls/${id}`, body);
        await auditLog({ tool: "update-call", args: { id, call_for_staff_id, client_id, lead_id, caller_name }, outcome: "success", firm_uuid: tokens?.firm_uuid });
        return { content: [{ type: "text", text: JSON.stringify({ success: true }) }] };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({ tool: "update-call", args: { id, call_for_staff_id, client_id, lead_id, caller_name }, outcome: "error", firm_uuid: tokens?.firm_uuid, error: msg });
        return { content: [{ type: "text", text: `Error updating call: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    "delete-call",
    "Delete a call from the MyCase call log.",
    {
      id: z.number().int().positive().describe("ID of the call to delete (id field from list-calls)."),
    },
    async ({ id }) => {
      const tokens = await loadTokens();
      try {
        await mycaseDelete(`/calls/${id}`);
        await auditLog({ tool: "delete-call", args: { id }, outcome: "success", firm_uuid: tokens?.firm_uuid });
        return { content: [{ type: "text", text: JSON.stringify({ success: true }) }] };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({ tool: "delete-call", args: { id }, outcome: "error", firm_uuid: tokens?.firm_uuid, error: msg });
        return { content: [{ type: "text", text: `Error deleting call: ${msg}` }], isError: true };
      }
    }
  );
}
