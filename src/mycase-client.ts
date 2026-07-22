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

interface RawResponse {
  body: unknown;
  res: Response;
}

/**
 * Extracts the next-page cursor from the RFC 5988 Link header MyCase's
 * cursor-based pagination uses (rel="next"), e.g.:
 *   <https://.../v1/tasks?page_token=abc123>; rel="next"
 * There is no envelope/meta object in list responses — this header is the
 * only signal that more pages exist.
 */
function extractNextPageToken(res: Response): string | undefined {
  const link = res.headers.get("Link") ?? res.headers.get("link");
  if (!link) return undefined;
  for (const entry of link.split(",")) {
    const match = entry.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (!match) continue;
    try {
      return new URL(match[1]).searchParams.get("page_token") ?? undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

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
  if (res.status === 204) return { body: null, res };

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new MyCaseApiError(res.status, parseErrorMessage(text));
  }

  return { body: await res.json(), res };
}

export async function mycaseGet(
  path: string,
  params?: Record<string, string | number | boolean | undefined>
): Promise<unknown> {
  const { body } = await request("GET", path, params);
  return body;
}

/**
 * Like mycaseGet, but also surfaces the pagination cursor from the Link
 * header so callers can page a list endpoint to completion instead of
 * silently returning only the first page.
 */
export async function mycaseGetPage(
  path: string,
  params?: Record<string, string | number | boolean | undefined>
): Promise<{ data: unknown; nextPageToken?: string }> {
  const { body, res } = await request("GET", path, params);
  return { data: body, nextPageToken: extractNextPageToken(res) };
}

export async function mycasePost(path: string, body: unknown): Promise<unknown> {
  const { body: responseBody } = await request("POST", path, undefined, body);
  return responseBody;
}
