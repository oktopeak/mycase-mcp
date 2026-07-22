import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerCaseTools } from "../../src/tools/cases.js";
import { createMockServer, parseResult, MOCK_TOKENS } from "../helpers.js";

vi.mock("../../src/mycase-client.js", () => ({
  mycaseGet: vi.fn(),
  mycaseGetPage: vi.fn(),
  mycasePost: vi.fn(),
  MyCaseApiError: class MyCaseApiError extends Error {
    constructor(public status: number, message: string) {
      super(message);
      this.name = "MyCaseApiError";
    }
  },
}));
vi.mock("../../src/auth/token-store.js", () => ({ loadTokens: vi.fn() }));
vi.mock("../../src/audit/logger.js", () => ({ auditLog: vi.fn() }));

import { mycaseGet, mycaseGetPage, MyCaseApiError } from "../../src/mycase-client.js";
import { loadTokens } from "../../src/auth/token-store.js";

describe("list-cases", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerCaseTools(mock.server);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
  });

  it("returns cases from the API", async () => {
    const cases = [{ id: 1, name: "Smith v Jones", status: "open" }];
    vi.mocked(mycaseGetPage).mockResolvedValue({ data: cases });

    const result = await mock.call("list-cases", { page_size: 25 });
    const data = parseResult(result);

    expect(data.cases).toEqual(cases);
    expect(data.complete).toBe(true);
    expect(mycaseGetPage).toHaveBeenCalledWith("/cases", expect.objectContaining({ page_size: 25 }));
  });

  it("passes filter[status] when status provided", async () => {
    vi.mocked(mycaseGetPage).mockResolvedValue({ data: [] });

    await mock.call("list-cases", { status: "closed" });

    expect(mycaseGetPage).toHaveBeenCalledWith("/cases", expect.objectContaining({ "filter[status]": "closed" }));
  });

  it("does not send filter[status] when omitted", async () => {
    vi.mocked(mycaseGetPage).mockResolvedValue({ data: [] });

    await mock.call("list-cases", {});

    const call = vi.mocked(mycaseGetPage).mock.calls[0][1] as Record<string, unknown>;
    expect(call["filter[status]"]).toBeUndefined();
  });

  it("resumes from a supplied page_token instead of restarting from the beginning", async () => {
    vi.mocked(mycaseGetPage).mockResolvedValue({ data: [] });

    await mock.call("list-cases", { page_token: "tok_abc" });

    expect(mycaseGetPage).toHaveBeenCalledWith("/cases", expect.objectContaining({ page_token: "tok_abc" }));
  });

  it("passes filter[updated_after] when provided", async () => {
    vi.mocked(mycaseGetPage).mockResolvedValue({ data: [] });

    await mock.call("list-cases", { updated_after: "2024-01-01T00:00:00Z" });

    expect(mycaseGetPage).toHaveBeenCalledWith("/cases", expect.objectContaining({ "filter[updated_after]": "2024-01-01T00:00:00Z" }));
  });

  it("paginates to completion by following the Link-header cursor", async () => {
    const page1 = [{ id: 1, name: "Case A" }];
    const page2 = [{ id: 2, name: "Case B" }];

    vi.mocked(mycaseGetPage)
      .mockResolvedValueOnce({ data: page1, nextPageToken: "cursor-1" })
      .mockResolvedValueOnce({ data: page2 });

    const result = await mock.call("list-cases", {});
    const data = parseResult(result);

    expect(mycaseGetPage).toHaveBeenCalledTimes(2);
    expect(data.cases).toHaveLength(2);
    expect(data.complete).toBe(true);
  });

  it("reports complete:false with a resumable cursor instead of silently truncating", async () => {
    vi.mocked(mycaseGetPage).mockImplementation(async () => ({
      data: [{ id: 1, name: "x" }],
      nextPageToken: "always-more",
    }));

    const result = await mock.call("list-cases", {});
    const data = parseResult(result);

    expect(data.complete).toBe(false);
    expect(data.truncated_reason).toBe("page_limit_reached");
    expect(data.next_page_token).toBe("always-more");
  });

  it("returns isError on API failure", async () => {
    vi.mocked(mycaseGetPage).mockRejectedValue(new Error("Network error"));

    const result = await mock.call("list-cases", {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error listing cases");
  });

  it("surfaces an expired/invalid page_token as an error rather than an empty list", async () => {
    vi.mocked(mycaseGetPage).mockRejectedValue(new Error("Invalid or expired page_token"));

    const result = await mock.call("list-cases", { page_token: "stale" });

    expect(result.isError).toBe(true);
  });
});

describe("get-case", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerCaseTools(mock.server);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
  });

  it("returns the case object", async () => {
    const caseData = { id: 42, name: "Smith v Jones", status: "open" };
    vi.mocked(mycaseGet).mockResolvedValue(caseData);

    const result = await mock.call("get-case", { case_id: "42" });
    const data = parseResult(result);

    expect(data).toEqual(caseData);
    expect(mycaseGet).toHaveBeenCalledWith("/cases/42");
  });

  it("returns error object on 404 without isError flag", async () => {
    vi.mocked(mycaseGet).mockRejectedValue(new MyCaseApiError(404, "Not found: /cases/999"));

    const result = await mock.call("get-case", { case_id: "999" });
    const data = parseResult(result);

    expect(data.error).toContain("999");
    expect(result.isError).toBeUndefined();
  });

  it("returns isError on non-404 API failure", async () => {
    vi.mocked(mycaseGet).mockRejectedValue(new MyCaseApiError(500, "Internal server error"));

    const result = await mock.call("get-case", { case_id: "1" });

    expect(result.isError).toBe(true);
  });
});
