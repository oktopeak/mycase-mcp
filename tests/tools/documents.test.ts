import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerDocumentTools } from "../../src/tools/documents.js";
import { createMockServer, parseResult, MOCK_TOKENS } from "../helpers.js";

vi.mock("../../src/mycase-client.js", () => ({
  mycaseGet: vi.fn(),
  mycasePost: vi.fn(),
  s3Put: vi.fn(),
  MyCaseApiError: class MyCaseApiError extends Error {
    constructor(public status: number, message: string) {
      super(message);
      this.name = "MyCaseApiError";
    }
  },
}));
vi.mock("../../src/auth/token-store.js", () => ({ loadTokens: vi.fn() }));
vi.mock("../../src/audit/logger.js", () => ({ auditLog: vi.fn() }));
vi.mock("fs/promises", () => ({
  default: { readFile: vi.fn() },
}));

import { mycaseGet, mycasePost, s3Put, MyCaseApiError } from "../../src/mycase-client.js";
import { loadTokens } from "../../src/auth/token-store.js";
import fs from "fs/promises";

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
      documents: [{ id: 1, name: "Contract.pdf", content_type: "application/pdf", size: 1024 }],
    });

    const result = await mock.call("list-documents", {});
    const data = parseResult(result);

    expect(data.documents).toHaveLength(1);
    expect(data.documents[0].name).toBe("Contract.pdf");
  });

  it("passes case_id param when provided", async () => {
    vi.mocked(mycaseGet).mockResolvedValue({ documents: [] });

    await mock.call("list-documents", { case_id: "42" });

    expect(mycaseGet).toHaveBeenCalledWith("/documents", expect.objectContaining({ case_id: "42" }));
  });

  it("falls back to filename when name is absent", async () => {
    vi.mocked(mycaseGet).mockResolvedValue({
      documents: [{ id: 2, filename: "brief.docx" }],
    });

    const result = await mock.call("list-documents", {});
    const data = parseResult(result);

    expect(data.documents[0].name).toBe("brief.docx");
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

describe("upload-document", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerDocumentTools(mock.server);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
  });

  it("returns document id and name on successful upload", async () => {
    vi.mocked(fs.readFile).mockResolvedValue(Buffer.from("data") as never);
    vi.mocked(mycasePost).mockResolvedValue({
      id: 99, name: "contract.pdf",
      put_url: "https://s3.example.com/upload", put_headers: { "x-amz-acl": "private" },
    });
    vi.mocked(s3Put).mockResolvedValue(undefined);

    const result = await mock.call("upload-document", {
      file_path: "/home/user/docs/contract.pdf",
      case_id: "42",
    });
    const data = parseResult(result);

    expect(data.id).toBe(99);
    expect(data.name).toBe("contract.pdf");
    expect(result.isError).toBeUndefined();
  });

  it("returns isError when file does not exist", async () => {
    vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

    const result = await mock.call("upload-document", {
      file_path: "/home/user/docs/missing.pdf",
      case_id: "42",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("File not found");
  });

  it("returns isError when file exceeds 50 MB", async () => {
    vi.mocked(fs.readFile).mockResolvedValue({ byteLength: 51 * 1024 * 1024 } as never);

    const result = await mock.call("upload-document", {
      file_path: "/home/user/docs/huge.pdf",
      case_id: "42",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("50 MB limit");
  });

  it("returns isError when file_path is a sensitive file", async () => {
    const result = await mock.call("upload-document", {
      file_path: "/home/user/.env",
      case_id: "42",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("sensitive");
  });

  it("returns isError when API responds without a document ID or put_url", async () => {
    vi.mocked(fs.readFile).mockResolvedValue(Buffer.from("data") as never);
    vi.mocked(mycasePost).mockResolvedValue({});

    const result = await mock.call("upload-document", {
      file_path: "/home/user/docs/contract.pdf",
      case_id: "42",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("document ID or S3 upload URL");
  });

  it("returns isError when file_path is not absolute", async () => {
    const result = await mock.call("upload-document", {
      file_path: "relative/path/contract.pdf",
      case_id: "42",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("absolute");
  });

  it("sends custom display name as path in the MyCase POST body", async () => {
    vi.mocked(fs.readFile).mockResolvedValue(Buffer.from("data") as never);
    vi.mocked(mycasePost).mockResolvedValue({
      id: 5, name: "My Contract",
      put_url: "https://s3.example.com/upload", put_headers: {},
    });
    vi.mocked(s3Put).mockResolvedValue(undefined);

    await mock.call("upload-document", {
      file_path: "/home/user/docs/contract.pdf",
      case_id: "42",
      name: "My Contract",
    });

    expect(mycasePost).toHaveBeenCalledWith(
      "/cases/42/documents",
      expect.objectContaining({ path: "My Contract", filename: "contract.pdf" })
    );
  });

  it("PUTs file bytes to the S3 URL with the headers from MyCase", async () => {
    const fileBytes = Buffer.from("pdf-content");
    vi.mocked(fs.readFile).mockResolvedValue(fileBytes as never);
    vi.mocked(mycasePost).mockResolvedValue({
      id: 1, put_url: "https://s3.example.com/upload",
      put_headers: { "x-amz-acl": "private" },
    });
    vi.mocked(s3Put).mockResolvedValue(undefined);

    await mock.call("upload-document", {
      file_path: "/home/user/docs/doc.pdf",
      case_id: "42",
    });

    expect(s3Put).toHaveBeenCalledWith(
      "https://s3.example.com/upload",
      { "x-amz-acl": "private" },
      expect.any(Uint8Array)
    );
  });

  // --- file_content_base64 mode ---

  it("uploads successfully via file_content_base64 without touching the filesystem", async () => {
    vi.mocked(mycasePost).mockResolvedValue({
      id: 77, name: "Good Medical Practice 2024 (GMC)",
      put_url: "https://s3.example.com/upload", put_headers: {},
    });
    vi.mocked(s3Put).mockResolvedValue(undefined);

    const b64 = Buffer.from("pdf-bytes").toString("base64");
    const result = await mock.call("upload-document", {
      file_content_base64: b64,
      filename: "Good-Medical-Practice-2024.pdf",
      case_id: "46865216",
      name: "Good Medical Practice 2024 (GMC)",
    });
    const data = parseResult(result);

    expect(data.id).toBe(77);
    expect(data.name).toBe("Good Medical Practice 2024 (GMC)");
    expect(result.isError).toBeUndefined();
    // fs.readFile must never be called in this mode
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it("sends decoded bytes to S3 via file_content_base64", async () => {
    vi.mocked(mycasePost).mockResolvedValue({
      id: 2, put_url: "https://s3.example.com/upload", put_headers: {},
    });
    vi.mocked(s3Put).mockResolvedValue(undefined);

    const originalBytes = Buffer.from("fake-pdf-content");
    const result = await mock.call("upload-document", {
      file_content_base64: originalBytes.toString("base64"),
      filename: "report.pdf",
      case_id: "42",
    });

    expect(result.isError).toBeUndefined();
    // Verify the decoded bytes round-trip correctly.
    const [, , uploadedBytes] = vi.mocked(s3Put).mock.calls[0];
    expect(Buffer.from(uploadedBytes).toString()).toBe("fake-pdf-content");
  });

  it("returns isError when neither file_path nor file_content_base64 is provided", async () => {
    const result = await mock.call("upload-document", { case_id: "42" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("file_path or file_content_base64");
  });

  it("returns isError when both file_path and file_content_base64 are provided", async () => {
    const result = await mock.call("upload-document", {
      file_path: "/home/user/docs/contract.pdf",
      file_content_base64: Buffer.from("data").toString("base64"),
      filename: "contract.pdf",
      case_id: "42",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not both");
  });

  it("returns isError when file_content_base64 is provided without filename", async () => {
    const result = await mock.call("upload-document", {
      file_content_base64: Buffer.from("data").toString("base64"),
      case_id: "42",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("filename is required");
  });

  it("returns isError when filename via file_content_base64 is a sensitive file", async () => {
    const result = await mock.call("upload-document", {
      file_content_base64: Buffer.from("data").toString("base64"),
      filename: "id_rsa",
      case_id: "42",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("sensitive");
  });
});
