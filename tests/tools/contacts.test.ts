import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerContactTools } from "../../src/tools/contacts.js";
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

const CLIENTS = [
  { id: 1, first_name: "John", last_name: "Smith", email: "john@example.com", cell_phone_number: "555-1234" },
  { id: 2, first_name: "Jane", last_name: "Doe",   email: "jane@example.com" },
];

describe("search-contacts", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerContactTools(mock.server);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
    vi.mocked(mycaseGet).mockResolvedValue(CLIENTS);
  });

  it("calls /clients and returns results", async () => {
    const result = await mock.call("search-contacts", { page_size: 25 });
    const data = parseResult(result);

    expect(mycaseGet).toHaveBeenCalledWith("/clients", expect.objectContaining({ page_size: 25 }));
    expect(data.clients).toHaveLength(2);
  });

  it("builds full name from first_name + last_name", async () => {
    const result = await mock.call("search-contacts", {});
    const data = parseResult(result);

    expect(data.clients[0].name).toBe("John Smith");
    expect(data.clients[1].name).toBe("Jane Doe");
  });

  it("passes filter[first_name] when first_name supplied", async () => {
    await mock.call("search-contacts", { first_name: "John" });

    expect(mycaseGet).toHaveBeenCalledWith("/clients", expect.objectContaining({ "filter[first_name]": "John" }));
  });

  it("passes filter[last_name] when last_name supplied", async () => {
    await mock.call("search-contacts", { last_name: "Smith" });

    expect(mycaseGet).toHaveBeenCalledWith("/clients", expect.objectContaining({ "filter[last_name]": "Smith" }));
  });

  it("passes filter[email] when email supplied", async () => {
    await mock.call("search-contacts", { email: "john@example.com" });

    expect(mycaseGet).toHaveBeenCalledWith("/clients", expect.objectContaining({ "filter[email]": "john@example.com" }));
  });

  it("passes filter[cell_phone_number] when phone supplied", async () => {
    await mock.call("search-contacts", { phone: "555-1234" });

    expect(mycaseGet).toHaveBeenCalledWith("/clients", expect.objectContaining({ "filter[cell_phone_number]": "555-1234" }));
  });

  it("handles bare-array response correctly (no wrapper object)", async () => {
    vi.mocked(mycaseGet).mockResolvedValue([{ id: 3, first_name: "Alice", last_name: "Brown" }]);

    const result = await mock.call("search-contacts", {});
    const data = parseResult(result);

    expect(data.clients).toHaveLength(1);
    expect(data.clients[0].name).toBe("Alice Brown");
  });

  it("returns isError on API failure", async () => {
    vi.mocked(mycaseGet).mockRejectedValue(new Error("Network error"));

    const result = await mock.call("search-contacts", {});

    expect(result.isError).toBe(true);
  });
});

describe("get-contact", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerContactTools(mock.server);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
  });

  it("calls /clients/{id} and returns bare object", async () => {
    const clientData = { id: 5, first_name: "John", last_name: "Smith", email: "john@example.com" };
    vi.mocked(mycaseGet).mockResolvedValue(clientData);

    const result = await mock.call("get-contact", { contact_id: "5" });
    const data = parseResult(result);

    expect(mycaseGet).toHaveBeenCalledWith("/clients/5");
    expect(data.id).toBe(5);
    expect(data.first_name).toBe("John");
  });

  it("returns error object on 404 without isError flag", async () => {
    vi.mocked(mycaseGet).mockRejectedValue(new MyCaseApiError(404, "Not found: /clients/99"));

    const result = await mock.call("get-contact", { contact_id: "99" });
    const data = parseResult(result);

    expect(data.error).toContain("99");
    expect(result.isError).toBeUndefined();
  });

  it("returns isError on non-404 failure", async () => {
    vi.mocked(mycaseGet).mockRejectedValue(new MyCaseApiError(500, "Server error"));

    const result = await mock.call("get-contact", { contact_id: "1" });

    expect(result.isError).toBe(true);
  });
});
