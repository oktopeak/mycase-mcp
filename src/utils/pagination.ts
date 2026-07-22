import { mycaseGetPage } from "../mycase-client.js";

// MyCase's documented maximum page size for cursor-based pagination.
export const MAX_PAGE_SIZE = 1000;

// Safety bound so a single tool call can never loop forever against a firm
// with an unbounded amount of data. At MAX_PAGE_SIZE this is 50,000 records.
const DEFAULT_MAX_PAGES = 50;

export interface PaginatedFetch<T> {
  items: T[];
  complete: boolean;
  next_page_token?: string;
  truncated_reason?: "page_limit_reached";
}

export interface FetchAllPagesOptions<T> {
  /** Resume pagination from this cursor instead of starting at page 1. */
  startCursor?: string;
  /** Override the safety bound on total pages fetched. */
  maxPages?: number;
  /**
   * MyCase list endpoints return a bare JSON array with no envelope. Some
   * endpoints have historically been observed (or guessed) to wrap results
   * in an object instead — this lets a caller fall back to reading a known
   * key so an unexpected envelope doesn't just silently produce zero items.
   */
  extractItems?: (data: unknown) => T[];
}

/**
 * Pages a MyCase list endpoint to completion by following the cursor in the
 * response's Link header (rel="next"), rather than returning only the first
 * page and letting the caller assume that's everything.
 *
 * Stops when there is no next-page cursor (complete: true) or when the
 * safety bound on page count is reached (complete: false) — the caller must
 * check `complete` and never treat a truncated result as an empty one.
 */
export async function fetchAllPages<T>(
  path: string,
  baseParams: Record<string, string | number | boolean | undefined>,
  options: FetchAllPagesOptions<T> = {}
): Promise<PaginatedFetch<T>> {
  const extractItems =
    options.extractItems ?? ((data: unknown) => (Array.isArray(data) ? (data as T[]) : []));
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;

  const items: T[] = [];
  let cursor = options.startCursor;
  let pagesFetched = 0;

  do {
    const params: Record<string, string | number | boolean | undefined> = { ...baseParams };
    if (cursor) params["page_token"] = cursor;

    const { data, nextPageToken } = await mycaseGetPage(path, params);
    items.push(...extractItems(data));

    cursor = nextPageToken;
    pagesFetched++;

    if (cursor && pagesFetched >= maxPages) {
      return { items, complete: false, next_page_token: cursor, truncated_reason: "page_limit_reached" };
    }
  } while (cursor);

  return { items, complete: true };
}
