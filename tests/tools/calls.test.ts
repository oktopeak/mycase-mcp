import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerCallTools } from "../../src/tools/calls.js";
import { createMockServer, parseResult, MOCK_TOKENS } from "../helpers.js";

vi.mock("../../src/mycase-client.js", () => ({
  mycaseGet: vi.fn(),
  mycasePost: vi.fn(),
  mycasePut: vi.fn(),
  mycaseDelete: vi.fn(),
}));
vi.mock("../../src/auth/token-store.js", () => ({ loadTokens: vi.fn() }));
vi.mock("../../src/audit/logger.js", () => ({ auditLog: vi.fn() }));

import { mycaseGet, mycasePost, mycasePut, mycaseDelete } from "../../src/mycase-client.js";
import { loadTokens } from "../../src/auth/token-store.js";

const SAMPLE_CALL = {
  id: 42,
  called_at: "2024-01-15T14:30:00Z",
  caller_phone_number: "555-1234",
  call_for: { id: 1 },
  message: "Discussed case strategy",
  client: { id: 100 },
  call_type: "outgoing",
  resolved: false,
};

describe("list-calls", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerCallTools(mock.server);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
    vi.mocked(mycaseGet).mockResolvedValue([SAMPLE_CALL]);
  });

  it("lists calls and returns JSON", async () => {
    const result = await mock.call("list-calls", {});
    const data = JSON.parse(result.content[0].text as string);

    expect(Array.isArray(data)).toBe(true);
    expect(mycaseGet).toHaveBeenCalledWith("/calls", expect.any(Object));
  });

  it("passes updated_after filter", async () => {
    await mock.call("list-calls", { updated_after: "2024-01-01" });
    expect(mycaseGet).toHaveBeenCalledWith("/calls", expect.objectContaining({ "filter[updated_after]": "2024-01-01" }));
  });

  it("passes page_token for pagination", async () => {
    await mock.call("list-calls", { page_token: "cursor_abc123" });
    expect(mycaseGet).toHaveBeenCalledWith("/calls", expect.objectContaining({ page_token: "cursor_abc123" }));
  });

  it("handles non-array response without throwing", async () => {
    // Guard against API ever returning an envelope object instead of a bare array.
    vi.mocked(mycaseGet).mockResolvedValue({ calls: [SAMPLE_CALL] });
    const result = await mock.call("list-calls", {});
    expect(result.isError).toBeUndefined();
  });

  it("returns isError on API failure", async () => {
    vi.mocked(mycaseGet).mockRejectedValue(new Error("Network error"));
    const result = await mock.call("list-calls", {});
    expect(result.isError).toBe(true);
  });
});

describe("log-call", () => {
  let mock: ReturnType<typeof createMockServer>;

  const BASE_ARGS = {
    called_at: "2024-01-15T14:30:00Z",
    caller_phone_number: "555-1234",
    call_for_staff_id: 1,
    message: "Discussed case strategy",
    client_id: 100,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerCallTools(mock.server);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
    vi.mocked(mycasePost).mockResolvedValue(null); // 202 Accepted, no body
  });

  it("posts call with client_id and returns success", async () => {
    const result = await mock.call("log-call", BASE_ARGS);
    const data = parseResult(result);

    expect(data.success).toBe(true);
    expect(mycasePost).toHaveBeenCalledWith("/calls", expect.objectContaining({
      called_at: "2024-01-15T14:30:00Z",
      caller_phone_number: "555-1234",
      call_for: { id: 1 },
      message: "Discussed case strategy",
      client: { id: 100 },
    }));
  });

  it("posts call with caller_name", async () => {
    await mock.call("log-call", { ...BASE_ARGS, client_id: undefined, caller_name: "John Smith" });
    expect(mycasePost).toHaveBeenCalledWith("/calls", expect.objectContaining({ caller_name: "John Smith" }));
  });

  it("posts call with lead_id", async () => {
    await mock.call("log-call", { ...BASE_ARGS, client_id: undefined, lead_id: 55 });
    expect(mycasePost).toHaveBeenCalledWith("/calls", expect.objectContaining({ lead: { id: 55 } }));
  });

  it("returns isError when none of caller_name/client_id/lead_id provided", async () => {
    const result = await mock.call("log-call", {
      called_at: "2024-01-15T14:30:00Z",
      caller_phone_number: "555-1234",
      call_for_staff_id: 1,
      message: "Call",
    });
    expect(result.isError).toBe(true);
    expect(mycasePost).not.toHaveBeenCalled();
  });

  it("returns isError when more than one of the mutex fields provided", async () => {
    const result = await mock.call("log-call", { ...BASE_ARGS, caller_name: "John" });
    expect(result.isError).toBe(true);
    expect(mycasePost).not.toHaveBeenCalled();
  });

  it("includes call data in response when API returns a body", async () => {
    vi.mocked(mycasePost).mockResolvedValue({ id: 99, subject: "Check-in" });
    const result = await mock.call("log-call", BASE_ARGS);
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.call).toEqual({ id: 99, subject: "Check-in" });
  });

  it("does not include sibling mutex fields in body when client_id is used", async () => {
    await mock.call("log-call", BASE_ARGS);
    const body = vi.mocked(mycasePost).mock.calls[0][1] as Record<string, unknown>;
    expect(body).not.toHaveProperty("caller_name");
    expect(body).not.toHaveProperty("lead");
  });

  it("includes optional call_type and resolved", async () => {
    await mock.call("log-call", { ...BASE_ARGS, call_type: "incoming", resolved: true });
    const body = vi.mocked(mycasePost).mock.calls[0][1] as Record<string, unknown>;
    expect(body.call_type).toBe("incoming");
    expect(body.resolved).toBe(true);
  });

  it("returns isError on API failure", async () => {
    vi.mocked(mycasePost).mockRejectedValue(new Error("Bad request"));
    const result = await mock.call("log-call", BASE_ARGS);
    expect(result.isError).toBe(true);
  });
});

describe("update-call", () => {
  let mock: ReturnType<typeof createMockServer>;

  const BASE_ARGS = {
    id: 42,
    called_at: "2024-01-15T14:30:00Z",
    caller_phone_number: "555-1234",
    call_for_staff_id: 1,
    message: "Updated notes",
    client_id: 100,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerCallTools(mock.server);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
    vi.mocked(mycasePut).mockResolvedValue(null); // 204 No Content
  });

  it("puts to /calls/:id and returns success", async () => {
    const result = await mock.call("update-call", BASE_ARGS);
    const data = parseResult(result);

    expect(data.success).toBe(true);
    expect(mycasePut).toHaveBeenCalledWith("/calls/42", expect.objectContaining({
      called_at: "2024-01-15T14:30:00Z",
      client: { id: 100 },
    }));
  });

  it("puts with caller_name variant", async () => {
    const args = { ...BASE_ARGS, client_id: undefined, caller_name: "Jane Doe" };
    await mock.call("update-call", args);
    expect(mycasePut).toHaveBeenCalledWith("/calls/42", expect.objectContaining({ caller_name: "Jane Doe" }));
    const body = vi.mocked(mycasePut).mock.calls[0][1] as Record<string, unknown>;
    expect(body).not.toHaveProperty("client");
    expect(body).not.toHaveProperty("lead");
  });

  it("puts with lead_id variant", async () => {
    const args = { ...BASE_ARGS, client_id: undefined, lead_id: 77 };
    await mock.call("update-call", args);
    expect(mycasePut).toHaveBeenCalledWith("/calls/42", expect.objectContaining({ lead: { id: 77 } }));
    const body = vi.mocked(mycasePut).mock.calls[0][1] as Record<string, unknown>;
    expect(body).not.toHaveProperty("caller_name");
    expect(body).not.toHaveProperty("client");
  });

  it("includes optional call_type and resolved", async () => {
    await mock.call("update-call", { ...BASE_ARGS, call_type: "outgoing", resolved: true });
    const body = vi.mocked(mycasePut).mock.calls[0][1] as Record<string, unknown>;
    expect(body.call_type).toBe("outgoing");
    expect(body.resolved).toBe(true);
  });

  it("returns isError when no mutex field provided", async () => {
    const { client_id: _dropped, ...noMutex } = BASE_ARGS;
    const result = await mock.call("update-call", noMutex);
    expect(result.isError).toBe(true);
    expect(mycasePut).not.toHaveBeenCalled();
  });

  it("returns isError when more than one mutex field provided", async () => {
    const result = await mock.call("update-call", { ...BASE_ARGS, caller_name: "Jane" });
    expect(result.isError).toBe(true);
    expect(mycasePut).not.toHaveBeenCalled();
  });

  it("returns isError on API failure", async () => {
    vi.mocked(mycasePut).mockRejectedValue(new Error("Not found"));
    const result = await mock.call("update-call", BASE_ARGS);
    expect(result.isError).toBe(true);
  });
});

describe("delete-call", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerCallTools(mock.server);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
    vi.mocked(mycaseDelete).mockResolvedValue(null); // 204 No Content
  });

  it("deletes /calls/:id and returns success", async () => {
    const result = await mock.call("delete-call", { id: 42 });
    const data = parseResult(result);

    expect(data.success).toBe(true);
    expect(mycaseDelete).toHaveBeenCalledWith("/calls/42");
  });

  it("returns isError on API failure", async () => {
    vi.mocked(mycaseDelete).mockRejectedValue(new Error("Not found"));
    const result = await mock.call("delete-call", { id: 99 });
    expect(result.isError).toBe(true);
  });
});
