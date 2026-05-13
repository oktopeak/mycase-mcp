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
      events: [{ id: 1, title: "Hearing", start_at: "2025-06-01T09:00:00Z" }],
    });

    const result = await mock.call("list-calendar-events", {
      start_date: "2025-06-01",
      end_date: "2025-06-30",
    });
    const data = parseResult(result);

    expect(data.events).toHaveLength(1);
    expect(data.events[0].title).toBe("Hearing");
  });

  it("defaults start_date to today and end_date to 30 days out", async () => {
    vi.mocked(mycaseGet).mockResolvedValue({ events: [] });

    await mock.call("list-calendar-events", {});

    const params = vi.mocked(mycaseGet).mock.calls[0][1] as Record<string, unknown>;
    const today = new Date().toISOString().split("T")[0];
    expect(params["start_date"]).toBe(today);
    expect(typeof params["end_date"]).toBe("string");
    expect(params["end_date"] as string > today).toBe(true);
  });

  it("passes case_id param when provided", async () => {
    vi.mocked(mycaseGet).mockResolvedValue({ events: [] });

    await mock.call("list-calendar-events", { case_id: "77" });

    expect(mycaseGet).toHaveBeenCalledWith("/events", expect.objectContaining({ case_id: "77" }));
  });

  it("uses summary as title fallback", async () => {
    vi.mocked(mycaseGet).mockResolvedValue({
      events: [{ id: 2, summary: "Deposition" }],
    });

    const result = await mock.call("list-calendar-events", {});
    const data = parseResult(result);

    expect(data.events[0].title).toBe("Deposition");
  });

  it("returns isError on API failure", async () => {
    vi.mocked(mycaseGet).mockRejectedValue(new Error("Network error"));

    const result = await mock.call("list-calendar-events", {});

    expect(result.isError).toBe(true);
  });
});
