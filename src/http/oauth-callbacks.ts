export interface PendingOAuthState {
  userId: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

const pending = new Map<string, PendingOAuthState>();

export function registerPendingState(state: string, entry: PendingOAuthState): void {
  pending.set(state, entry);
  // Auto-expire after 10 minutes to prevent unbounded memory growth.
  setTimeout(() => pending.delete(state), 10 * 60 * 1000);
}

export function consumePendingState(state: string): PendingOAuthState | undefined {
  const entry = pending.get(state);
  if (entry) pending.delete(state);
  return entry;
}
