import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerDocumentTools } from "../../src/tools/documents.js";
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

describe("list-documents", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerDocumentTools(mock.server);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
  });

  it("returns documents from the API", async () => {
    vi.mocked(mycaseGet).mockResolvedValue({
      data: [{ id: 1, name: "Contract.pdf", filename: "contract.pdf", path: "/Contracts" }],
    });

    const result = await mock.call("list-documents", {});
    const data = parseResult(result);

    expect(data.documents).toHaveLength(1);
    expect(data.documents[0].name).toBe("Contract.pdf");
  });

  it("passes case_id param when provided", async () => {
    vi.mocked(mycaseGet).mockResolvedValue({ data: [] });

    await mock.call("list-documents", { case_id: "42" });

    expect(mycaseGet).toHaveBeenCalledWith("/documents", expect.objectContaining({ case_id: "42" }));
  });

  it("sends page_size to API", async () => {
    vi.mocked(mycaseGet).mockResolvedValue({ data: [] });

    await mock.call("list-documents", { page_size: 50 });

    expect(mycaseGet).toHaveBeenCalledWith("/documents", expect.objectContaining({ page_size: 50 }));
  });

  it("passes page_token when provided", async () => {
    vi.mocked(mycaseGet).mockResolvedValue({ data: [] });

    await mock.call("list-documents", { page_token: "tok_abc" });

    expect(mycaseGet).toHaveBeenCalledWith("/documents", expect.objectContaining({ page_token: "tok_abc" }));
  });

  it("includes both name and filename separately in response", async () => {
    vi.mocked(mycaseGet).mockResolvedValue({
      data: [{ id: 2, name: "Brief", filename: "brief.docx" }],
    });

    const result = await mock.call("list-documents", {});
    const data = parseResult(result);

    expect(data.documents[0].name).toBe("Brief");
    expect(data.documents[0].filename).toBe("brief.docx");
  });

  it("includes next_page_token in response when API returns one", async () => {
    vi.mocked(mycaseGet).mockResolvedValue({ data: [], next_page_token: "cursor-xyz" });

    const result = await mock.call("list-documents", {});
    const data = parseResult(result);

    expect(data.next_page_token).toBe("cursor-xyz");
  });

  it("includes total from Item-Count header when present", async () => {
    vi.mocked(mycaseGet).mockResolvedValue({ data: [], total: 42 });

    const result = await mock.call("list-documents", {});
    const data = parseResult(result);

    expect(data.total).toBe(42);
  });

  it("returns isError on API failure", async () => {
    vi.mocked(mycaseGet).mockRejectedValue(new Error("Network error"));

    const result = await mock.call("list-documents", {});

    expect(result.isError).toBe(true);
  });
});

describe("get-document-url", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerDocumentTools(mock.server);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
  });

  it("returns download_url from document", async () => {
    vi.mocked(mycaseGet).mockResolvedValue({
      data: { document: { id: 7, name: "brief.pdf", download_url: "https://storage.example.com/brief.pdf" } },
    });

    const result = await mock.call("get-document-url", { document_id: "7" });
    const data = parseResult(result);

    expect(data.download_url).toBe("https://storage.example.com/brief.pdf");
    expect(mycaseGet).toHaveBeenCalledWith("/documents/7");
  });

  it("falls back to url field when download_url absent", async () => {
    vi.mocked(mycaseGet).mockResolvedValue({
      data: { document: { id: 8, url: "https://storage.example.com/doc.pdf" } },
    });

    const result = await mock.call("get-document-url", { document_id: "8" });
    const data = parseResult(result);

    expect(data.download_url).toBe("https://storage.example.com/doc.pdf");
  });

  it("returns error object on 404 without isError flag", async () => {
    vi.mocked(mycaseGet).mockRejectedValue(new MyCaseApiError(404, "Not found: /documents/999"));

    const result = await mock.call("get-document-url", { document_id: "999" });
    const data = parseResult(result);

    expect(data.error).toContain("999");
    expect(result.isError).toBeUndefined();
  });

  it("returns isError on non-404 failure", async () => {
    vi.mocked(mycaseGet).mockRejectedValue(new MyCaseApiError(500, "Server error"));

    const result = await mock.call("get-document-url", { document_id: "1" });

    expect(result.isError).toBe(true);
  });
});
