import { AsyncLocalStorage } from "node:async_hooks";

interface RequestContext {
  userId: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Returns the user ID for the current async context.
 * Returns 'stdio' when running in stdio transport mode (no context set).
 */
export function getCurrentUserId(): string {
  return requestContext.getStore()?.userId ?? "stdio";
}

export function runWithUserId<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return requestContext.run({ userId }, fn);
}
