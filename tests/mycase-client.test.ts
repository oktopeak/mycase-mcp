import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/auth/oauth.js", () => ({
  getValidAccessToken: vi.fn().mockResolvedValue("test-access-token"),
  refreshAccessToken: vi.fn().mockResolvedValue({ access_token: "refreshed-token" }),
}));
vi.mock("../src/utils/rate-limiter.js", () => ({
  enforceRateLimit: vi.fn().mockResolvedValue(undefined),
}));

import { mycaseGet, mycaseGetPage, MyCaseApiError } from "../src/mycase-client.js";
import { refreshAccessToken } from "../src/auth/oauth.js";

/**
 * Builds a fetch Response shaped like a real MyCase list-endpoint response
 * per the documented cursor-based pagination contract: a bare JSON array
 * body, with the next-page cursor carried in a Link response header
 * (rel="next") rather than any body envelope/meta object.
 * https://mycaseapi.stoplight.io/docs/mycase-api-documentation/trif6mng3n2lz-cursor-based-pagination
 */
function mockMyCaseListResponse(items: unknown[], opts: { nextPageToken?: string } = {}) {
  const headers = new Headers();
  if (opts.nextPageToken) {
    headers.set(
      "Link",
      `<https://external-integrations.mycase.com/v1/tasks?page_token=${opts.nextPageToken}&page_size=100>; rel="next"`
    );
  }
  return new Response(JSON.stringify(items), { status: 200, headers });
}

describe("mycase-client — pagination headers", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(global, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("mycaseGetPage extracts the next-page cursor from a real Link header, not a body envelope", async () => {
    fetchSpy.mockResolvedValue(
      mockMyCaseListResponse([{ id: 1 }, { id: 2 }], { nextPageToken: "cursor-abc123" })
    );

    const { data, nextPageToken } = await mycaseGetPage("/tasks", { page_size: 100 });

    expect(data).toEqual([{ id: 1 }, { id: 2 }]);
    expect(nextPageToken).toBe("cursor-abc123");
  });

  it("mycaseGetPage returns undefined nextPageToken on the last page (no Link header)", async () => {
    fetchSpy.mockResolvedValue(mockMyCaseListResponse([{ id: 3 }]));

    const { data, nextPageToken } = await mycaseGetPage("/tasks", {});

    expect(data).toEqual([{ id: 3 }]);
    expect(nextPageToken).toBeUndefined();
  });

  it("mycaseGetPage handles a multi-link Link header (rel=\"next\" mixed with other rels)", async () => {
    const headers = new Headers();
    headers.set(
      "Link",
      '<https://external-integrations.mycase.com/v1/tasks?page_token=prev-tok>; rel="prev", <https://external-integrations.mycase.com/v1/tasks?page_token=next-tok>; rel="next"'
    );
    fetchSpy.mockResolvedValue(new Response(JSON.stringify([{ id: 1 }]), { status: 200, headers }));

    const { nextPageToken } = await mycaseGetPage("/tasks", {});

    expect(nextPageToken).toBe("next-tok");
  });

  it("mycaseGet (non-paginated callers) still returns the bare body, unaffected by header plumbing", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ id: 42, name: "Smith v Jones" }), { status: 200 }));

    const result = await mycaseGet("/cases/42");

    expect(result).toEqual({ id: 42, name: "Smith v Jones" });
  });

  it("surfaces a rejected page_token as a thrown error rather than an empty page", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_page_token", message: "page_token has expired" }), { status: 400 })
    );

    await expect(mycaseGetPage("/tasks", { page_token: "stale-cursor" })).rejects.toThrow(MyCaseApiError);
  });

  it("retries once on 401 by refreshing the token, then surfaces the retried page's data", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(mockMyCaseListResponse([{ id: 1 }]));

    const { data } = await mycaseGetPage("/tasks", {});

    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(data).toEqual([{ id: 1 }]);
  });
});
