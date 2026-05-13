import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mycaseGet, mycasePost } from "../mycase-client.js";
import { auditLog } from "../audit/logger.js";
import { loadTokens } from "../auth/token-store.js";

export function registerTaskTools(server: McpServer): void {
  server.tool(
    "list-tasks",
    "List tasks from MyCase. Optionally filter by case ID (client-side), completion status, or updated date.",
    {
      case_id: z.string().optional().describe("Filter tasks by case ID (applied client-side)."),
      completed: z.boolean().optional().describe("Filter by completion: true = completed, false = open. Omit for all."),
      page_size: z.number().int().min(1).max(1000).optional().default(25),
      page_token: z.string().optional().describe("Cursor token for the next page."),
      updated_after: z.string().optional().describe("ISO 8601 date — return only tasks created or updated after this date."),
    },
    async ({ case_id, completed, page_size, page_token, updated_after }) => {
      const tokens = await loadTokens();
      try {
        const params: Record<string, string | number | undefined> = { page_size };
        if (page_token) params["page_token"] = page_token;
        if (updated_after) params["filter[updated_after]"] = updated_after;

        let tasks = await mycaseGet("/tasks", params) as Array<{
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
        }>;

        if (!Array.isArray(tasks)) tasks = [];
        if (case_id !== undefined) tasks = tasks.filter(t => t.case?.id === Number(case_id));
        if (completed !== undefined) tasks = tasks.filter(t => t.completed === completed);

        await auditLog({ tool: "list-tasks", args: { case_id, completed, page_size, page_token, updated_after }, outcome: "success", user_id: tokens?.user_id, case_id, result_count: tasks.length });

        return {
          content: [{ type: "text", text: JSON.stringify({ tasks }) }],
        };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({ tool: "list-tasks", args: { case_id, completed, page_size, page_token, updated_after }, outcome: "error", user_id: tokens?.user_id, case_id, error: msg });
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
        await auditLog({ tool: "create-task", args: { name, case_id, staff_id, priority, due_date }, outcome: "success", user_id: tokens?.user_id, case_id: String(case_id), result_count: 1 });
        return { content: [{ type: "text", text: JSON.stringify({ success: true, task: data }) }] };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({ tool: "create-task", args: { name, case_id, staff_id, priority, due_date }, outcome: "error", user_id: tokens?.user_id, case_id: String(case_id), error: msg });
        return { content: [{ type: "text", text: `Error creating task: ${msg}` }], isError: true };
      }
    }
  );
}
