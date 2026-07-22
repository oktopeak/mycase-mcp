import { getValidAccessToken, refreshAccessToken } from "./auth/oauth.js";
import { enforceRateLimit } from "./utils/rate-limiter.js";

export class MyCaseApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "MyCaseApiError";
  }
}

function getApiBase(): string {
  return process.env.MYCASE_API_BASE ?? "https://external-integrations.mycase.com/v1";
}

function parseErrorMessage(body: string): string {
  try {
    const j = JSON.parse(body) as unknown;
    if (typeof j === "object" && j !== null) {
      const o = j as Record<string, unknown>;
      if (typeof o["message"] === "string") return o["message"];
      if (typeof o["error"] === "string") return o["error"];
      if (Array.isArray(o["errors"])) {
        return (o["errors"] as unknown[])
          .map((e) => (typeof e === "object" && e !== null ? JSON.stringify(e) : String(e)))
          .join(", ");
      }
      const inner = o["error"];
      if (typeof inner === "object" && inner !== null) {
        const msg = (inner as Record<string, unknown>)["message"];
        if (typeof msg === "string") return msg;
      }
    }
  } catch {
    // fall through to raw body
  }
  return body.slice(0, 200) || "Unknown error";
}

/**
 * MyCase returns the next page as a Link header (RFC 5988), not as a field in the
 * response body — list bodies are bare JSON arrays. See
 * https://mycaseapi.stoplight.io/docs/mycase-api-documentation/trif6mng3n2lz-cursor-based-pagination
 *
 *   Link: <https://.../v1/cases?page_size=40&page_token=abc>; rel="next"
 *
 * Returns the page_token from the rel="next" link, or undefined when this is the
 * last page. Cursors expire after 3 days.
 */
export function parseNextPageToken(linkHeader: string | null): string | undefined {
  if (!linkHeader) return undefined;

  for (const part of linkHeader.split(",")) {
    if (!/rel\s*=\s*"?next"?/i.test(part)) continue;
    const match = part.match(/<([^>]+)>/);
    if (!match) continue;
    try {
      const token = new URL(match[1]).searchParams.get("page_token");
      if (token) return token;
    } catch {
      // Unparseable URL in the Link header — treat as no next page rather than
      // guessing, so the caller reports an incomplete result instead of looping.
      return undefined;
    }
  }
  return undefined;
}

type RawResponse = { body: unknown; nextPageToken?: string };

async function request(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
  body?: unknown,
  isRetry = false,
  retryCount = 0
): Promise<RawResponse> {
  await enforceRateLimit();

  const token = await getValidAccessToken();
  const url = new URL(`${getApiBase()}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (body) headers["Content-Type"] = "application/json";

  const res = await fetch(url.toString(), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && !isRetry) {
    console.error("[mycase-client] 401 — refreshing token and retrying...");
    await refreshAccessToken();
    return request(method, path, params, body, true);
  }

  if (res.status === 429) {
    if (retryCount >= 5) throw new MyCaseApiError(429, "Rate limited after 5 retries — try again later");
    const retryAfter = res.headers.get("Retry-After");
    const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 2000;
    console.error(`[mycase-client] 429 rate limited — waiting ${waitMs}ms (attempt ${retryCount + 1}/5)`);
    await new Promise((r) => setTimeout(r, waitMs));
    return request(method, path, params, body, isRetry, retryCount + 1);
  }

  if (res.status === 404) throw new MyCaseApiError(404, `Not found: ${path}`);
  if (res.status === 204) return { body: null };

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new MyCaseApiError(res.status, parseErrorMessage(text));
  }

  return {
    body: await res.json(),
    nextPageToken: parseNextPageToken(res.headers.get("Link")),
  };
}

export async function mycaseGet(
  path: string,
  params?: Record<string, string | number | boolean | undefined>
): Promise<unknown> {
  return (await request("GET", path, params)).body;
}

/** Single page plus the cursor for the next one. Use mycaseGetAll unless you need manual control. */
export async function mycaseGetPage(
  path: string,
  params?: Record<string, string | number | boolean | undefined>
): Promise<{ items: unknown[]; nextPageToken?: string }> {
  const { body, nextPageToken } = await request("GET", path, params);
  if (!Array.isArray(body)) {
    // MyCase list endpoints return bare arrays. If that ever stops being true, fail
    // loudly: returning [] here would hand the caller an empty list that looks like
    // a real "no results", which is the failure this whole module exists to prevent.
    throw new MyCaseApiError(
      200,
      `Expected a JSON array from ${path} but got ${body === null ? "null" : typeof body}. ` +
        `The MyCase response format may have changed; refusing to report an empty list.`
    );
  }
  return { items: body, nextPageToken };
}

/** MyCase's documented maximum items per page. */
export const MAX_PAGE_SIZE = 1000;

/**
 * Safety bound so a server that keeps handing back cursors can't spin forever.
 * At MAX_PAGE_SIZE that is a million records; hitting it means something is wrong,
 * and the caller is told the result is incomplete rather than being handed a
 * truncated list that looks whole.
 */
const MAX_PAGES = 1000;

export type FetchAllResult<T> = {
  items: T[];
  /** False when the list is known to be missing records. Never report a partial list as complete. */
  complete: boolean;
  pages: number;
  /** Set only when complete === false. */
  incompleteReason?: string;
};

/**
 * Follow MyCase's Link-header cursors until the last page.
 *
 * Every list endpoint needs this: without it a caller receives page one and has no
 * way to tell a short list from a complete one. For deadline-bearing data that
 * ambiguity is the actual hazard, so the completeness flag travels with the result.
 */
export async function mycaseGetAll<T = unknown>(
  path: string,
  params?: Record<string, string | number | boolean | undefined>
): Promise<FetchAllResult<T>> {
  const items: T[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    const page = await mycaseGetPage(path, {
      ...params,
      page_size: MAX_PAGE_SIZE,
      ...(cursor ? { page_token: cursor } : {}),
    });
    items.push(...(page.items as T[]));
    cursor = page.nextPageToken;
    pages++;

    if (cursor && pages >= MAX_PAGES) {
      return {
        items,
        complete: false,
        pages,
        incompleteReason: `Stopped after ${MAX_PAGES} pages with more results still available.`,
      };
    }
  } while (cursor);

  return { items, complete: true, pages };
}

export async function mycasePost(path: string, body: unknown): Promise<unknown> {
  return (await request("POST", path, undefined, body)).body;
}
