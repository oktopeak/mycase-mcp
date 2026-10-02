import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerCaseTools } from "../../src/tools/cases.js";
import { createMockServer, parseResult, MOCK_TOKENS } from "../helpers.js";

vi.mock("../../src/mycase-client.js", () => ({
  mycaseGet: vi.fn(),
  mycaseGetAll: vi.fn(),
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

import { mycaseGet, mycaseGetAll, mycaseGetPage, MyCaseApiError } from "../../src/mycase-client.js";
import { loadTokens } from "../../src/auth/token-store.js";

describe("list-cases", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerCaseTools(mock.server);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
  });

  it("pages through every case by default and reports complete", async () => {
    const cases = Array.from({ length: 35 }, (_, i) => ({ id: i + 1, name: `Case ${i + 1}`, status: "open" }));
    vi.mocked(mycaseGetAll).mockResolvedValue({ items: cases, complete: true, pages: 1 });

    const data = parseResult(await mock.call("list-cases", { status: "open" }));

    expect(data.cases).toHaveLength(35);
    expect(data.count).toBe(35);
    expect(data.complete).toBe(true);
    expect(mycaseGetAll).toHaveBeenCalledWith("/cases", expect.objectContaining({ "filter[status]": "open" }));
    const params = vi.mocked(mycaseGetAll).mock.calls[0][1] as Record<string, unknown>;
    expect(params.page_size).toBeUndefined();
  });

  it("warns when the full list could not be fetched", async () => {
    vi.mocked(mycaseGetAll).mockResolvedValue({ items: [{ id: 1 }], complete: false, pages: 1000, incompleteReason: "Stopped after 1000 pages." });

    const data = parseResult(await mock.call("list-cases", {}));

    expect(data.complete).toBe(false);
    expect(data.warning).toContain("INCOMPLETE");
  });

  it("does not send filter[status] when omitted", async () => {
    vi.mocked(mycaseGetAll).mockResolvedValue({ items: [], complete: true, pages: 1 });

    await mock.call("list-cases", {});

    const params = vi.mocked(mycaseGetAll).mock.calls[0][1] as Record<string, unknown>;
    expect(params["filter[status]"]).toBeUndefined();
  });

  it("passes filter[updated_after] when provided", async () => {
    vi.mocked(mycaseGetAll).mockResolvedValue({ items: [], complete: true, pages: 1 });

    await mock.call("list-cases", { updated_after: "2024-01-01T00:00:00Z" });

    expect(mycaseGetAll).toHaveBeenCalledWith("/cases", expect.objectContaining({ "filter[updated_after]": "2024-01-01T00:00:00Z" }));
  });

  it("with page_token returns that one page and the next cursor", async () => {
    vi.mocked(mycaseGetPage).mockResolvedValue({ items: [{ id: 9 }], nextPageToken: "tok_next" });

    const data = parseResult(await mock.call("list-cases", { page_token: "tok_abc", page_size: 25 }));

    expect(mycaseGetPage).toHaveBeenCalledWith("/cases", expect.objectContaining({ page_token: "tok_abc", page_size: 25 }));
    expect(data.next_page_token).toBe("tok_next");
    expect(data.complete).toBe(false);
  });

  it("returns isError on API failure", async () => {
    vi.mocked(mycaseGetAll).mockRejectedValue(new Error("Network error"));

    const result = await mock.call("list-cases", {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error listing cases");
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
