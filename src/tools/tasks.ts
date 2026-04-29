import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mycaseGet, mycasePost } from "../mycase-client.js";
import { auditLog } from "../audit/logger.js";
import { loadTokens } from "../auth/token-store.js";

export function registerTaskTools(server: McpServer): void {
  server.tool(
    "list-tasks",
    "List tasks from MyCase, optionally filtered by case, status, or due date range.",
    {
      case_id: z.string().optional().describe("Filter tasks by case ID."),
      status: z.enum(["open", "complete", "all"]).optional().default("open"),
      due_date_start: z.string().optional().describe("Filter tasks due on or after this date (YYYY-MM-DD)."),
      due_date_end: z.string().optional().describe("Filter tasks due on or before this date (YYYY-MM-DD)."),
      limit: z.number().int().min(1).max(200).optional().default(25),
      page: z.number().int().min(1).optional().default(1),
    },
    async ({ case_id, status, due_date_start, due_date_end, limit, page }) => {
      const tokens = await loadTokens();
      try {
        const params: Record<string, string | number | undefined> = { per_page: limit, page };
        if (case_id) params["case_id"] = case_id;
        if (status && status !== "all") params["status"] = status;
        if (due_date_start) params["due_date_start"] = due_date_start;
        if (due_date_end) params["due_date_end"] = due_date_end;

        const data = await mycaseGet("/tasks", params) as {
          tasks?: Array<{
            id: number | string;
            name?: string;
            description?: string;
            status?: string;
            priority?: string;
            due_date?: string;
            completed_at?: string;
            case?: { id: number | string; name?: string };
            assigned_to?: { id: number | string; name?: string };
            created_at?: string;
          }>;
          meta?: { total?: number };
        };

        const tasks = data?.tasks ?? [];
        await auditLog({ tool: "list-tasks", args: { case_id, status, due_date_start, due_date_end, limit, page }, outcome: "success", user_id: tokens?.user_id, case_id, result_count: tasks.length });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                tasks: tasks.map((t) => ({
                  id: t.id,
                  name: t.name,
                  description: t.description,
                  status: t.status,
                  priority: t.priority,
                  due_date: t.due_date,
                  completed_at: t.completed_at,
                  case: t.case,
                  assigned_to: t.assigned_to,
                  created_at: t.created_at,
                })),
                total: data?.meta?.total,
              }),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({ tool: "list-tasks", args: { case_id, status, due_date_start, due_date_end, limit, page }, outcome: "error", user_id: tokens?.user_id, case_id, error: msg });
        return { content: [{ type: "text", text: `Error listing tasks: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    "create-task",
    "Create a new task in MyCase associated with a case.",
    {
      case_id: z.string().describe("The case ID to associate the task with."),
      name: z.string().min(1).describe("Task name/title."),
      description: z.string().optional(),
      due_date: z.string().optional().describe("Due date in YYYY-MM-DD format."),
      priority: z.enum(["low", "normal", "high"]).optional().default("normal"),
      assigned_to_id: z.string().optional().describe("User ID to assign the task to."),
    },
    async ({ case_id, name, description, due_date, priority, assigned_to_id }) => {
      const tokens = await loadTokens();
      try {
        const body: Record<string, unknown> = {
          task: {
            name,
            case_id,
            priority,
            ...(description && { description }),
            ...(due_date && { due_date }),
            ...(assigned_to_id && { assigned_to_id }),
          },
        };

        const data = await mycasePost("/tasks", body) as { task?: { id: number | string; name?: string } };
        await auditLog({ tool: "create-task", args: { case_id, name, priority, due_date }, outcome: "success", user_id: tokens?.user_id, case_id, result_count: 1 });
        return { content: [{ type: "text", text: JSON.stringify({ success: true, task: data?.task ?? data }) }] };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({ tool: "create-task", args: { case_id, name, priority, due_date }, outcome: "error", user_id: tokens?.user_id, case_id, error: msg });
        return { content: [{ type: "text", text: `Error creating task: ${msg}` }], isError: true };
      }
    }
  );
}
