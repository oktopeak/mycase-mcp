import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerStaffTools } from "../../src/tools/staff.js";
import { createMockServer, parseResult, MOCK_TOKENS } from "../helpers.js";

vi.mock("../../src/mycase-client.js", () => ({
  mycaseGet: vi.fn(),
  mycaseGetPage: vi.fn(),
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

const STAFF = [
  { id: 1, first_name: "Ann", last_name: "Lee", active: true },
  { id: 2, first_name: "Bo",  last_name: "Kim", active: false },
];

describe("list-staff", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerStaffTools(mock.server);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
    vi.mocked(mycaseGetPage).mockResolvedValue({ data: STAFF });
  });

  it("returns staff from the API", async () => {
    const result = await mock.call("list-staff", {});
    const data = parseResult(result);

    expect(data.staff).toHaveLength(2);
    expect(data.complete).toBe(true);
  });

  it("passes page_size to API up to the documented maximum of 1000", async () => {
    await mock.call("list-staff", { page_size: 1000 });

    expect(mycaseGetPage).toHaveBeenCalledWith("/staff", expect.objectContaining({ page_size: 1000 }));
  });

  it("passes filter[updated_after] when provided", async () => {
    await mock.call("list-staff", { updated_after: "2024-01-01T00:00:00Z" });

    expect(mycaseGetPage).toHaveBeenCalledWith("/staff", expect.objectContaining({ "filter[updated_after]": "2024-01-01T00:00:00Z" }));
  });

  it("resumes from a supplied page_token instead of restarting from the beginning", async () => {
    await mock.call("list-staff", { page_token: "tok_abc" });

    expect(mycaseGetPage).toHaveBeenCalledWith("/staff", expect.objectContaining({ page_token: "tok_abc" }));
  });

  it("paginates to completion by following the Link-header cursor", async () => {
    vi.mocked(mycaseGetPage)
      .mockResolvedValueOnce({ data: [STAFF[0]], nextPageToken: "cursor-1" })
      .mockResolvedValueOnce({ data: [STAFF[1]] });

    const result = await mock.call("list-staff", {});
    const data = parseResult(result);

    expect(mycaseGetPage).toHaveBeenCalledTimes(2);
    expect(data.staff).toHaveLength(2);
    expect(data.complete).toBe(true);
  });

  it("reports complete:false with a resumable cursor instead of silently truncating", async () => {
    vi.mocked(mycaseGetPage).mockImplementation(async () => ({
      data: [STAFF[0]],
      nextPageToken: "always-more",
    }));

    const result = await mock.call("list-staff", {});
    const data = parseResult(result);

    expect(data.complete).toBe(false);
    expect(data.truncated_reason).toBe("page_limit_reached");
    expect(data.next_page_token).toBe("always-more");
  });

  it("returns isError on API failure", async () => {
    vi.mocked(mycaseGetPage).mockRejectedValue(new Error("Network error"));

    const result = await mock.call("list-staff", {});

    expect(result.isError).toBe(true);
  });
});

describe("get-staff", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerStaffTools(mock.server);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
  });

  it("returns the staff member object", async () => {
    const staffData = { id: 5, first_name: "Ann", last_name: "Lee" };
    vi.mocked(mycaseGet).mockResolvedValue(staffData);

    const result = await mock.call("get-staff", { staff_id: "5" });
    const data = parseResult(result);

    expect(data).toEqual(staffData);
    expect(mycaseGet).toHaveBeenCalledWith("/staff/5");
  });

  it("returns error object on 404 without isError flag", async () => {
    vi.mocked(mycaseGet).mockRejectedValue(new MyCaseApiError(404, "Not found: /staff/99"));

    const result = await mock.call("get-staff", { staff_id: "99" });
    const data = parseResult(result);

    expect(data.error).toContain("99");
    expect(result.isError).toBeUndefined();
  });

  it("returns isError on non-404 failure", async () => {
    vi.mocked(mycaseGet).mockRejectedValue(new MyCaseApiError(500, "Server error"));

    const result = await mock.call("get-staff", { staff_id: "1" });

    expect(result.isError).toBe(true);
  });
});
