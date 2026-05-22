import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerCalendarTools } from "../../src/tools/calendar.js";
import { createMockServer, parseResult, MOCK_TOKENS } from "../helpers.js";

vi.mock("../../src/mycase-client.js", () => ({ mycaseGet: vi.fn() }));
vi.mock("../../src/auth/token-store.js", () => ({ loadTokens: vi.fn() }));
vi.mock("../../src/audit/logger.js", () => ({ auditLog: vi.fn() }));

import { mycaseGet } from "../../src/mycase-client.js";
import { loadTokens } from "../../src/auth/token-store.js";

describe("list-calendar-events", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerCalendarTools(mock.server);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
  });

  it("returns events from the API", async () => {
    vi.mocked(mycaseGet).mockResolvedValue({
      data: [{ id: 1, name: "Hearing", start: "2025-06-01T09:00:00Z", end: "2025-06-01T10:00:00Z" }],
    });

    const result = await mock.call("list-calendar-events", {});
    const data = parseResult(result);

    expect(data.events).toHaveLength(1);
    expect(data.events[0].name).toBe("Hearing");
  });

  it("passes case_id param when provided", async () => {
    vi.mocked(mycaseGet).mockResolvedValue({ data: [] });

    await mock.call("list-calendar-events", { case_id: "77" });

    expect(mycaseGet).toHaveBeenCalledWith("/events", expect.objectContaining({ case_id: "77" }));
  });

  it("passes filter[updated_after] when updated_after provided", async () => {
    vi.mocked(mycaseGet).mockResolvedValue({ data: [] });

    await mock.call("list-calendar-events", { updated_after: "2025-01-01T00:00:00Z" });

    expect(mycaseGet).toHaveBeenCalledWith("/events", expect.objectContaining({
      "filter[updated_after]": "2025-01-01T00:00:00Z",
    }));
  });

  it("passes page_token when provided", async () => {
    vi.mocked(mycaseGet).mockResolvedValue({ data: [] });

    await mock.call("list-calendar-events", { page_token: "tok_abc" });

    expect(mycaseGet).toHaveBeenCalledWith("/events", expect.objectContaining({ page_token: "tok_abc" }));
  });

  it("includes next_page_token in response when API returns one", async () => {
    vi.mocked(mycaseGet).mockResolvedValue({ data: [], next_page_token: "cursor-xyz" });

    const result = await mock.call("list-calendar-events", {});
    const data = parseResult(result);

    expect(data.next_page_token).toBe("cursor-xyz");
  });

  it("includes start and end fields in mapped response", async () => {
    vi.mocked(mycaseGet).mockResolvedValue({
      data: [{ id: 2, name: "Deposition", start: "2025-07-10T10:00:00Z", end: "2025-07-10T12:00:00Z", all_day: false }],
    });

    const result = await mock.call("list-calendar-events", {});
    const data = parseResult(result);

    expect(data.events[0].start).toBe("2025-07-10T10:00:00Z");
    expect(data.events[0].end).toBe("2025-07-10T12:00:00Z");
  });

  it("returns isError on API failure", async () => {
    vi.mocked(mycaseGet).mockRejectedValue(new Error("Network error"));

    const result = await mock.call("list-calendar-events", {});

    expect(result.isError).toBe(true);
  });
});
