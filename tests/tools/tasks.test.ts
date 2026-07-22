import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerTaskTools } from "../../src/tools/tasks.js";
import { createMockServer, parseResult, MOCK_TOKENS } from "../helpers.js";

vi.mock("../../src/mycase-client.js", () => ({
  mycaseGetAll: vi.fn(),
  mycasePost: vi.fn(),
}));
vi.mock("../../src/auth/token-store.js", () => ({ loadTokens: vi.fn() }));
vi.mock("../../src/audit/logger.js", () => ({ auditLog: vi.fn() }));

import { mycaseGetAll, mycasePost } from "../../src/mycase-client.js";
import { loadTokens } from "../../src/auth/token-store.js";

const TASKS = [
  { id: 1, name: "Draft complaint", completed: false, case: { id: 100 } },
  { id: 2, name: "File motion",     completed: true,  case: { id: 100 } },
  { id: 3, name: "Review docs",     completed: false, case: { id: 200 } },
];

const complete = (items: unknown[]) => ({ items, complete: true, pages: 1 });

describe("list-tasks", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerTaskTools(mock.server);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
    vi.mocked(mycaseGetAll).mockResolvedValue(complete(TASKS));
  });

  it("returns all tasks when no filters given", async () => {
    const data = parseResult(await mock.call("list-tasks", {}));
    expect(data.tasks).toHaveLength(3);
  });

  it("filters by case_id", async () => {
    const data = parseResult(await mock.call("list-tasks", { case_id: "100" }));
    expect(data.tasks).toHaveLength(2);
    expect(data.tasks.every((t: { case: { id: number } }) => t.case.id === 100)).toBe(true);
  });

  it("filters by completed:false", async () => {
    const data = parseResult(await mock.call("list-tasks", { completed: false }));
    expect(data.tasks).toHaveLength(2);
    expect(data.tasks.every((t: { completed: boolean }) => !t.completed)).toBe(true);
  });

  it("filters by completed:true", async () => {
    const data = parseResult(await mock.call("list-tasks", { completed: true }));
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].id).toBe(2);
  });

  it("combines case_id and completed", async () => {
    const data = parseResult(await mock.call("list-tasks", { case_id: "100", completed: false }));
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].id).toBe(1);
  });

  it("passes updated_after through as a server-side filter", async () => {
    await mock.call("list-tasks", { updated_after: "2024-01-01T00:00:00Z" });
    expect(mycaseGetAll).toHaveBeenCalledWith(
      "/tasks",
      expect.objectContaining({ "filter[updated_after]": "2024-01-01T00:00:00Z" })
    );
  });

  it("does not send case_id or completed as API params", async () => {
    await mock.call("list-tasks", { case_id: "100", completed: false });
    const params = vi.mocked(mycaseGetAll).mock.calls[0][1] as Record<string, unknown>;
    expect(params["case_id"]).toBeUndefined();
    expect(params["completed"]).toBeUndefined();
  });

  it("fetches every page, not just the first", async () => {
    // Regression for the reported bug: the connector used to return page one only,
    // so a case whose tasks sat on later pages came back empty.
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ id: i, completed: true, case: { id: 999 } }));
    const openTask = { id: 5001, name: "File response", completed: false, case: { id: 29869942 } };
    vi.mocked(mycaseGetAll).mockResolvedValue({ items: [...page1, openTask], complete: true, pages: 2 });

    const data = parseResult(await mock.call("list-tasks", { case_id: "29869942", completed: false }));
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].id).toBe(5001);
  });

  it("reports complete:true and never warns on a full fetch", async () => {
    const data = parseResult(await mock.call("list-tasks", {}));
    expect(data.complete).toBe(true);
    expect(data.count).toBe(3);
    expect(data.warning).toBeUndefined();
  });

  it("flags a truncated result loudly instead of passing it off as the full list", async () => {
    vi.mocked(mycaseGetAll).mockResolvedValue({
      items: TASKS,
      complete: false,
      pages: 1000,
      incompleteReason: "Stopped after 1000 pages with more results still available.",
    });

    const data = parseResult(await mock.call("list-tasks", {}));
    expect(data.complete).toBe(false);
    expect(data.warning).toMatch(/INCOMPLETE/);
  });

  it("an empty result is distinguishable from a truncated one", async () => {
    vi.mocked(mycaseGetAll).mockResolvedValue(complete([]));
    const data = parseResult(await mock.call("list-tasks", { case_id: "404" }));
    expect(data.tasks).toEqual([]);
    expect(data.complete).toBe(true);
    expect(data.warning).toBeUndefined();
  });

  it("a wider updated_after window never returns fewer tasks than a narrower one", async () => {
    // Jesse Harbison's reported contradiction: updated_after 2025-01-01 gave 14 open
    // tasks while 2024-01-01, a strictly more inclusive window, gave 0.
    const recent = [{ id: 1, completed: false, case: { id: 1 } }];
    const older = [...recent, { id: 2, completed: false, case: { id: 1 } }];

    vi.mocked(mycaseGetAll).mockResolvedValue(complete(recent));
    const narrow = parseResult(await mock.call("list-tasks", { completed: false, updated_after: "2025-01-01" }));

    vi.mocked(mycaseGetAll).mockResolvedValue(complete(older));
    const wide = parseResult(await mock.call("list-tasks", { completed: false, updated_after: "2024-01-01" }));

    expect(wide.tasks.length).toBeGreaterThanOrEqual(narrow.tasks.length);
  });

  it("returns isError on API failure", async () => {
    vi.mocked(mycaseGetAll).mockRejectedValue(new Error("Network error"));
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
    vi.mocked(mycasePost).mockResolvedValue({ id: 42 });
  });

  it("posts the required fields", async () => {
    await mock.call("create-task", {
      name: "New task",
      due_date: "2026-08-01",
      priority: "High",
      staff_id: 7,
    });

    expect(mycasePost).toHaveBeenCalledWith("/tasks", expect.objectContaining({
      name: "New task",
      due_date: "2026-08-01",
      priority: "High",
      staff: [{ id: 7 }],
    }));
  });
});
