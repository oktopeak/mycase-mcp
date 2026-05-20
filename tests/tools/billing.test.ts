import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { registerBillingTools, listTimeEntriesSchema, logTimeEntrySchema } from "../../src/tools/billing.js";
import { createMockServer, parseResult, MOCK_TOKENS } from "../helpers.js";

vi.mock("../../src/mycase-client.js", () => ({
  mycaseGet: vi.fn(),
  mycasePost: vi.fn(),
  mycaseDelete: vi.fn(),
}));
vi.mock("../../src/auth/token-store.js", () => ({ loadTokens: vi.fn() }));
vi.mock("../../src/audit/logger.js", () => ({ auditLog: vi.fn() }));

import { mycaseGet, mycasePost, mycaseDelete } from "../../src/mycase-client.js";
import { loadTokens } from "../../src/auth/token-store.js";
import { auditLog } from "../../src/audit/logger.js";

const SAMPLE_ENTRY = {
  id: 1,
  activity_name: "Research",
  description: "Case law review",
  billable: true,
  entry_date: "2025-06-01",
  rate: "350.00",
  hours: 2.5,
  flat_fee: false,
  case: { id: 42 },
  staff: { id: 7 },
  created_at: "2025-06-01T10:00:00Z",
  updated_at: "2025-06-01T10:00:00Z",
};

// ---------------------------------------------------------------------------
// list-time-entries schema validation
// ---------------------------------------------------------------------------

describe("list-time-entries schema validation", () => {
  const schema = z.object(listTimeEntriesSchema);

  it("accepts date-only updated_after", () => {
    expect(schema.safeParse({ updated_after: "2025-01-01" }).success).toBe(true);
  });

  it("accepts full ISO 8601 timestamp with Z", () => {
    expect(schema.safeParse({ updated_after: "2025-01-01T00:00:00Z" }).success).toBe(true);
  });

  it("accepts ISO 8601 timestamp with offset", () => {
    expect(schema.safeParse({ updated_after: "2025-01-01T00:00:00+05:00" }).success).toBe(true);
  });

  it("rejects free-text updated_after", () => {
    expect(schema.safeParse({ updated_after: "yesterday" }).success).toBe(false);
  });

  it("rejects MM/DD/YYYY updated_after", () => {
    expect(schema.safeParse({ updated_after: "01/01/2025" }).success).toBe(false);
  });

  it("rejects page_size above 1000", () => {
    expect(schema.safeParse({ page_size: 1001 }).success).toBe(false);
  });

  it("rejects page_size of zero", () => {
    expect(schema.safeParse({ page_size: 0 }).success).toBe(false);
  });

  it("accepts empty input (all optional)", () => {
    expect(schema.safeParse({}).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// list-time-entries
// ---------------------------------------------------------------------------

describe("list-time-entries", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerBillingTools(mock.server);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
    vi.mocked(mycaseGet).mockResolvedValue([SAMPLE_ENTRY]);
  });

  it("returns time entries from the API", async () => {
    const result = await mock.call("list-time-entries", {});
    const data = parseResult(result);

    expect(data.time_entries).toHaveLength(1);
    expect(data.time_entries[0].hours).toBe(2.5);
    expect(data.time_entries[0].entry_date).toBe("2025-06-01");
    expect(data.time_entries[0].activity_name).toBe("Research");
  });

  it("passes case_id filter when provided", async () => {
    await mock.call("list-time-entries", { case_id: "42" });
    expect(mycaseGet).toHaveBeenCalledWith("/time_entries", expect.objectContaining({ case_id: "42" }));
  });

  it("passes filter[updated_after] when updated_after provided", async () => {
    await mock.call("list-time-entries", { updated_after: "2025-01-01T00:00:00Z" });
    expect(mycaseGet).toHaveBeenCalledWith("/time_entries", expect.objectContaining({ "filter[updated_after]": "2025-01-01T00:00:00Z" }));
  });

  it("passes page_size and page_token for pagination", async () => {
    await mock.call("list-time-entries", { page_size: 50, page_token: "cursor_abc" });
    expect(mycaseGet).toHaveBeenCalledWith("/time_entries", expect.objectContaining({ page_size: 50, page_token: "cursor_abc" }));
  });

  it("handles non-array response without throwing", async () => {
    vi.mocked(mycaseGet).mockResolvedValue({ time_entries: [SAMPLE_ENTRY] });
    const result = await mock.call("list-time-entries", {});
    expect(result.isError).toBeUndefined();
    const data = parseResult(result);
    expect(data.time_entries).toHaveLength(0);
  });

  it("returns isError on API failure", async () => {
    vi.mocked(mycaseGet).mockRejectedValue(new Error("Network error"));
    const result = await mock.call("list-time-entries", {});
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// get-time-entry
// ---------------------------------------------------------------------------

describe("get-time-entry", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerBillingTools(mock.server);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
    vi.mocked(mycaseGet).mockResolvedValue(SAMPLE_ENTRY);
  });

  it("fetches /time_entries/{id} and returns mapped entry", async () => {
    const result = await mock.call("get-time-entry", { id: 1 });
    const data = parseResult(result);

    expect(mycaseGet).toHaveBeenCalledWith("/time_entries/1");
    expect(data.id).toBe(1);
    expect(data.activity_name).toBe("Research");
    expect(data.entry_date).toBe("2025-06-01");
  });

  it("audit logs success with case_id from response", async () => {
    await mock.call("get-time-entry", { id: 1 });
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({
      tool: "get-time-entry",
      outcome: "success",
      case_id: "42",
    }));
  });

  it("returns isError on API failure", async () => {
    vi.mocked(mycaseGet).mockRejectedValue(new Error("Not found"));
    const result = await mock.call("get-time-entry", { id: 999 });
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// log-time-entry — schema validation
// ---------------------------------------------------------------------------

describe("log-time-entry schema validation", () => {
  const schema = z.object(logTimeEntrySchema);

  const VALID = {
    case_id: 42,
    staff_id: 7,
    activity_name: "Research",
    hours: 1.5,
    entry_date: "2025-06-01",
    rate: 350,
  };

  it("accepts all required fields", () => {
    expect(schema.safeParse(VALID).success).toBe(true);
  });

  it("accepts all optional fields", () => {
    expect(schema.safeParse({ ...VALID, description: "Case review", billable: false, flat_fee: true }).success).toBe(true);
  });

  it("rejects missing case_id", () => {
    const { case_id: _c, ...rest } = VALID;
    expect(schema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing staff_id", () => {
    const { staff_id: _s, ...rest } = VALID;
    expect(schema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing activity_name", () => {
    const { activity_name: _a, ...rest } = VALID;
    expect(schema.safeParse(rest).success).toBe(false);
  });

  it("rejects empty activity_name", () => {
    expect(schema.safeParse({ ...VALID, activity_name: "" }).success).toBe(false);
  });

  it("rejects missing hours", () => {
    const { hours: _h, ...rest } = VALID;
    expect(schema.safeParse(rest).success).toBe(false);
  });

  it("rejects zero hours", () => {
    expect(schema.safeParse({ ...VALID, hours: 0 }).success).toBe(false);
  });

  it("rejects negative hours", () => {
    expect(schema.safeParse({ ...VALID, hours: -1 }).success).toBe(false);
  });

  it("rejects missing entry_date", () => {
    const { entry_date: _d, ...rest } = VALID;
    expect(schema.safeParse(rest).success).toBe(false);
  });

  it("rejects entry_date with wrong format", () => {
    expect(schema.safeParse({ ...VALID, entry_date: "06/01/2025" }).success).toBe(false);
  });

  it("rejects missing rate", () => {
    const { rate: _r, ...rest } = VALID;
    expect(schema.safeParse(rest).success).toBe(false);
  });

  it("rejects non-positive rate", () => {
    expect(schema.safeParse({ ...VALID, rate: 0 }).success).toBe(false);
  });

  it("rejects non-integer case_id", () => {
    expect(schema.safeParse({ ...VALID, case_id: 1.5 }).success).toBe(false);
  });

  it("rejects non-integer staff_id", () => {
    expect(schema.safeParse({ ...VALID, staff_id: 1.5 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// log-time-entry — tool behaviour
// ---------------------------------------------------------------------------

describe("log-time-entry", () => {
  let mock: ReturnType<typeof createMockServer>;

  const BASE_ARGS = {
    case_id: 42,
    staff_id: 7,
    activity_name: "Research",
    hours: 1.5,
    entry_date: "2025-06-01",
    rate: 350,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerBillingTools(mock.server);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
    vi.mocked(mycasePost).mockResolvedValue(SAMPLE_ENTRY);
  });

  it("posts to /time_entries with correct body and returns mapped entry", async () => {
    const result = await mock.call("log-time-entry", BASE_ARGS);
    const data = parseResult(result);

    expect(data.id).toBe(1);
    expect(mycasePost).toHaveBeenCalledWith("/time_entries", expect.objectContaining({
      activity_name: "Research",
      entry_date: "2025-06-01",
      rate: 350,
      hours: 1.5,
      case: { id: 42 },
      staff: { id: 7 },
      billable: true,
    }));
  });

  it("includes description and flat_fee when provided", async () => {
    await mock.call("log-time-entry", { ...BASE_ARGS, description: "Case law review", flat_fee: true });
    expect(mycasePost).toHaveBeenCalledWith("/time_entries", expect.objectContaining({
      description: "Case law review",
      flat_fee: true,
    }));
  });

  it("respects explicit billable: false", async () => {
    await mock.call("log-time-entry", { ...BASE_ARGS, billable: false });
    expect(mycasePost).toHaveBeenCalledWith("/time_entries", expect.objectContaining({ billable: false }));
  });

  it("omits description from body when not provided", async () => {
    await mock.call("log-time-entry", BASE_ARGS);
    const body = vi.mocked(mycasePost).mock.calls[0][1] as Record<string, unknown>;
    expect(body).not.toHaveProperty("description");
  });

  it("omits flat_fee from body when not provided", async () => {
    await mock.call("log-time-entry", BASE_ARGS);
    const body = vi.mocked(mycasePost).mock.calls[0][1] as Record<string, unknown>;
    expect(body).not.toHaveProperty("flat_fee");
  });

  it("audit logs success with case_id and hours", async () => {
    await mock.call("log-time-entry", BASE_ARGS);
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({
      tool: "log-time-entry",
      outcome: "success",
      case_id: "42",
      result_count: 1,
    }));
  });

  it("returns isError and audit logs error on API failure", async () => {
    vi.mocked(mycasePost).mockRejectedValue(new Error("Unprocessable Entity"));
    const result = await mock.call("log-time-entry", BASE_ARGS);

    expect(result.isError).toBe(true);
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({
      tool: "log-time-entry",
      outcome: "error",
      case_id: "42",
    }));
  });

  it("returns isError when API returns null (empty body)", async () => {
    vi.mocked(mycasePost).mockResolvedValue(null);
    const result = await mock.call("log-time-entry", BASE_ARGS);

    expect(result.isError).toBe(true);
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({
      tool: "log-time-entry",
      outcome: "error",
    }));
  });
});

// ---------------------------------------------------------------------------
// delete-time-entry
// ---------------------------------------------------------------------------

describe("delete-time-entry", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerBillingTools(mock.server);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
    vi.mocked(mycaseDelete).mockResolvedValue(undefined);
  });

  it("calls DELETE /time_entries/{id} and returns success", async () => {
    const result = await mock.call("delete-time-entry", { id: 1 });
    const data = parseResult(result);

    expect(mycaseDelete).toHaveBeenCalledWith("/time_entries/1");
    expect(data.success).toBe(true);
    expect(data.id).toBe(1);
  });

  it("audit logs success", async () => {
    await mock.call("delete-time-entry", { id: 1 });
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({
      tool: "delete-time-entry",
      outcome: "success",
    }));
  });

  it("returns isError on API failure", async () => {
    vi.mocked(mycaseDelete).mockRejectedValue(new Error("Not found"));
    const result = await mock.call("delete-time-entry", { id: 999 });

    expect(result.isError).toBe(true);
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({
      tool: "delete-time-entry",
      outcome: "error",
    }));
  });
});

// ---------------------------------------------------------------------------
// get-billing-summary
// ---------------------------------------------------------------------------

describe("get-billing-summary", () => {
  let mock: ReturnType<typeof createMockServer>;

  const INVOICES = [
    { id: 1, status: "sent",  total: 1000, balance: 500,  paid_amount: 500,  issued_at: "2025-01-01" },
    { id: 2, status: "paid",  total: 2000, balance: 0,    paid_amount: 2000, issued_at: "2025-02-01" },
    { id: 3, status: "void",  total: 500,  balance: 500,  paid_amount: 0,    issued_at: "2025-03-01" },
    { id: 4, status: "draft", total: 300,  balance: 300,  paid_amount: 0,    issued_at: "2025-04-01" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerBillingTools(mock.server);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
  });

  it("aggregates totals excluding void and draft invoices", async () => {
    vi.mocked(mycaseGet).mockResolvedValue({ invoices: INVOICES });

    const result = await mock.call("get-billing-summary", { case_id: "10" });
    const data = parseResult(result);

    expect(data.total_billed).toBe(3000);
    expect(data.total_paid).toBe(2500);
    expect(data.total_outstanding).toBe(500);
    expect(data.invoice_count).toBe(2);
  });

  it("uses meta totals when provided by API", async () => {
    vi.mocked(mycaseGet).mockResolvedValue({
      invoices: INVOICES,
      meta: { total_billed: 9999, total_outstanding: 100, total_paid: 9899 },
    });

    const result = await mock.call("get-billing-summary", { case_id: "10" });
    const data = parseResult(result);

    expect(data.total_billed).toBe(9999);
    expect(data.total_outstanding).toBe(100);
    expect(data.total_paid).toBe(9899);
  });

  it("picks the most recent non-void/draft invoice as last_invoice_date", async () => {
    vi.mocked(mycaseGet).mockResolvedValue({ invoices: INVOICES });

    const result = await mock.call("get-billing-summary", { case_id: "10" });
    const data = parseResult(result);

    expect(data.last_invoice_date).toBe("2025-02-01");
  });

  it("includes invoice list in response", async () => {
    vi.mocked(mycaseGet).mockResolvedValue({ invoices: INVOICES });

    const result = await mock.call("get-billing-summary", { case_id: "10" });
    const data = parseResult(result);

    expect(data.invoices).toHaveLength(4);
  });

  it("returns isError on API failure", async () => {
    vi.mocked(mycaseGet).mockRejectedValue(new Error("Network error"));

    const result = await mock.call("get-billing-summary", { case_id: "10" });

    expect(result.isError).toBe(true);
  });
});
