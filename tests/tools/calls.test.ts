import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerCallTools } from "../../src/tools/calls.js";
import { createMockServer, parseResult, MOCK_TOKENS } from "../helpers.js";

vi.mock("../../src/mycase-client.js", () => ({ mycasePost: vi.fn() }));
vi.mock("../../src/auth/token-store.js", () => ({ loadTokens: vi.fn() }));
vi.mock("../../src/audit/logger.js", () => ({ auditLog: vi.fn() }));

import { mycasePost } from "../../src/mycase-client.js";
import { loadTokens } from "../../src/auth/token-store.js";

describe("log-call", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerCallTools(mock.server);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
    vi.mocked(mycasePost).mockResolvedValue({ call: { id: 55, subject: "Client check-in" } });
  });

  it("posts call and returns success", async () => {
    const result = await mock.call("log-call", {
      subject: "Client check-in",
      case_id: "100",
    });
    const data = parseResult(result);

    expect(data.success).toBe(true);
    expect(mycasePost).toHaveBeenCalledWith("/calls", expect.objectContaining({
      call: expect.objectContaining({ subject: "Client check-in", case_id: "100" }),
    }));
  });

  it("returns isError when neither case_id nor contact_id provided", async () => {
    const result = await mock.call("log-call", { subject: "Orphan call" });

    expect(result.isError).toBe(true);
    expect(mycasePost).not.toHaveBeenCalled();
  });

  it("defaults date to today", async () => {
    await mock.call("log-call", { subject: "Call", case_id: "1" });

    const body = vi.mocked(mycasePost).mock.calls[0][1] as { call: Record<string, unknown> };
    const today = new Date().toISOString().split("T")[0];
    expect(body.call.date).toBe(today);
  });

  it("uses provided date over default", async () => {
    await mock.call("log-call", { subject: "Call", case_id: "1", date: "2025-01-15" });

    const body = vi.mocked(mycasePost).mock.calls[0][1] as { call: Record<string, unknown> };
    expect(body.call.date).toBe("2025-01-15");
  });

  it("includes optional fields when provided", async () => {
    await mock.call("log-call", {
      subject: "Call",
      contact_id: "5",
      notes: "Discussed settlement",
      duration_minutes: 30,
      direction: "outbound",
    });

    const body = vi.mocked(mycasePost).mock.calls[0][1] as { call: Record<string, unknown> };
    expect(body.call.notes).toBe("Discussed settlement");
    expect(body.call.duration_minutes).toBe(30);
    expect(body.call.direction).toBe("outbound");
  });

  it("works with only contact_id (no case_id)", async () => {
    const result = await mock.call("log-call", { subject: "Call", contact_id: "5" });
    const data = parseResult(result);

    expect(data.success).toBe(true);
  });

  it("returns isError on API failure", async () => {
    vi.mocked(mycasePost).mockRejectedValue(new Error("Bad request"));

    const result = await mock.call("log-call", { subject: "Call", case_id: "1" });

    expect(result.isError).toBe(true);
  });
});
