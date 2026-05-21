import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerTaskTools } from "../../src/tools/tasks.js";
import { createMockServer, parseResult, MOCK_TOKENS } from "../helpers.js";

vi.mock("../../src/mycase-client.js", () => ({
  mycaseGet: vi.fn(),
  mycasePost: vi.fn(),
  mycasePut: vi.fn(),
  mycaseDelete: vi.fn(),
}));
vi.mock("../../src/auth/token-store.js", () => ({ loadTokens: vi.fn() }));
vi.mock("../../src/audit/logger.js", () => ({ auditLog: vi.fn() }));

import { mycaseGet, mycasePost, mycasePut, mycaseDelete } from "../../src/mycase-client.js";
import { loadTokens } from "../../src/auth/token-store.js";

const TASKS = [
  { id: 1, name: "Draft complaint", completed: false, case: { id: 100 } },
  { id: 2, name: "File motion",     completed: true,  case: { id: 100 } },
  { id: 3, name: "Review docs",     completed: false, case: { id: 200 } },
];

describe("list-tasks", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerTaskTools(mock.server);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
    vi.mocked(mycaseGet).mockResolvedValue(TASKS);
  });

  it("returns all tasks when no filters given", async () => {
    const result = await mock.call("list-tasks", {});
    const data = parseResult(result);

    expect(data.tasks).toHaveLength(3);
  });

  it("filters by case_id client-side", async () => {
    const result = await mock.call("list-tasks", { case_id: "100" });
    const data = parseResult(result);

    expect(data.tasks).toHaveLength(2);
    expect(data.tasks.every((t: { case: { id: number } }) => t.case.id === 100)).toBe(true);
  });

  it("filters completed=false client-side", async () => {
    const result = await mock.call("list-tasks", { completed: false });
    const data = parseResult(result);

    expect(data.tasks).toHaveLength(2);
    expect(data.tasks.every((t: { completed: boolean }) => !t.completed)).toBe(true);
  });

  it("filters completed=true client-side", async () => {
    const result = await mock.call("list-tasks", { completed: true });
    const data = parseResult(result);

    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].id).toBe(2);
  });

  it("combines case_id and completed filters", async () => {
    const result = await mock.call("list-tasks", { case_id: "100", completed: false });
    const data = parseResult(result);

    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].id).toBe(1);
  });

  it("passes page_size to API", async () => {
    await mock.call("list-tasks", { page_size: 50 });

    expect(mycaseGet).toHaveBeenCalledWith("/tasks", expect.objectContaining({ page_size: 50 }));
  });

  it("passes filter[updated_after] to API", async () => {
    await mock.call("list-tasks", { updated_after: "2024-01-01T00:00:00Z" });

    expect(mycaseGet).toHaveBeenCalledWith("/tasks", expect.objectContaining({ "filter[updated_after]": "2024-01-01T00:00:00Z" }));
  });

  it("does not send case_id as API param (filtered client-side after full fetch)", async () => {
    await mock.call("list-tasks", { case_id: "100" });

    const params = vi.mocked(mycaseGet).mock.calls[0][1] as Record<string, unknown>;
    expect(params["case_id"]).toBeUndefined();
  });

  it("paginates to completion when case_id is supplied", async () => {
    const page1Tasks = [
      { id: 1, name: "Draft complaint", completed: false, case: { id: 100 } },
      { id: 2, name: "File motion",     completed: true,  case: { id: 100 } },
    ];
    const page2Tasks = [
      { id: 4, name: "Second page task", completed: false, case: { id: 100 } },
      { id: 5, name: "Other case task",  completed: false, case: { id: 200 } },
    ];

    vi.mocked(mycaseGet)
      .mockResolvedValueOnce({ tasks: page1Tasks, meta: { next_page_token: "cursor-abc" } })
      .mockResolvedValueOnce({ tasks: page2Tasks, meta: {} });

    const result = await mock.call("list-tasks", { case_id: "100" });
    const data = parseResult(result);

    expect(mycaseGet).toHaveBeenCalledTimes(2);
    // Second call must use the cursor from the first response
    expect(vi.mocked(mycaseGet).mock.calls[1][1]).toMatchObject({ page_token: "cursor-abc" });
    // Only tasks for case 100 are returned (task id 5 with case 200 is filtered out)
    expect(data.tasks).toHaveLength(3);
    expect(data.tasks.map((t: { id: number }) => t.id)).toEqual([1, 2, 4]);
  });

  it("returns isError on API failure", async () => {
    vi.mocked(mycaseGet).mockRejectedValue(new Error("Network error"));

    const result = await mock.call("list-tasks", {});

    expect(result.isError).toBe(true);
  });
});

describe("create-task", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerTaskTools(mock.server);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
  });

  it("posts task to API and returns result", async () => {
    vi.mocked(mycasePost).mockResolvedValue({ id: 99, name: "New task" });

    const result = await mock.call("create-task", {
      name: "New task",
      due_date: "2025-06-01",
      priority: "Low",
      staff_id: 7,
      case_id: 100,
    });
    const data = parseResult(result);

    expect(data.success).toBe(true);
    expect(mycasePost).toHaveBeenCalledWith("/tasks", expect.objectContaining({
      name: "New task",
      case: { id: 100 },
      staff: [{ id: 7 }],
    }));
  });

  it("includes priority in the request body", async () => {
    vi.mocked(mycasePost).mockResolvedValue({ id: 1 });

    await mock.call("create-task", {
      name: "Task",
      due_date: "2025-06-01",
      priority: "Medium",
      staff_id: 7,
    });

    const body = vi.mocked(mycasePost).mock.calls[0][1] as Record<string, unknown>;
    expect(body["priority"]).toBe("Medium");
  });

  it("passes optional fields when provided", async () => {
    vi.mocked(mycasePost).mockResolvedValue({ id: 1 });

    await mock.call("create-task", {
      name: "Task",
      due_date: "2025-12-31",
      priority: "High",
      staff_id: 5,
      description: "Details",
    });

    const body = vi.mocked(mycasePost).mock.calls[0][1] as Record<string, unknown>;
    expect(body["description"]).toBe("Details");
    expect(body["due_date"]).toBe("2025-12-31");
    expect(body["priority"]).toBe("High");
    expect(body["staff"]).toEqual([{ id: 5 }]);
  });

  it("returns isError on API failure", async () => {
    vi.mocked(mycasePost).mockRejectedValue(new Error("Bad request"));

    const result = await mock.call("create-task", {
      name: "Task",
      due_date: "2025-06-01",
      priority: "Low",
      staff_id: 1,
    });

    expect(result.isError).toBe(true);
  });
});

const CURRENT_TASK = {
  id: 1,
  name: "Draft complaint",
  priority: "Low" as const,
  due_date: "2025-06-01",
  completed: false,
  description: "Original description",
  staff: [{ id: 5 }],
  case: { id: 100 },
};

describe("complete-task", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerTaskTools(mock.server);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
    vi.mocked(mycaseGet).mockResolvedValue(CURRENT_TASK);
    vi.mocked(mycasePut).mockResolvedValue(null); // 204 No Content
  });

  it("GETs task then PUTs with completed:true preserving other fields", async () => {
    await mock.call("complete-task", { task_id: 1 });

    expect(mycaseGet).toHaveBeenCalledWith("/tasks/1");
    expect(mycasePut).toHaveBeenCalledWith("/tasks/1", expect.objectContaining({
      name: "Draft complaint",
      priority: "Low",
      due_date: "2025-06-01",
      staff: [{ id: 5 }],
      completed: true,
    }));
  });

  it("returns success without task body (PUT returns 204)", async () => {
    const result = await mock.call("complete-task", { task_id: 1 });
    const data = parseResult(result);

    expect(data.success).toBe(true);
    expect(data.task).toBeUndefined();
  });

  it("includes case_id in audit log from GET response", async () => {
    const { auditLog } = await import("../../src/audit/logger.js");

    await mock.call("complete-task", { task_id: 1 });

    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({
      tool: "complete-task",
      outcome: "success",
      case_id: "100",
    }));
  });

  it("omits case_id in audit log when task has no case", async () => {
    const { auditLog } = await import("../../src/audit/logger.js");
    vi.mocked(mycaseGet).mockResolvedValue({ ...CURRENT_TASK, case: undefined });

    await mock.call("complete-task", { task_id: 1 });

    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({
      tool: "complete-task",
      outcome: "success",
      case_id: undefined,
    }));
  });

  it("returns isError when GET response is missing required fields", async () => {
    vi.mocked(mycaseGet).mockResolvedValue({ id: 1, priority: "Low", due_date: "2025-06-01" }); // no name

    const result = await mock.call("complete-task", { task_id: 1 });

    expect(result.isError).toBe(true);
    expect(mycasePut).not.toHaveBeenCalled();
  });

  it("returns isError when GET fails", async () => {
    vi.mocked(mycaseGet).mockRejectedValue(new Error("Not found"));

    const result = await mock.call("complete-task", { task_id: 999 });

    expect(result.isError).toBe(true);
  });

  it("returns isError when PUT fails", async () => {
    vi.mocked(mycasePut).mockRejectedValue(new Error("Forbidden"));

    const result = await mock.call("complete-task", { task_id: 1 });

    expect(result.isError).toBe(true);
  });
});

describe("update-task", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerTaskTools(mock.server);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
    vi.mocked(mycaseGet).mockResolvedValue(CURRENT_TASK);
    vi.mocked(mycasePut).mockResolvedValue(null); // 204 No Content
  });

  it("returns isError immediately when no optional fields are supplied", async () => {
    const result = await mock.call("update-task", { task_id: 1 });

    expect(result.isError).toBe(true);
    expect(mycaseGet).not.toHaveBeenCalled();
    expect(mycasePut).not.toHaveBeenCalled();
  });

  it("merges supplied fields over current values in PUT body", async () => {
    await mock.call("update-task", { task_id: 1, name: "Renamed" });

    const body = vi.mocked(mycasePut).mock.calls[0][1] as Record<string, unknown>;
    expect(body["name"]).toBe("Renamed");
    // Preserved from GET
    expect(body["priority"]).toBe("Low");
    expect(body["due_date"]).toBe("2025-06-01");
    expect(body["staff"]).toEqual([{ id: 5 }]);
  });

  it("maps staff_id to staff array, overriding existing assignees", async () => {
    await mock.call("update-task", { task_id: 1, staff_id: 7 });

    const body = vi.mocked(mycasePut).mock.calls[0][1] as Record<string, unknown>;
    expect(body["staff"]).toEqual([{ id: 7 }]);
  });

  it("sends all supplied fields when every optional is provided", async () => {
    await mock.call("update-task", {
      task_id: 1,
      name: "New name",
      due_date: "2025-12-31",
      priority: "High",
      description: "Details",
      completed: false,
      staff_id: 3,
    });

    const body = vi.mocked(mycasePut).mock.calls[0][1] as Record<string, unknown>;
    expect(body).toMatchObject({
      name: "New name",
      due_date: "2025-12-31",
      priority: "High",
      description: "Details",
      completed: false,
      staff: [{ id: 3 }],
    });
  });

  it("returns merged task in response", async () => {
    const result = await mock.call("update-task", { task_id: 1, priority: "High" });
    const data = parseResult(result);

    expect(data.success).toBe(true);
    expect(data.task.priority).toBe("High");
    expect(data.task.name).toBe("Draft complaint"); // preserved
  });

  it("includes case_id in audit log from GET response", async () => {
    const { auditLog } = await import("../../src/audit/logger.js");

    await mock.call("update-task", { task_id: 1, priority: "Low" });

    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({
      tool: "update-task",
      outcome: "success",
      case_id: "100",
    }));
  });

  it("returns isError when GET response is missing required fields", async () => {
    vi.mocked(mycaseGet).mockResolvedValue({ id: 1, due_date: "2025-06-01" }); // no name or priority

    const result = await mock.call("update-task", { task_id: 1, completed: true });

    expect(result.isError).toBe(true);
    expect(mycasePut).not.toHaveBeenCalled();
  });

  it("returns isError when GET fails", async () => {
    vi.mocked(mycaseGet).mockRejectedValue(new Error("Not found"));

    const result = await mock.call("update-task", { task_id: 999, name: "X" });

    expect(result.isError).toBe(true);
  });

  it("returns isError when PUT fails", async () => {
    vi.mocked(mycasePut).mockRejectedValue(new Error("Forbidden"));

    const result = await mock.call("update-task", { task_id: 1, name: "X" });

    expect(result.isError).toBe(true);
  });
});

describe("delete-task", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerTaskTools(mock.server);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
    vi.mocked(mycaseDelete).mockResolvedValue(null); // 204 No Content
  });

  it("calls DELETE /tasks/:id", async () => {
    await mock.call("delete-task", { task_id: 42 });

    expect(mycaseDelete).toHaveBeenCalledWith("/tasks/42");
  });

  it("returns success on 204", async () => {
    const result = await mock.call("delete-task", { task_id: 1 });
    const data = parseResult(result);

    expect(data.success).toBe(true);
  });

  it("returns isError on API failure", async () => {
    vi.mocked(mycaseDelete).mockRejectedValue(new Error("Not found"));

    const result = await mock.call("delete-task", { task_id: 999 });

    expect(result.isError).toBe(true);
  });
});
