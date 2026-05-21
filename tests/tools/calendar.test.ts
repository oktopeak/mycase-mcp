import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerCalendarTools } from "../../src/tools/calendar.js";
import { createMockServer, parseResult, MOCK_TOKENS } from "../helpers.js";

vi.mock("../../src/mycase-client.js", () => ({ mycaseGetPaged: vi.fn(), mycasePost: vi.fn() }));
vi.mock("../../src/auth/token-store.js", () => ({ loadTokens: vi.fn() }));
vi.mock("../../src/audit/logger.js", () => ({ auditLog: vi.fn() }));

import { z } from "zod";
import { mycaseGetPaged, mycasePost } from "../../src/mycase-client.js";
import { loadTokens } from "../../src/auth/token-store.js";
import { auditLog } from "../../src/audit/logger.js";

describe("list-calendar-events", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerCalendarTools(mock.server);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
  });

  it("returns events from a bare-array API response", async () => {
    vi.mocked(mycaseGetPaged).mockResolvedValue({
      body: [{ id: 1, name: "Hearing", start: "2025-06-01T09:00:00Z", end: "2025-06-01T10:00:00Z" }],
      nextPageToken: null,
    });

    const result = await mock.call("list-calendar-events", {});
    const data = parseResult(result);

    expect(data.events).toHaveLength(1);
    expect(data.events[0].title).toBe("Hearing");
    expect(data.events[0].start_at).toBe("2025-06-01T09:00:00Z");
    expect(data.events[0].end_at).toBe("2025-06-01T10:00:00Z");
  });

  it("sends page_size to the API", async () => {
    vi.mocked(mycaseGetPaged).mockResolvedValue({ body: [], nextPageToken: null });

    await mock.call("list-calendar-events", { page_size: 50 });

    expect(mycaseGetPaged).toHaveBeenCalledWith("/events", expect.objectContaining({ page_size: 50 }));
  });

  it("sends filter[updated_after] when updated_after is provided", async () => {
    vi.mocked(mycaseGetPaged).mockResolvedValue({ body: [], nextPageToken: null });

    await mock.call("list-calendar-events", { updated_after: "2025-05-01T00:00:00Z" });

    expect(mycaseGetPaged).toHaveBeenCalledWith("/events", expect.objectContaining({
      "filter[updated_after]": "2025-05-01T00:00:00Z",
    }));
  });

  it("filters by case_id client-side and does not send it as a query param", async () => {
    vi.mocked(mycaseGetPaged).mockResolvedValue({
      body: [
        { id: 1, name: "Hearing", case: { id: 101 } },
        { id: 2, name: "Meeting", case: { id: 202 } },
      ],
      nextPageToken: null,
    });

    const result = await mock.call("list-calendar-events", { case_id: 101 });
    const data = parseResult(result);

    expect(data.events).toHaveLength(1);
    expect(data.events[0].id).toBe(1);
    const sentParams = vi.mocked(mycaseGetPaged).mock.calls[0][1] as Record<string, unknown>;
    expect(sentParams).not.toHaveProperty("case_id");
  });

  it("forwards page_token param and surfaces next_page_token in response", async () => {
    vi.mocked(mycaseGetPaged).mockResolvedValue({ body: [], nextPageToken: "cursor-abc" });

    await mock.call("list-calendar-events", { page_token: "cursor-xyz" });

    expect(mycaseGetPaged).toHaveBeenCalledWith("/events", expect.objectContaining({ page_token: "cursor-xyz" }));

    const result = await mock.call("list-calendar-events", {});
    const data = parseResult(result);
    expect(data.next_page_token).toBe("cursor-abc");
  });

  it("omits next_page_token from response when there is no next page", async () => {
    vi.mocked(mycaseGetPaged).mockResolvedValue({ body: [], nextPageToken: null });

    const result = await mock.call("list-calendar-events", {});
    const data = parseResult(result);

    expect(data).not.toHaveProperty("next_page_token");
  });

  it("handles a non-array API response gracefully", async () => {
    vi.mocked(mycaseGetPaged).mockResolvedValue({ body: null, nextPageToken: null });

    const result = await mock.call("list-calendar-events", {});
    const data = parseResult(result);

    expect(data.events).toHaveLength(0);
  });

  it("returns isError on API failure", async () => {
    vi.mocked(mycaseGetPaged).mockRejectedValue(new Error("Network error"));

    const result = await mock.call("list-calendar-events", {});

    expect(result.isError).toBe(true);
  });
});

describe("create-calendar-event", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerCalendarTools(mock.server);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
  });

  it("schema rejects missing required fields", () => {
    const schema = z.object({
      title: z.string().min(1),
      start_at: z.string(),
      end_at: z.string(),
    });
    expect(() => schema.parse({})).toThrow();
    expect(() => schema.parse({ title: "Hearing", start_at: "2025-06-01T09:00:00", end_at: "2025-06-01T10:00:00" })).not.toThrow();
  });

  it("posts to /events with correct field mapping", async () => {
    vi.mocked(mycasePost).mockResolvedValue({ id: 42, name: "Hearing" });

    await mock.call("create-calendar-event", {
      title: "Hearing",
      start_at: "2025-06-01T09:00:00",
      end_at: "2025-06-01T10:00:00",
    });

    expect(mycasePost).toHaveBeenCalledWith("/events", expect.objectContaining({
      name: "Hearing",
      start: "2025-06-01T09:00:00",
      end: "2025-06-01T10:00:00",
    }));
  });

  it("returns event_id on success", async () => {
    vi.mocked(mycasePost).mockResolvedValue({ id: 99 });

    const result = await mock.call("create-calendar-event", {
      title: "Deposition",
      start_at: "2025-07-10T14:00:00",
      end_at: "2025-07-10T16:00:00",
    });
    const data = parseResult(result);

    expect(data.success).toBe(true);
    expect(data.event_id).toBe(99);
  });

  it("includes case and staff in request body when provided", async () => {
    vi.mocked(mycasePost).mockResolvedValue({ id: 55 });

    await mock.call("create-calendar-event", {
      title: "Status Conference",
      start_at: "2025-08-01T10:00:00",
      end_at: "2025-08-01T11:00:00",
      case_id: 101,
      staff_ids: [7, 8],
    });

    expect(mycasePost).toHaveBeenCalledWith("/events", expect.objectContaining({
      case: { id: 101 },
      staff: [
        { id: 7, required: true },
        { id: 8, required: true },
      ],
    }));
  });

  it("audit-logs case_id on success", async () => {
    vi.mocked(mycasePost).mockResolvedValue({ id: 1 });

    await mock.call("create-calendar-event", {
      title: "Hearing",
      start_at: "2025-06-01T09:00:00",
      end_at: "2025-06-01T10:00:00",
      case_id: 200,
    });

    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({
      tool: "create-calendar-event",
      outcome: "success",
      case_id: "200",
    }));
  });

  it("includes all_day in request body when set to true", async () => {
    vi.mocked(mycasePost).mockResolvedValue({ id: 10 });

    await mock.call("create-calendar-event", {
      title: "Court Date",
      start_at: "2025-09-01",
      end_at: "2025-09-01",
      all_day: true,
    });

    expect(mycasePost).toHaveBeenCalledWith("/events", expect.objectContaining({ all_day: true }));
  });

  it("includes location in request body when location_id is provided", async () => {
    vi.mocked(mycasePost).mockResolvedValue({ id: 11 });

    await mock.call("create-calendar-event", {
      title: "Office Meeting",
      start_at: "2025-09-10T09:00:00",
      end_at: "2025-09-10T10:00:00",
      location_id: 5,
    });

    expect(mycasePost).toHaveBeenCalledWith("/events", expect.objectContaining({
      location: { id: 5 },
    }));
  });

  it("maps notes to description and preserves empty string", async () => {
    vi.mocked(mycasePost).mockResolvedValue({ id: 12 });

    await mock.call("create-calendar-event", {
      title: "Check-in",
      start_at: "2025-09-15T10:00:00",
      end_at: "2025-09-15T10:30:00",
      notes: "Bring case file",
    });

    expect(mycasePost).toHaveBeenCalledWith("/events", expect.objectContaining({
      description: "Bring case file",
    }));

    vi.mocked(mycasePost).mockResolvedValue({ id: 13 });
    await mock.call("create-calendar-event", {
      title: "Check-in",
      start_at: "2025-09-15T10:00:00",
      end_at: "2025-09-15T10:30:00",
      notes: "",
    });

    expect(mycasePost).toHaveBeenLastCalledWith("/events", expect.objectContaining({
      description: "",
    }));
  });

  it("returns isError on API failure", async () => {
    vi.mocked(mycasePost).mockRejectedValue(new Error("Forbidden"));

    const result = await mock.call("create-calendar-event", {
      title: "Meeting",
      start_at: "2025-06-01T09:00:00",
      end_at: "2025-06-01T10:00:00",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Forbidden");
  });
});
