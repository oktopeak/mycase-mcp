import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerDocumentTools } from "../../src/tools/documents.js";
import { createMockServer, parseResult, MOCK_TOKENS } from "../helpers.js";

vi.mock("../../src/mycase-client.js", () => ({
  mycaseGet: vi.fn(),
  mycaseGetAll: vi.fn(),
  MyCaseApiError: class MyCaseApiError extends Error {
    constructor(public status: number, message: string) {
      super(message);
      this.name = "MyCaseApiError";
    }
  },
}));
vi.mock("../../src/auth/token-store.js", () => ({ loadTokens: vi.fn() }));
vi.mock("../../src/audit/logger.js", () => ({ auditLog: vi.fn() }));

import { mycaseGet, mycaseGetAll, MyCaseApiError } from "../../src/mycase-client.js";
import { loadTokens } from "../../src/auth/token-store.js";

describe("list-documents", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerDocumentTools(mock.server);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
  });

  it("reads the bare array MyCase returns, not a documents key", async () => {
    vi.mocked(mycaseGetAll).mockResolvedValue({
      items: [{ id: 1, name: "Contract.pdf", content_type: "application/pdf", size: 1024, case: { id: 42 } }],
      complete: true, pages: 1,
    });

    const data = parseResult(await mock.call("list-documents", {}));

    expect(data.documents).toHaveLength(1);
    expect(data.documents[0].name).toBe("Contract.pdf");
    expect(data.complete).toBe(true);
    expect(mycaseGetAll).toHaveBeenCalledWith("/documents");
  });

  it("filters to the requested case after fetching every page", async () => {
    vi.mocked(mycaseGetAll).mockResolvedValue({
      items: [{ id: 1, name: "a.pdf", case: { id: 42 } }, { id: 2, name: "b.pdf", case: { id: 7 } }, { id: 3, name: "c.pdf", case: { id: 42 } }],
      complete: true, pages: 3,
    });

    const data = parseResult(await mock.call("list-documents", { case_id: "42", limit: 200 }));

    expect(data.documents.map((d: any) => d.id)).toEqual([1, 3]);
    expect(data.matched).toBe(2);
  });

  it("says so when the limit cuts the matching documents short", async () => {
    vi.mocked(mycaseGetAll).mockResolvedValue({
      items: [{ id: 1, case: { id: 42 } }, { id: 2, case: { id: 42 } }, { id: 3, case: { id: 42 } }],
      complete: true, pages: 1,
    });

    const data = parseResult(await mock.call("list-documents", { case_id: "42", limit: 2 }));

    expect(data.count).toBe(2);
    expect(data.complete).toBe(false);
    expect(data.warning).toContain("Showing 2 of 3");
  });

  it("falls back to filename when name is absent", async () => {
    vi.mocked(mycaseGetAll).mockResolvedValue({ items: [{ id: 2, filename: "brief.docx" }], complete: true, pages: 1 });

    const data = parseResult(await mock.call("list-documents", {}));

    expect(data.documents[0].name).toBe("brief.docx");
  });

  it("returns isError on API failure", async () => {
    vi.mocked(mycaseGetAll).mockRejectedValue(new Error("Network error"));

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
      document: { id: 7, name: "brief.pdf", download_url: "https://storage.example.com/brief.pdf" },
    });

    const result = await mock.call("get-document-url", { document_id: "7" });
    const data = parseResult(result);

    expect(data.download_url).toBe("https://storage.example.com/brief.pdf");
    expect(mycaseGet).toHaveBeenCalledWith("/documents/7");
  });

  it("falls back to url field when download_url absent", async () => {
    vi.mocked(mycaseGet).mockResolvedValue({
      document: { id: 8, url: "https://storage.example.com/doc.pdf" },
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
