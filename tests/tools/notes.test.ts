import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { registerNoteTools, listNotesSchema, createNoteSchema, updateNoteSchema } from "../../src/tools/notes.js";
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
import { auditLog } from "../../src/audit/logger.js";

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe("list-notes schema validation", () => {
  const schema = z.object(listNotesSchema);

  it("accepts valid input with case_id", () => {
    expect(schema.safeParse({ case_id: 1 }).success).toBe(true);
  });

  it("accepts valid input with client_id", () => {
    expect(schema.safeParse({ client_id: 1 }).success).toBe(true);
  });

  it("rejects zero case_id", () => {
    expect(schema.safeParse({ case_id: 0 }).success).toBe(false);
  });

  it("rejects negative client_id", () => {
    expect(schema.safeParse({ client_id: -1 }).success).toBe(false);
  });

  it("rejects non-integer case_id", () => {
    expect(schema.safeParse({ case_id: 1.5 }).success).toBe(false);
  });

  it("accepts page_size within bounds", () => {
    expect(schema.safeParse({ case_id: 1, page_size: 50 }).success).toBe(true);
  });

  it("rejects page_size above max", () => {
    expect(schema.safeParse({ case_id: 1, page_size: 101 }).success).toBe(false);
  });
});

describe("create-note schema validation", () => {
  const schema = z.object(createNoteSchema);

  it("accepts valid input with case_id", () => {
    expect(schema.safeParse({ subject: "Meeting summary", note: "Discussed settlement.", case_id: 1 }).success).toBe(true);
  });

  it("accepts valid input with client_id", () => {
    expect(schema.safeParse({ subject: "S", note: "N", client_id: 1 }).success).toBe(true);
  });

  it("accepts valid input with company_id", () => {
    expect(schema.safeParse({ subject: "S", note: "N", company_id: 1 }).success).toBe(true);
  });

  it("rejects empty subject", () => {
    expect(schema.safeParse({ subject: "", note: "Content", case_id: 1 }).success).toBe(false);
  });

  it("rejects missing subject", () => {
    expect(schema.safeParse({ note: "Content", case_id: 1 }).success).toBe(false);
  });

  it("rejects empty note", () => {
    expect(schema.safeParse({ subject: "Subject", note: "", case_id: 1 }).success).toBe(false);
  });

  it("rejects missing note", () => {
    expect(schema.safeParse({ subject: "Subject", case_id: 1 }).success).toBe(false);
  });

  it("rejects invalid date format", () => {
    expect(schema.safeParse({ subject: "S", note: "N", case_id: 1, date: "01/15/2025" }).success).toBe(false);
  });

  it("rejects date with wrong separator", () => {
    expect(schema.safeParse({ subject: "S", note: "N", case_id: 1, date: "2025.01.15" }).success).toBe(false);
  });

  it("accepts valid date", () => {
    expect(schema.safeParse({ subject: "S", note: "N", case_id: 1, date: "2025-01-15" }).success).toBe(true);
  });

  it("rejects zero case_id", () => {
    expect(schema.safeParse({ subject: "S", note: "N", case_id: 0 }).success).toBe(false);
  });

  it("rejects negative case_id", () => {
    expect(schema.safeParse({ subject: "S", note: "N", case_id: -1 }).success).toBe(false);
  });

  it("rejects non-integer case_id", () => {
    expect(schema.safeParse({ subject: "S", note: "N", case_id: 1.5 }).success).toBe(false);
  });
});

describe("update-note schema validation", () => {
  const schema = z.object(updateNoteSchema);

  it("accepts valid input", () => {
    expect(schema.safeParse({ id: 1, subject: "S", note: "N", date: "2025-01-15" }).success).toBe(true);
  });

  it("rejects missing id", () => {
    expect(schema.safeParse({ subject: "S", note: "N", date: "2025-01-15" }).success).toBe(false);
  });

  it("rejects empty subject", () => {
    expect(schema.safeParse({ id: 1, subject: "", note: "N", date: "2025-01-15" }).success).toBe(false);
  });

  it("rejects empty note", () => {
    expect(schema.safeParse({ id: 1, subject: "S", note: "", date: "2025-01-15" }).success).toBe(false);
  });

  it("rejects missing date", () => {
    expect(schema.safeParse({ id: 1, subject: "S", note: "N" }).success).toBe(false);
  });

  it("rejects invalid date format", () => {
    expect(schema.safeParse({ id: 1, subject: "S", note: "N", date: "15-01-2025" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// list-notes
// ---------------------------------------------------------------------------

describe("list-notes", () => {
  let mock: ReturnType<typeof createMockServer>;

  const NOTES = [
    { id: 1, subject: "Intake", note: "Initial consult." },
    { id: 2, subject: "Follow-up", note: "Sent docs." },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerNoteTools(mock.server);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
    vi.mocked(mycaseGet).mockResolvedValue(NOTES);
  });

  it("fetches from /cases/{id}/notes when case_id is provided", async () => {
    await mock.call("list-notes", { case_id: 100 });

    expect(mycaseGet).toHaveBeenCalledWith("/cases/100/notes", expect.anything());
  });

  it("fetches from /clients/{id}/notes when client_id is provided", async () => {
    await mock.call("list-notes", { client_id: 200 });

    expect(mycaseGet).toHaveBeenCalledWith("/clients/200/notes", expect.anything());
  });

  it("returns notes array", async () => {
    const result = await mock.call("list-notes", { case_id: 100 });
    const data = parseResult(result);

    expect(data.notes).toHaveLength(2);
    expect(data.notes[0].id).toBe(1);
  });

  it("returns empty array when API returns non-array", async () => {
    vi.mocked(mycaseGet).mockResolvedValue({});

    const data = parseResult(await mock.call("list-notes", { case_id: 1 }));

    expect(data.notes).toEqual([]);
  });

  it("passes page_size and page_token to API", async () => {
    await mock.call("list-notes", { case_id: 100, page_size: 50, page_token: "tok" });

    expect(mycaseGet).toHaveBeenCalledWith("/cases/100/notes", expect.objectContaining({
      page_size: 50,
      page_token: "tok",
    }));
  });

  it("returns mutex error when neither id is provided", async () => {
    const result = await mock.call("list-notes", {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/exactly one of/);
  });

  it("returns mutex error when both case_id and client_id are provided", async () => {
    const result = await mock.call("list-notes", { case_id: 1, client_id: 2 });

    expect(result.isError).toBe(true);
  });

  it("does not call API on mutex error", async () => {
    await mock.call("list-notes", {});

    expect(mycaseGet).not.toHaveBeenCalled();
  });

  it("audit logs mutex error", async () => {
    await mock.call("list-notes", {});

    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({
      tool: "list-notes",
      outcome: "error",
    }));
  });

  it("audit logs success with case_id as string", async () => {
    await mock.call("list-notes", { case_id: 100 });

    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({
      tool: "list-notes",
      outcome: "success",
      case_id: "100",
      result_count: 2,
    }));
  });

  it("audit logs success with case_id undefined for client notes", async () => {
    await mock.call("list-notes", { client_id: 200 });

    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({
      tool: "list-notes",
      outcome: "success",
      case_id: undefined,
    }));
  });

  it("returns isError on API failure", async () => {
    vi.mocked(mycaseGet).mockRejectedValue(new Error("Network error"));

    const result = await mock.call("list-notes", { case_id: 100 });

    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// get-note
// ---------------------------------------------------------------------------

describe("get-note", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerNoteTools(mock.server);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
  });

  it("fetches from /notes/{id}", async () => {
    vi.mocked(mycaseGet).mockResolvedValue({ id: 42, subject: "Hearing prep", note: "Review exhibits." });

    await mock.call("get-note", { id: 42 });

    expect(mycaseGet).toHaveBeenCalledWith("/notes/42");
  });

  it("returns the note object", async () => {
    const NOTE = { id: 42, subject: "Hearing prep", note: "Review exhibits.", archived: false };
    vi.mocked(mycaseGet).mockResolvedValue(NOTE);

    const result = await mock.call("get-note", { id: 42 });

    expect(JSON.parse(result.content[0].text)).toMatchObject(NOTE);
  });

  it("returns isError on API failure", async () => {
    vi.mocked(mycaseGet).mockRejectedValue(new Error("Not found"));

    const result = await mock.call("get-note", { id: 99 });

    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// create-note
// ---------------------------------------------------------------------------

describe("create-note", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerNoteTools(mock.server);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
  });

  it("posts to /cases/{id}/notes when case_id is provided", async () => {
    vi.mocked(mycasePost).mockResolvedValue({ id: 55, subject: "Meeting summary" });

    await mock.call("create-note", { subject: "Meeting summary", note: "Discussed settlement.", case_id: 100 });

    expect(mycasePost).toHaveBeenCalledWith("/cases/100/notes", expect.objectContaining({
      subject: "Meeting summary",
      note: "Discussed settlement.",
    }));
  });

  it("posts to /clients/{id}/notes when client_id is provided", async () => {
    vi.mocked(mycasePost).mockResolvedValue({ id: 56, subject: "Client note" });

    await mock.call("create-note", { subject: "Client note", note: "Intake notes.", client_id: 200 });

    expect(mycasePost).toHaveBeenCalledWith("/clients/200/notes", expect.anything());
  });

  it("posts to /companies/{id}/notes when company_id is provided", async () => {
    vi.mocked(mycasePost).mockResolvedValue({ id: 57, subject: "Company note" });

    await mock.call("create-note", { subject: "Company note", note: "Corp notes.", company_id: 300 });

    expect(mycasePost).toHaveBeenCalledWith("/companies/300/notes", expect.anything());
  });

  it("sends note field (not body) in request body", async () => {
    vi.mocked(mycasePost).mockResolvedValue({ id: 58, subject: "Note" });

    await mock.call("create-note", { subject: "Note", note: "Narrative text.", case_id: 1 });

    const body = vi.mocked(mycasePost).mock.calls[0][1] as Record<string, unknown>;
    expect(body["note"]).toBe("Narrative text.");
    expect(body["body"]).toBeUndefined();
  });

  it("returns success with id and subject", async () => {
    vi.mocked(mycasePost).mockResolvedValue({ id: 59, subject: "Meeting summary" });

    const result = await mock.call("create-note", { subject: "Meeting summary", note: "Details.", case_id: 100 });
    const data = parseResult(result);

    expect(data.success).toBe(true);
    expect(data.id).toBe(59);
    expect(data.subject).toBe("Meeting summary");
  });

  it("falls back to subject arg when API omits subject in response", async () => {
    vi.mocked(mycasePost).mockResolvedValue({ id: 60 });

    const result = await mock.call("create-note", { subject: "Fallback subject", note: "Content.", case_id: 1 });

    expect(parseResult(result).subject).toBe("Fallback subject");
  });

  it("uses provided date in request body", async () => {
    vi.mocked(mycasePost).mockResolvedValue({ id: 61, subject: "Note" });

    await mock.call("create-note", { subject: "Note", note: "Content.", case_id: 1, date: "2025-03-15" });

    const body = vi.mocked(mycasePost).mock.calls[0][1] as Record<string, unknown>;
    expect(body["date"]).toBe("2025-03-15");
  });

  it("defaults date to today when not provided", async () => {
    vi.mocked(mycasePost).mockResolvedValue({ id: 62, subject: "Note" });

    await mock.call("create-note", { subject: "Note", note: "Content.", case_id: 1 });

    const body = vi.mocked(mycasePost).mock.calls[0][1] as Record<string, unknown>;
    expect(body["date"]).toBe(new Date().toISOString().slice(0, 10));
  });

  it("returns mutex error when no resource id is provided", async () => {
    const result = await mock.call("create-note", { subject: "Note", note: "Content." });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/exactly one of/);
  });

  it("returns mutex error when two resource ids are provided", async () => {
    const result = await mock.call("create-note", { subject: "Note", note: "Content.", case_id: 1, client_id: 2 });

    expect(result.isError).toBe(true);
  });

  it("does not call API on mutex error", async () => {
    await mock.call("create-note", { subject: "Note", note: "Content." });

    expect(mycasePost).not.toHaveBeenCalled();
  });

  it("audit logs mutex error", async () => {
    await mock.call("create-note", { subject: "Note", note: "Content." });

    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({
      tool: "create-note",
      outcome: "error",
    }));
  });

  it("audit logs success with case_id as string", async () => {
    vi.mocked(mycasePost).mockResolvedValue({ id: 63, subject: "Note" });

    await mock.call("create-note", { subject: "Note", note: "Content.", case_id: 100 });

    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({
      tool: "create-note",
      outcome: "success",
      case_id: "100",
      result_count: 1,
    }));
  });

  it("audit logs success with case_id undefined for client notes", async () => {
    vi.mocked(mycasePost).mockResolvedValue({ id: 64, subject: "Note" });

    await mock.call("create-note", { subject: "Note", note: "Content.", client_id: 200 });

    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({
      tool: "create-note",
      outcome: "success",
      case_id: undefined,
    }));
  });

  it("audit logs error with case_id", async () => {
    vi.mocked(mycasePost).mockRejectedValue(new Error("Server error"));

    await mock.call("create-note", { subject: "Note", note: "Content.", case_id: 100 });

    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({
      tool: "create-note",
      outcome: "error",
      case_id: "100",
    }));
  });

  it("does not include note body in audit log args", async () => {
    vi.mocked(mycasePost).mockResolvedValue({ id: 65, subject: "Note" });

    await mock.call("create-note", { subject: "Note", note: "Privileged content.", case_id: 1 });

    const logged = vi.mocked(auditLog).mock.calls[0][0];
    expect((logged.args as Record<string, unknown>)["note"]).toBeUndefined();
  });

  it("returns isError on API failure", async () => {
    vi.mocked(mycasePost).mockRejectedValue(new Error("Bad request"));

    const result = await mock.call("create-note", { subject: "Note", note: "Content.", case_id: 1 });

    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// update-note
// ---------------------------------------------------------------------------

describe("update-note", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerNoteTools(mock.server);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
  });

  it("puts to /notes/{id}", async () => {
    vi.mocked(mycasePut).mockResolvedValue(undefined);

    await mock.call("update-note", { id: 42, subject: "Updated", note: "New body.", date: "2025-06-01" });

    expect(mycasePut).toHaveBeenCalledWith("/notes/42", expect.objectContaining({
      subject: "Updated",
      note: "New body.",
      date: "2025-06-01",
    }));
  });

  it("returns success", async () => {
    vi.mocked(mycasePut).mockResolvedValue(undefined);

    const result = await mock.call("update-note", { id: 42, subject: "S", note: "N", date: "2025-06-01" });

    expect(parseResult(result).success).toBe(true);
  });

  it("audit logs success", async () => {
    vi.mocked(mycasePut).mockResolvedValue(undefined);

    await mock.call("update-note", { id: 42, subject: "S", note: "N", date: "2025-06-01" });

    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({
      tool: "update-note",
      outcome: "success",
    }));
  });

  it("does not include note body in audit log args", async () => {
    vi.mocked(mycasePut).mockResolvedValue(undefined);

    await mock.call("update-note", { id: 42, subject: "S", note: "Privileged.", date: "2025-06-01" });

    const logged = vi.mocked(auditLog).mock.calls[0][0];
    expect((logged.args as Record<string, unknown>)["note"]).toBeUndefined();
  });

  it("returns isError on API failure", async () => {
    vi.mocked(mycasePut).mockRejectedValue(new Error("Forbidden"));

    const result = await mock.call("update-note", { id: 42, subject: "S", note: "N", date: "2025-06-01" });

    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// delete-note
// ---------------------------------------------------------------------------

describe("delete-note", () => {
  let mock: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockServer();
    registerNoteTools(mock.server);
    vi.mocked(loadTokens).mockResolvedValue(MOCK_TOKENS);
  });

  it("deletes /notes/{id}", async () => {
    vi.mocked(mycaseDelete).mockResolvedValue(undefined);

    await mock.call("delete-note", { id: 42 });

    expect(mycaseDelete).toHaveBeenCalledWith("/notes/42");
  });

  it("returns success", async () => {
    vi.mocked(mycaseDelete).mockResolvedValue(undefined);

    const result = await mock.call("delete-note", { id: 42 });

    expect(parseResult(result).success).toBe(true);
  });

  it("audit logs success", async () => {
    vi.mocked(mycaseDelete).mockResolvedValue(undefined);

    await mock.call("delete-note", { id: 42 });

    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({
      tool: "delete-note",
      outcome: "success",
    }));
  });

  it("returns isError on API failure", async () => {
    vi.mocked(mycaseDelete).mockRejectedValue(new Error("Not found"));

    const result = await mock.call("delete-note", { id: 99 });

    expect(result.isError).toBe(true);
  });
});
