// Rolling-window rate limiter: conservative 30 req/min per instructions.
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 30;
const timestamps: number[] = [];

export async function enforceRateLimit(): Promise<void> {
  const now = Date.now();
  while (timestamps.length > 0 && timestamps[0] < now - WINDOW_MS) {
    timestamps.shift();
  }
  if (timestamps.length >= MAX_REQUESTS) {
    const waitMs = WINDOW_MS - (now - timestamps[0]) + 50;
    console.error(`[rate-limiter] Approaching 30 req/min — waiting ${waitMs}ms`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  timestamps.push(Date.now());
}
