import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerTaskTools } from "../../src/tools/tasks.js";
import { createMockServer, parseResult, MOCK_TOKENS } from "../helpers.js";

vi.mock("../../src/mycase-client.js", () => ({
  mycaseGet: vi.fn(),
  mycasePost: vi.fn(),
}));
vi.mock("../../src/auth/token-store.js", () => ({ loadTokens: vi.fn() }));
vi.mock("../../src/audit/logger.js", () => ({ auditLog: vi.fn() }));

import { mycaseGet, mycasePost } from "../../src/mycase-client.js";
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
