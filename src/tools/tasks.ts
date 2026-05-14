import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mycaseGet, mycasePost } from "../mycase-client.js";
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

type TasksResponse = TaskItem[] | { tasks?: TaskItem[]; meta?: { next_page_token?: string } };

export function registerTaskTools(server: McpServer): void {
  server.tool(
    "list-tasks",
    "List tasks from MyCase. When case_id is supplied all pages are fetched before filtering. Optionally filter by completion status or updated date.",
    {
      case_id: z.string().optional().describe("Filter tasks by case ID. All pages are fetched when this is set."),
      completed: z.boolean().optional().describe("Filter by completion: true = completed, false = open. Omit for all."),
      // max 100 until MyCase API limit is confirmed; original value was 1000
      page_size: z.number().int().min(1).max(100).optional().default(25),
      page_token: z.string().optional().describe("Cursor token for the next page. Ignored when case_id is set."),
      updated_after: z.string().optional().describe("ISO 8601 date — return only tasks created or updated after this date."),
    },
    async ({ case_id, completed, page_size, page_token, updated_after }) => {
      const tokens = await loadTokens();
      try {
        let tasks: TaskItem[];

        if (case_id !== undefined) {
          // Paginate to completion so results past page 1 are never silently dropped
          tasks = [];
          let cursor: string | undefined;
          do {
            const params: Record<string, string | number | undefined> = { page_size: 100 };
            if (cursor) params["page_token"] = cursor;
            if (updated_after) params["filter[updated_after]"] = updated_after;
            const response = await mycaseGet("/tasks", params) as TasksResponse;
            const page = Array.isArray(response) ? response : (response.tasks ?? []);
            const meta = Array.isArray(response) ? undefined : response.meta;
            tasks = tasks.concat(page);
            cursor = meta?.next_page_token;
          } while (cursor);
        } else {
          const params: Record<string, string | number | undefined> = { page_size };
          if (page_token) params["page_token"] = page_token;
          if (updated_after) params["filter[updated_after]"] = updated_after;
          const response = await mycaseGet("/tasks", params) as TasksResponse;
          tasks = Array.isArray(response) ? response : (response.tasks ?? []);
        }

        if (case_id !== undefined) tasks = tasks.filter(t => t.case?.id === Number(case_id));
        if (completed !== undefined) tasks = tasks.filter(t => t.completed === completed);

        await auditLog({ tool: "list-tasks", args: { case_id, completed, page_size, page_token, updated_after }, outcome: "success", firm_uuid: tokens?.firm_uuid, case_id, result_count: tasks.length });

        return {
          content: [{ type: "text", text: JSON.stringify({ tasks }) }],
        };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({ tool: "list-tasks", args: { case_id, completed, page_size, page_token, updated_after }, outcome: "error", firm_uuid: tokens?.firm_uuid, case_id, error: msg });
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
