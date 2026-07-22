import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerBillingTools } from "../../src/tools/billing.js";
import { createMockServer, parseResult, MOCK_TOKENS } from "../helpers.js";

vi.mock("../../src/mycase-client.js", () => ({ mycaseGetPage: vi.fn() }));
vi.mock("../../src/auth/token-store.js", () => ({ loadTokens: vi.fn() }));
vi.mock("../../src/audit/logger.js", () => ({ auditLog: vi.fn() }));

import { mycaseGetPage } from "../../src/mycase-client.js";
import { loadTokens } from "../../src/auth/token-store.js";

describe("list-time-entries", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerBillingTools(mock.server);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
  });

  it("returns time entries from the bare-array API response", async () => {
    vi.mocked(mycaseGetPage).mockResolvedValue({
      data: [{ id: 1, hours: 2.5, rate: 300, amount: 750, description: "Research" }],
    });

    const result = await mock.call("list-time-entries", {});
    const data = parseResult(result);

    expect(data.time_entries).toHaveLength(1);
    expect(data.time_entries[0].hours).toBe(2.5);
    expect(data.complete).toBe(true);
  });

  it("falls back to a {time_entries: [...]} envelope if the API ever wraps results", async () => {
    vi.mocked(mycaseGetPage).mockResolvedValue({
      data: { time_entries: [{ id: 9, hours: 1 }] },
    });

    const result = await mock.call("list-time-entries", {});
    const data = parseResult(result);

    expect(data.time_entries).toHaveLength(1);
  });

  it("passes case_id when provided", async () => {
    vi.mocked(mycaseGetPage).mockResolvedValue({ data: [] });

    await mock.call("list-time-entries", { case_id: "42" });

    expect(mycaseGetPage).toHaveBeenCalledWith("/time_entries", expect.objectContaining({ case_id: "42" }));
  });

  it("passes date range params when provided", async () => {
    vi.mocked(mycaseGetPage).mockResolvedValue({ data: [] });

    await mock.call("list-time-entries", { start_date: "2025-01-01", end_date: "2025-01-31" });

    expect(mycaseGetPage).toHaveBeenCalledWith("/time_entries", expect.objectContaining({
      start_date: "2025-01-01",
      end_date: "2025-01-31",
    }));
  });

  it("computes total_hours and total_amount client-side over the complete fetched set", async () => {
    vi.mocked(mycaseGetPage)
      .mockResolvedValueOnce({ data: [{ id: 1, hours: 2, amount: 200 }], nextPageToken: "cursor-1" })
      .mockResolvedValueOnce({ data: [{ id: 2, hours: 3, amount: 300 }] });

    const result = await mock.call("list-time-entries", {});
    const data = parseResult(result);

    expect(data.time_entries).toHaveLength(2);
    expect(data.total).toBe(2);
    expect(data.total_hours).toBe(5);
    expect(data.total_amount).toBe(500);
    expect(data.complete).toBe(true);
  });

  it("reports complete:false and undefined totals instead of silently truncating", async () => {
    vi.mocked(mycaseGetPage).mockImplementation(async () => ({
      data: [{ id: 1, hours: 2, amount: 200 }],
      nextPageToken: "always-more",
    }));

    const result = await mock.call("list-time-entries", {});
    const data = parseResult(result);

    expect(data.complete).toBe(false);
    expect(data.truncated_reason).toBe("page_limit_reached");
    expect(data.total_hours).toBeUndefined();
    expect(data.total_amount).toBeUndefined();
  });

  it("returns isError on API failure", async () => {
    vi.mocked(mycaseGetPage).mockRejectedValue(new Error("Network error"));

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
    vi.mocked(mycaseGetPage).mockResolvedValue({ data: INVOICES });

    const result = await mock.call("get-billing-summary", { case_id: "10" });
    const data = parseResult(result);

    expect(data.total_billed).toBe(3000);      // 1000 + 2000
    expect(data.total_paid).toBe(2500);         // 500 + 2000
    expect(data.total_outstanding).toBe(500);   // 500 + 0
    expect(data.invoice_count).toBe(2);
    expect(data.complete).toBe(true);
  });

  it("paginates to completion before totaling, across multiple invoice pages", async () => {
    vi.mocked(mycaseGetPage)
      .mockResolvedValueOnce({ data: [INVOICES[0]], nextPageToken: "cursor-1" })
      .mockResolvedValueOnce({ data: [INVOICES[1]] });

    const result = await mock.call("get-billing-summary", { case_id: "10" });
    const data = parseResult(result);

    expect(mycaseGetPage).toHaveBeenCalledTimes(2);
    expect(data.total_billed).toBe(3000);
    expect(data.invoices).toHaveLength(2);
  });

  it("picks the most recent non-void/draft invoice as last_invoice_date", async () => {
    vi.mocked(mycaseGetPage).mockResolvedValue({ data: INVOICES });

    const result = await mock.call("get-billing-summary", { case_id: "10" });
    const data = parseResult(result);

    expect(data.last_invoice_date).toBe("2025-02-01");
  });

  it("includes invoice list in response", async () => {
    vi.mocked(mycaseGetPage).mockResolvedValue({ data: INVOICES });

    const result = await mock.call("get-billing-summary", { case_id: "10" });
    const data = parseResult(result);

    expect(data.invoices).toHaveLength(4);
  });

  it("reports complete:false with a resumable cursor instead of silently truncating totals", async () => {
    vi.mocked(mycaseGetPage).mockImplementation(async () => ({
      data: [INVOICES[0]],
      nextPageToken: "always-more",
    }));

    const result = await mock.call("get-billing-summary", { case_id: "10" });
    const data = parseResult(result);

    expect(data.complete).toBe(false);
    expect(data.truncated_reason).toBe("page_limit_reached");
    expect(data.next_page_token).toBe("always-more");
  });

  it("returns isError on API failure", async () => {
    vi.mocked(mycaseGetPage).mockRejectedValue(new Error("Network error"));

    const result = await mock.call("get-billing-summary", { case_id: "10" });

    expect(result.isError).toBe(true);
  });
});
