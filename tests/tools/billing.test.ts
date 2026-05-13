import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerBillingTools } from "../../src/tools/billing.js";
import { createMockServer, parseResult, MOCK_TOKENS } from "../helpers.js";

vi.mock("../../src/mycase-client.js", () => ({ mycaseGet: vi.fn() }));
vi.mock("../../src/auth/token-store.js", () => ({ loadTokens: vi.fn() }));
vi.mock("../../src/audit/logger.js", () => ({ auditLog: vi.fn() }));

import { mycaseGet } from "../../src/mycase-client.js";
import { loadTokens } from "../../src/auth/token-store.js";

describe("list-time-entries", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerBillingTools(mock.server);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
  });

  it("returns time entries from the API", async () => {
    vi.mocked(mycaseGet).mockResolvedValue({
      time_entries: [{ id: 1, hours: 2.5, rate: 300, amount: 750, description: "Research" }],
    });

    const result = await mock.call("list-time-entries", {});
    const data = parseResult(result);

    expect(data.time_entries).toHaveLength(1);
    expect(data.time_entries[0].hours).toBe(2.5);
  });

  it("passes case_id when provided", async () => {
    vi.mocked(mycaseGet).mockResolvedValue({ time_entries: [] });

    await mock.call("list-time-entries", { case_id: "42" });

    expect(mycaseGet).toHaveBeenCalledWith("/time_entries", expect.objectContaining({ case_id: "42" }));
  });

  it("passes date range params when provided", async () => {
    vi.mocked(mycaseGet).mockResolvedValue({ time_entries: [] });

    await mock.call("list-time-entries", { start_date: "2025-01-01", end_date: "2025-01-31" });

    expect(mycaseGet).toHaveBeenCalledWith("/time_entries", expect.objectContaining({
      start_date: "2025-01-01",
      end_date: "2025-01-31",
    }));
  });

  it("returns isError on API failure", async () => {
    vi.mocked(mycaseGet).mockRejectedValue(new Error("Network error"));

    const result = await mock.call("list-time-entries", {});

    expect(result.isError).toBe(true);
  });
});

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

    expect(data.total_billed).toBe(3000);      // 1000 + 2000
    expect(data.total_paid).toBe(2500);         // 500 + 2000
    expect(data.total_outstanding).toBe(500);   // 500 + 0
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
