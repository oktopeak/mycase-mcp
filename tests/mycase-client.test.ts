import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/auth/oauth.js", () => ({
  getValidAccessToken: vi.fn(async () => "test-token"),
  refreshAccessToken: vi.fn(),
}));
vi.mock("../src/utils/rate-limiter.js", () => ({ enforceRateLimit: vi.fn() }));

import { parseNextPageToken, mycaseGetAll, MAX_PAGE_SIZE } from "../src/mycase-client.js";

/**
 * These tests exercise the real Link-header contract MyCase publishes:
 *
 *   - list bodies are BARE JSON ARRAYS (no envelope, no "meta" object)
 *   - the next page arrives as a Link header, rel="next", carrying page_token
 *   - page_size may go up to 1000
 *
 * https://mycaseapi.stoplight.io/docs/mycase-api-documentation/trif6mng3n2lz-cursor-based-pagination
 *
 * The previous suite mocked a { tasks, meta: { next_page_token } } envelope that the
 * API never returns. It passed while the connector silently returned page one only.
 * Anything mocked here must match the documented wire format, not a convenient shape.
 */

/** Build a fetch Response the way MyCase actually replies to a list call. */
function listResponse(items: unknown[], nextUrl?: string) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (nextUrl) headers.set("Link", `<${nextUrl}>; rel="next"`);
  return {
    ok: true,
    status: 200,
    headers,
    json: async () => items,
    text: async () => JSON.stringify(items),
  } as unknown as Response;
}

describe("parseNextPageToken", () => {
  it("extracts page_token from a documented Link header", () => {
    const header = '<http://example.com/v1/cases?page_size=40&page_token=abc>; rel="next"';
    expect(parseNextPageToken(header)).toBe("abc");
  });

  it("returns undefined on the last page (no Link header)", () => {
    expect(parseNextPageToken(null)).toBeUndefined();
  });

  it("ignores links that are not rel=next", () => {
    const header = '<http://example.com/v1/cases?page_token=prev>; rel="prev"';
    expect(parseNextPageToken(header)).toBeUndefined();
  });

  it("picks rel=next out of a multi-link header", () => {
    const header =
      '<http://example.com/v1/cases?page_token=p>; rel="prev", ' +
      '<http://example.com/v1/cases?page_token=n>; rel="next"';
    expect(parseNextPageToken(header)).toBe("n");
  });

  it("tolerates unquoted rel values", () => {
    expect(parseNextPageToken("<http://x.com/v1/t?page_token=z>; rel=next")).toBe("z");
  });

  it("returns undefined rather than looping when the Link URL is unparseable", () => {
    expect(parseNextPageToken('<not a url>; rel="next"')).toBeUndefined();
  });
});

describe("mycaseGetAll", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("follows Link headers across every page and concatenates bare arrays", async () => {
    fetchMock
      .mockResolvedValueOnce(listResponse([{ id: 1 }, { id: 2 }], "https://api/v1/tasks?page_token=p2"))
      .mockResolvedValueOnce(listResponse([{ id: 3 }], "https://api/v1/tasks?page_token=p3"))
      .mockResolvedValueOnce(listResponse([{ id: 4 }]));

    const result = await mycaseGetAll("/tasks");

    expect(result.items).toHaveLength(4);
    expect(result.complete).toBe(true);
    expect(result.pages).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("sends the cursor from the previous response on each follow-up call", async () => {
    fetchMock
      .mockResolvedValueOnce(listResponse([{ id: 1 }], "https://api/v1/tasks?page_token=cursor-abc"))
      .mockResolvedValueOnce(listResponse([{ id: 2 }]));

    await mycaseGetAll("/tasks");

    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get("page_token")).toBeNull();
    expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get("page_token")).toBe("cursor-abc");
  });

  it("requests the documented maximum page size", async () => {
    fetchMock.mockResolvedValueOnce(listResponse([]));
    await mycaseGetAll("/tasks");
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get("page_size")).toBe(String(MAX_PAGE_SIZE));
  });

  it("forwards caller filters on every page", async () => {
    fetchMock
      .mockResolvedValueOnce(listResponse([{ id: 1 }], "https://api/v1/tasks?page_token=p2"))
      .mockResolvedValueOnce(listResponse([{ id: 2 }]));

    await mycaseGetAll("/tasks", { "filter[updated_after]": "2025-01-01" });

    for (const call of fetchMock.mock.calls) {
      expect(new URL(call[0]).searchParams.get("filter[updated_after]")).toBe("2025-01-01");
    }
  });

  it("reports complete on a single-page result", async () => {
    fetchMock.mockResolvedValueOnce(listResponse([{ id: 1 }]));
    const result = await mycaseGetAll("/tasks");
    expect(result).toMatchObject({ complete: true, pages: 1 });
  });

  it("throws rather than reporting an empty list when the body is not an array", async () => {
    // Guard against reintroducing the { tasks, meta } assumption that caused the bug.
    // An unexpected shape must surface as an error, never as "no results".
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ tasks: [{ id: 1 }], meta: { next_page_token: "x" } }),
    } as unknown as Response);

    await expect(mycaseGetAll("/tasks")).rejects.toThrow(/Expected a JSON array/);
  });
});
