import fs from "fs/promises";
import path from "path";
import os from "os";

const LOG_DIR = path.join(os.homedir(), ".oktopeak-mycase");
const LOG_FILE = path.join(LOG_DIR, "audit.log");

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

export interface AuditEntry {
  tool: string;
  args: Record<string, unknown>;
  outcome: "success" | "error";
  error?: string;
  user_id?: string;
  case_id?: string;
  result_count?: number;
}

export async function auditLog(entry: AuditEntry): Promise<void> {
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    const line =
      JSON.stringify({
        timestamp: new Date().toISOString(),
        ...entry,
        args: redact(entry.args),
      }) + "\n";
    await fs.appendFile(LOG_FILE, line, "utf8");
  } catch (err) {
    console.error(
      `[audit] WARNING: Failed to write audit log: ${(err as Error).message}`
    );
  }
}
