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

describe("search-contacts", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerContactTools(mock.server);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
  });

  it("returns contacts from the API", async () => {
    const apiData = {
      contacts: [{ id: 1, first_name: "Jane", last_name: "Smith", type: "person", email: "jane@example.com" }],
    };
    vi.mocked(mycaseGet).mockResolvedValue(apiData);

    const result = await mock.call("search-contacts", {});
    const data = parseResult(result);

    expect(data.contacts).toHaveLength(1);
    expect(data.contacts[0].name).toBe("Jane Smith");
  });

  it("passes query param to API", async () => {
    vi.mocked(mycaseGet).mockResolvedValue({ contacts: [] });

    await mock.call("search-contacts", { query: "Smith" });

    expect(mycaseGet).toHaveBeenCalledWith("/contacts", expect.objectContaining({ query: "Smith" }));
  });

  it("passes type param when not 'all'", async () => {
    vi.mocked(mycaseGet).mockResolvedValue({ contacts: [] });

    await mock.call("search-contacts", { type: "person" });

    expect(mycaseGet).toHaveBeenCalledWith("/contacts", expect.objectContaining({ type: "person" }));
  });

  it("does not pass type param when 'all'", async () => {
    vi.mocked(mycaseGet).mockResolvedValue({ contacts: [] });

    await mock.call("search-contacts", { type: "all" });

    const params = vi.mocked(mycaseGet).mock.calls[0][1] as Record<string, unknown>;
    expect(params["type"]).toBeUndefined();
  });

  it("uses name field if present, otherwise builds from first+last", async () => {
    vi.mocked(mycaseGet).mockResolvedValue({
      contacts: [
        { id: 1, name: "Acme Corp", type: "company" },
        { id: 2, first_name: "John", last_name: "Doe" },
      ],
    });

    const result = await mock.call("search-contacts", {});
    const data = parseResult(result);

    expect(data.contacts[0].name).toBe("Acme Corp");
    expect(data.contacts[1].name).toBe("John Doe");
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

  it("returns contact data", async () => {
    const contactData = { contact: { id: 5, first_name: "Jane", last_name: "Smith" } };
    vi.mocked(mycaseGet).mockResolvedValue(contactData);

    const result = await mock.call("get-contact", { contact_id: "5" });
    const data = parseResult(result);

    expect(data).toEqual(contactData.contact);
    expect(mycaseGet).toHaveBeenCalledWith("/contacts/5");
  });

  it("returns error object on 404 without isError flag", async () => {
    vi.mocked(mycaseGet).mockRejectedValue(new MyCaseApiError(404, "Not found: /contacts/99"));

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
