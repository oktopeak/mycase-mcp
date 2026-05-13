import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerCaseTools } from "../../src/tools/cases.js";
import { createMockServer, parseResult, MOCK_TOKENS } from "../helpers.js";

vi.mock("../../src/mycase-client.js", () => ({
  mycaseGet: vi.fn(),
  MyCaseApiError: class MyCaseApiError extends Error {
    constructor(public status: number, message: string) {
      super(message);
      this.name = "MyCaseApiError";
    }
  },
}));
vi.mock("../../src/auth/token-store.js", () => ({ loadTokens: vi.fn() }));
vi.mock("../../src/audit/logger.js", () => ({ auditLog: vi.fn() }));

import { mycaseGet, MyCaseApiError } from "../../src/mycase-client.js";
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
    vi.mocked(mycaseGet).mockResolvedValue(cases);

    const result = await mock.call("list-cases", { page_size: 25 });
    const data = parseResult(result);

    expect(data.cases).toEqual(cases);
    expect(mycaseGet).toHaveBeenCalledWith("/cases", expect.objectContaining({ page_size: 25 }));
  });

  it("passes filter[status] when status provided", async () => {
    vi.mocked(mycaseGet).mockResolvedValue([]);

    await mock.call("list-cases", { status: "closed" });

    expect(mycaseGet).toHaveBeenCalledWith("/cases", expect.objectContaining({ "filter[status]": "closed" }));
  });

  it("does not send filter[status] when omitted", async () => {
    vi.mocked(mycaseGet).mockResolvedValue([]);

    await mock.call("list-cases", {});

    const call = vi.mocked(mycaseGet).mock.calls[0][1] as Record<string, unknown>;
    expect(call["filter[status]"]).toBeUndefined();
  });

  it("passes page_token when provided", async () => {
    vi.mocked(mycaseGet).mockResolvedValue([]);

    await mock.call("list-cases", { page_token: "tok_abc" });

    expect(mycaseGet).toHaveBeenCalledWith("/cases", expect.objectContaining({ page_token: "tok_abc" }));
  });

  it("passes filter[updated_after] when provided", async () => {
    vi.mocked(mycaseGet).mockResolvedValue([]);

    await mock.call("list-cases", { updated_after: "2024-01-01T00:00:00Z" });

    expect(mycaseGet).toHaveBeenCalledWith("/cases", expect.objectContaining({ "filter[updated_after]": "2024-01-01T00:00:00Z" }));
  });

  it("returns isError on API failure", async () => {
    vi.mocked(mycaseGet).mockRejectedValue(new Error("Network error"));

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
