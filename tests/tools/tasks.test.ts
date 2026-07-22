import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerTaskTools } from "../../src/tools/tasks.js";
import { createMockServer, parseResult, MOCK_TOKENS } from "../helpers.js";

vi.mock("../../src/mycase-client.js", () => ({
  mycaseGetPage: vi.fn(),
  mycasePost: vi.fn(),
}));
vi.mock("../../src/auth/token-store.js", () => ({ loadTokens: vi.fn() }));
vi.mock("../../src/audit/logger.js", () => ({ auditLog: vi.fn() }));

import { mycaseGetPage, mycasePost } from "../../src/mycase-client.js";
import { loadTokens } from "../../src/auth/token-store.js";

// MyCase's real list endpoints return a bare JSON array — no envelope, no
// meta object. Pagination is signaled only via the response's Link header,
// which mycaseGetPage surfaces as `nextPageToken`.
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
    vi.mocked(mycaseGetPage).mockResolvedValue({ data: TASKS });
  });

  it("returns all tasks when no filters given", async () => {
    const result = await mock.call("list-tasks", {});
    const data = parseResult(result);

    expect(data.tasks).toHaveLength(3);
    expect(data.complete).toBe(true);
  });

  it("filters by case_id client-side over the complete fetched set", async () => {
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

    expect(mycaseGetPage).toHaveBeenCalledWith("/tasks", expect.objectContaining({ page_size: 50 }));
  });

  it("accepts a page_size up to the documented MyCase maximum of 1000", async () => {
    await mock.call("list-tasks", { page_size: 1000 });

    expect(mycaseGetPage).toHaveBeenCalledWith("/tasks", expect.objectContaining({ page_size: 1000 }));
  });

  it("passes filter[updated_after] to API", async () => {
    await mock.call("list-tasks", { updated_after: "2024-01-01T00:00:00Z" });

    expect(mycaseGetPage).toHaveBeenCalledWith("/tasks", expect.objectContaining({ "filter[updated_after]": "2024-01-01T00:00:00Z" }));
  });

  it("does not send case_id as an API param (filtered client-side after full fetch)", async () => {
    await mock.call("list-tasks", { case_id: "100" });

    const params = vi.mocked(mycaseGetPage).mock.calls[0][1] as Record<string, unknown>;
    expect(params["case_id"]).toBeUndefined();
  });

  it("paginates to completion by following the Link-header cursor, even without case_id", async () => {
    const page1Tasks = [
      { id: 1, name: "Draft complaint", completed: false, case: { id: 100 } },
      { id: 2, name: "File motion",     completed: true,  case: { id: 100 } },
    ];
    const page2Tasks = [
      { id: 4, name: "Second page task", completed: false, case: { id: 100 } },
      { id: 5, name: "Other case task",  completed: false, case: { id: 200 } },
    ];

    vi.mocked(mycaseGetPage)
      .mockResolvedValueOnce({ data: page1Tasks, nextPageToken: "cursor-abc" })
      .mockResolvedValueOnce({ data: page2Tasks });

    const result = await mock.call("list-tasks", { case_id: "100" });
    const data = parseResult(result);

    expect(mycaseGetPage).toHaveBeenCalledTimes(2);
    // Second call must use the cursor from the first response's Link header
    expect(vi.mocked(mycaseGetPage).mock.calls[1][1]).toMatchObject({ page_token: "cursor-abc" });
    // Only tasks for case 100 are returned (task id 5 with case 200 is filtered out)
    expect(data.tasks).toHaveLength(3);
    expect(data.tasks.map((t: { id: number }) => t.id)).toEqual([1, 2, 4]);
    expect(data.complete).toBe(true);
  });

  it("reports complete:false and a resumable cursor when the safety page-count bound is hit, instead of silently truncating", async () => {
    // Every page reports another page is available — an unbounded / misbehaving feed.
    vi.mocked(mycaseGetPage).mockImplementation(async () => ({
      data: [{ id: 1, name: "x", completed: false, case: { id: 100 } }],
      nextPageToken: "always-more",
    }));

    const result = await mock.call("list-tasks", {});
    const data = parseResult(result);

    expect(data.complete).toBe(false);
    expect(data.truncated_reason).toBe("page_limit_reached");
    expect(data.next_page_token).toBe("always-more");
  });

  it("resumes from a supplied page_token instead of restarting from the beginning", async () => {
    vi.mocked(mycaseGetPage).mockResolvedValue({ data: TASKS });

    await mock.call("list-tasks", { page_token: "resume-here" });

    expect(mycaseGetPage).toHaveBeenCalledWith("/tasks", expect.objectContaining({ page_token: "resume-here" }));
  });

  // Regression test for the exact contradiction reported against case 29869942:
  // widening the date filter must never return fewer open tasks than a narrower
  // one, because a wider window can only ever add tasks to the true result set.
  // The original bug was single-page truncation: the target case's tasks could
  // be pushed past page 1 by unrelated firm-wide tasks pulled in by the wider
  // window, and with pagination broken they were then silently dropped.
  it("a wider updated_after window never returns fewer results than a narrower one", async () => {
    const narrowWindowPage = [
      { id: 1, name: "A", completed: false, case: { id: 100 } },
      { id: 2, name: "B", completed: false, case: { id: 100 } },
    ];
    const wideWindowPage1 = [
      { id: 10, name: "unrelated-1", completed: false, case: { id: 999 } },
      { id: 11, name: "unrelated-2", completed: false, case: { id: 999 } },
    ];
    const wideWindowPage2 = [
      { id: 1, name: "A", completed: false, case: { id: 100 } },
      { id: 2, name: "B", completed: false, case: { id: 100 } },
    ];

    vi.mocked(mycaseGetPage).mockImplementation(async (_path, params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      if (p["filter[updated_after]"] === "2025-01-01") {
        return { data: narrowWindowPage };
      }
      // Wider window: unrelated firm-wide tasks land on page 1, case 100's
      // tasks are only reachable by following the cursor to page 2.
      if (!p["page_token"]) {
        return { data: wideWindowPage1, nextPageToken: "cursor-1" };
      }
      return { data: wideWindowPage2 };
    });

    const narrow = await mock.call("list-tasks", { case_id: "100", completed: false, updated_after: "2025-01-01" });
    const wide = await mock.call("list-tasks", { case_id: "100", completed: false, updated_after: "2024-01-01" });

    const narrowCount = parseResult(narrow).tasks.length;
    const wideCount = parseResult(wide).tasks.length;

    expect(wideCount).toBeGreaterThanOrEqual(narrowCount);
    expect(wideCount).toBe(2);
  });

  it("returns isError on API failure", async () => {
    vi.mocked(mycaseGetPage).mockRejectedValue(new Error("Network error"));

    const result = await mock.call("list-tasks", {});

    expect(result.isError).toBe(true);
  });

  it("surfaces an expired/invalid page_token as an error rather than an empty list", async () => {
    vi.mocked(mycaseGetPage).mockRejectedValue(new Error("Invalid or expired page_token"));

    const result = await mock.call("list-tasks", { page_token: "stale-cursor-from-4-days-ago" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid or expired page_token");
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
