import fs from "fs/promises";
import path from "path";
import os from "os";

const LOG_DIR = path.join(os.homedir(), ".oktopeak-mycase");
const LOG_FILE = path.join(LOG_DIR, "audit.log");
const MAX_LOG_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_GENERATIONS = 5;

const REDACTED_KEYS = new Set([
  "access_token",
  "refresh_token",
  "client_secret",
  "password",
  "encryption_key",
  "ENCRYPTION_KEY",
]);

function redact(obj: unknown, depth = 0): unknown {
  if (depth > 10 || obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    out[k] = REDACTED_KEYS.has(k) ? "[REDACTED]" : redact(v, depth + 1);
  }
  return out;
}

async function rotateIfNeeded(): Promise<void> {
  try {
    const stat = await fs.stat(LOG_FILE).catch(() => null);
    if (!stat || stat.size < MAX_LOG_BYTES) return;

    // Shift existing backup generations: .5 deleted, .4→.5, ..., .1→.2, current→.1
    for (let i = MAX_GENERATIONS; i >= 1; i--) {
      const from = i === 1 ? LOG_FILE : `${LOG_FILE}.${i - 1}`;
      const to = `${LOG_FILE}.${i}`;
      await fs.rename(from, to).catch(() => {
        // ignore if source doesn't exist
      });
    }
  } catch {
    // rotation failure is non-fatal
  }
}

export interface AuditEntry {
  tool: string;
  args: Record<string, unknown>;
  outcome: "success" | "error";
  error?: string;
  firm_uuid?: string;
  case_id?: string;
  result_count?: number;
}

export async function auditLog(entry: AuditEntry): Promise<void> {
  try {
    await fs.mkdir(LOG_DIR, { recursive: true, mode: 0o700 });
    await rotateIfNeeded();
    const line =
      JSON.stringify({
        timestamp: new Date().toISOString(),
        ...entry,
        args: redact(entry.args),
      }) + "\n";
    await fs.appendFile(LOG_FILE, line, { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    console.error(
      `[audit] WARNING: Failed to write audit log: ${(err as Error).message}`
    );
  }
}
