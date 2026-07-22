import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mycaseGetAll, mycasePost } from "../mycase-client.js";
import { auditLog } from "../audit/logger.js";
import { loadTokens } from "../auth/token-store.js";

type TaskItem = {
  id: number;
  name?: string;
  description?: string;
  priority?: string;
  due_date?: string;
  completed?: boolean;
  completed_at?: string | null;
  case?: { id: number };
  staff?: Array<{ id: number }>;
  created_at?: string;
  updated_at?: string;
};

export function registerTaskTools(server: McpServer): void {
  server.tool(
    "list-tasks",
    "List tasks from MyCase. Always fetches every page before filtering, so the result is the firm's complete task set for the given filters. Check the 'complete' field on the response: if it is false the list is missing records and must not be treated as authoritative.",
    {
      case_id: z.string().optional().describe("Filter tasks by case ID."),
      completed: z.boolean().optional().describe("Filter by completion: true = completed, false = open. Omit for all."),
      updated_after: z.string().optional().describe("ISO 8601 date — return only tasks created or updated after this date."),
    },
    async ({ case_id, completed, updated_after }) => {
      const tokens = await loadTokens();
      try {
        // case_id and completed are filtered here rather than sent to the API. MyCase
        // has no per-case tasks endpoint, and server-side filters for these two are
        // unconfirmed. Filtering after a complete fetch is correct either way; sending
        // them as unsupported params would be silently ignored and look like it worked.
        const params: Record<string, string | number | undefined> = {};
        if (updated_after) params["filter[updated_after]"] = updated_after;

        const result = await mycaseGetAll<TaskItem>("/tasks", params);

        let tasks = result.items;
        if (case_id !== undefined) tasks = tasks.filter(t => t.case?.id === Number(case_id));
        if (completed !== undefined) tasks = tasks.filter(t => t.completed === completed);

        await auditLog({ tool: "list-tasks", args: { case_id, completed, updated_after }, outcome: "success", firm_uuid: tokens?.firm_uuid, case_id, result_count: tasks.length });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              tasks,
              count: tasks.length,
              complete: result.complete,
              ...(result.complete
                ? {}
                : {
                    warning: `INCOMPLETE RESULT — this is not the full task list. ${result.incompleteReason} Do not rely on it for deadlines; verify in MyCase.`,
                  }),
            }),
          }],
        };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({ tool: "list-tasks", args: { case_id, completed, updated_after }, outcome: "error", firm_uuid: tokens?.firm_uuid, case_id, error: msg });
        return { content: [{ type: "text", text: `Error listing tasks: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    "create-task",
    "Create a new task in MyCase. Requires a name, due date, priority, and at least one staff member ID.",
    {
      name: z.string().min(1).describe("Task name/title."),
      due_date: z.string().describe("Due date in YYYY-MM-DD format. Required."),
      priority: z.enum(["Low", "Medium", "High"]).describe("Task priority: Low, Medium, or High."),
      staff_id: z.number().int().describe("The ID of the staff member to assign the task to."),
      // TODO v1.1: accept staff_ids: number[]
      case_id: z.number().int().optional().describe("The ID of the case to associate the task with."),
      description: z.string().optional(),
      completed: z.boolean().optional().describe("Whether the task is already completed."),
    },
    async ({ name, due_date, priority, staff_id, case_id, description, completed }) => {
      const tokens = await loadTokens();
      try {
        const body: Record<string, unknown> = {
          name,
          due_date,
          priority,
          staff: [{ id: staff_id }],
          ...(case_id && { case: { id: case_id } }),
          ...(description && { description }),
          ...(completed !== undefined && { completed }),
        };

        const data = await mycasePost("/tasks", body);
        await auditLog({ tool: "create-task", args: { name, case_id, staff_id, priority, due_date }, outcome: "success", firm_uuid: tokens?.firm_uuid, case_id: String(case_id), result_count: 1 });
        return { content: [{ type: "text", text: JSON.stringify({ success: true, task: data }) }] };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({ tool: "create-task", args: { name, case_id, staff_id, priority, due_date }, outcome: "error", firm_uuid: tokens?.firm_uuid, case_id: String(case_id), error: msg });
        return { content: [{ type: "text", text: `Error creating task: ${msg}` }], isError: true };
      }
    }
  );
}
