import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import os from "os";

const DEFAULT_KEY_FILE = path.join(os.homedir(), ".oktopeak-mycase", "api-keys.json");

interface ApiKeysFile {
  keys: Record<string, string>;
}

// Resolved once at startup via loadApiKeys(); shared across all requests.
// Stored as Buffers so resolveUserId() can use crypto.timingSafeEqual().
let keyList: Array<{ keyBuf: Buffer; userId: string }> | null = null;

/**
 * Loads the API key → user-id mapping from:
 *  1. MYCASE_HTTP_API_KEYS env var: "userId1:apiKey1,userId2:apiKey2"
 *  2. MYCASE_API_KEYS_FILE env var (path override)
 *  3. ~/.oktopeak-mycase/api-keys.json (default)
 *
 * Throws if no keys are found in any source — the HTTP server cannot start safely
 * without at least one registered user. Idempotent — subsequent calls are no-ops.
 */
export async function loadApiKeys(): Promise<void> {
  if (keyList !== null) return; // already loaded

  const entries: Array<{ keyBuf: Buffer; userId: string }> = [];

  // Env-var shorthand for container deployments: "userId1:apiKey1,userId2:apiKey2"
  const envKeys = process.env.MYCASE_HTTP_API_KEYS;
  if (envKeys) {
    for (const pair of envKeys.split(",")) {
      const colonIdx = pair.indexOf(":");
      if (colonIdx < 1) continue;
      const userId = pair.slice(0, colonIdx).trim();
      const apiKey = pair.slice(colonIdx + 1).trim();
      if (userId && apiKey) entries.push({ keyBuf: Buffer.from(apiKey), userId });
    }
  }

  // JSON file (always merged in if present)
  const filePath = process.env.MYCASE_API_KEYS_FILE ?? DEFAULT_KEY_FILE;
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as ApiKeysFile;
    if (parsed?.keys && typeof parsed.keys === "object") {
      for (const [apiKey, userId] of Object.entries(parsed.keys)) {
        if (typeof userId === "string" && apiKey && userId) {
          entries.push({ keyBuf: Buffer.from(apiKey), userId });
        }
      }
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Failed to read API keys file at ${filePath}: ${(err as Error).message}`);
    }
  }

  if (entries.length === 0) {
    throw new Error(
      "No API keys configured for HTTP transport mode.\n" +
        `Create ${DEFAULT_KEY_FILE} with format:\n` +
        `  { "keys": { "<api-key>": "<user-id>" } }\n` +
        `Or set MYCASE_HTTP_API_KEYS=userId:apiKey in the environment.`
    );
  }

  keyList = entries;
  console.error(`[mycase-mcp] Loaded ${entries.length} API key(s) for HTTP mode.`);
}

/**
 * Returns the user-id for the given API key, or undefined if not found.
 * Uses constant-time comparison to prevent timing-based key enumeration.
 * Must call loadApiKeys() before using this.
 */
export function resolveUserId(apiKey: string): string | undefined {
  if (!keyList) return undefined;
  const candidate = Buffer.from(apiKey);
  for (const { keyBuf, userId } of keyList) {
    if (keyBuf.length === candidate.length && crypto.timingSafeEqual(keyBuf, candidate)) {
      return userId;
    }
  }
  return undefined;
}
