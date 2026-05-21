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

/** Parse the next-page cursor out of an RFC 5988 Link response header. */
export function parseLinkNextToken(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    if (part.includes('rel="next"')) {
      const urlMatch = part.match(/<([^>]+)>/);
      if (urlMatch) {
        try {
          return new URL(urlMatch[1]).searchParams.get("page_token");
        } catch {
          // malformed URL — skip
        }
      }
    }
  }
  return null;
}

interface RequestResult {
  body: unknown;
  linkHeader: string | null;
}

async function request(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
  body?: unknown,
  isRetry = false,
  retryCount = 0
): Promise<RequestResult> {
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
  if (res.status === 204) return { body: null, linkHeader: null };

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new MyCaseApiError(res.status, parseErrorMessage(text));
  }

  return { body: await res.json() as unknown, linkHeader: res.headers.get("Link") };
}

/** Body-only GET — backward-compatible with all existing tools. */
export async function mycaseGet(
  path: string,
  params?: Record<string, string | number | boolean | undefined>
): Promise<unknown> {
  const { body } = await request("GET", path, params);
  return body;
}

/** Paginated GET — returns the body plus the next-page cursor parsed from the Link header. */
export interface PagedResult {
  body: unknown;
  nextPageToken: string | null;
}

export async function mycaseGetPaged(
  path: string,
  params?: Record<string, string | number | boolean | undefined>
): Promise<PagedResult> {
  const { body, linkHeader } = await request("GET", path, params);
  return { body, nextPageToken: parseLinkNextToken(linkHeader) };
}

export async function mycasePost(path: string, body: unknown): Promise<unknown> {
  const { body: responseBody } = await request("POST", path, undefined, body);
  return responseBody;
}
