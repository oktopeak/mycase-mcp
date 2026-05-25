import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { Entry } from "@napi-rs/keyring";
import type { MyCaseTokens } from "./oauth.js";
import { getCurrentUserId } from "../context.js";

const TOKEN_DIR = path.join(os.homedir(), ".oktopeak-mycase");
const TOKEN_FILE = path.join(TOKEN_DIR, "tokens.enc");
const ALGORITHM = "aes-256-gcm";
const KEYCHAIN_SERVICE = "mycase-mcp";
const KEYCHAIN_ACCOUNT = "encryption-key";

// Per-user encryption key cache (keyed by userId; 'stdio' = legacy single-user path).
const keyCache = new Map<string, Buffer>();

function getKeychainAccount(): string {
  const userId = getCurrentUserId();
  return userId === "stdio" ? KEYCHAIN_ACCOUNT : `encryption-key:${userId}`;
}

function getTokenPath(): string {
  const userId = getCurrentUserId();
  if (userId === "stdio") return TOKEN_FILE; // backward-compat

  // Guard against path traversal — userId comes from admin config but we
  // defend in depth to ensure it can never escape the users/ subdirectory.
  const usersDir = path.resolve(TOKEN_DIR, "users");
  const resolved = path.resolve(usersDir, userId, "tokens.enc");
  if (!resolved.startsWith(usersDir + path.sep)) {
    throw new Error(`Invalid userId — path traversal detected: ${JSON.stringify(userId)}`);
  }
  return resolved;
}

function getEncryptionKey(): Buffer {
  const userId = getCurrentUserId();
  const cached = keyCache.get(userId);
  if (cached) return cached;

  const account = getKeychainAccount();
  const keychainEntry = new Entry(KEYCHAIN_SERVICE, account);
  const envKey = process.env.ENCRYPTION_KEY;

  if (envKey) {
    if (!/^[0-9a-fA-F]{64}$/.test(envKey))
      throw new Error(`ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes). Got length ${envKey.length}.`);
    try {
      const existing = keychainEntry.getPassword();
      if (!existing) {
        keychainEntry.setPassword(envKey);
        console.error(
          "[mycase-mcp] Encryption key migrated to OS keychain. " +
            "You can now remove ENCRYPTION_KEY from your environment."
        );
      } else if (existing !== envKey) {
        console.error(
          "[mycase-mcp] WARNING: ENCRYPTION_KEY differs from the key stored in the OS keychain. " +
            "The env var is being used now, but removing it will switch to the keychain key and " +
            "existing tokens will fail to decrypt — you will need to re-authenticate."
        );
      }
    } catch {
      // Keychain unavailable (headless/CI) — fine, the env var is used directly.
    }
    const key = Buffer.from(envKey, "hex");
    keyCache.set(userId, key);
    return key;
  }

  try {
    let keyHex = keychainEntry.getPassword();
    if (!keyHex) {
      keyHex = crypto.randomBytes(32).toString("hex");
      keychainEntry.setPassword(keyHex);
      console.error("[mycase-mcp] Generated a new encryption key and stored it in the OS keychain.");
    }
    const key = Buffer.from(keyHex, "hex");
    keyCache.set(userId, key);
    return key;
  } catch (err) {
    throw new Error(
      `Keychain unavailable: ${(err as Error).message}. ` +
        `Set ENCRYPTION_KEY in your environment to run without a system keychain.`
    );
  }
}

export async function initEncryptionKey(): Promise<void> {
  getEncryptionKey();
}

export function clearEncryptionKey(): void {
  const userId = getCurrentUserId();
  keyCache.delete(userId);
  const account = getKeychainAccount();
  try {
    new Entry(KEYCHAIN_SERVICE, account).deletePassword();
  } catch {
    // Entry already absent or keychain unavailable.
  }
}

export async function saveTokens(tokens: MyCaseTokens): Promise<void> {
  const tokenPath = getTokenPath();
  await fs.mkdir(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(tokens), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  await fs.writeFile(tokenPath, Buffer.concat([iv, authTag, encrypted]), { mode: 0o600 });
}

export async function loadTokens(): Promise<MyCaseTokens | null> {
  const tokenPath = getTokenPath();
  let combined: Buffer;
  try {
    combined = await fs.readFile(tokenPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const key = getEncryptionKey();
  try {
    const iv = combined.subarray(0, 12);
    const authTag = combined.subarray(12, 28);
    const encrypted = combined.subarray(28);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return JSON.parse(decrypted.toString("utf8")) as MyCaseTokens;
  } catch (err: unknown) {
    console.error(
      `[token-store] Decryption failed — file corrupt or key changed. ` +
        `Detail: ${(err as Error).message}`
    );
    return null;
  }
}

export async function clearTokens(): Promise<void> {
  const tokenPath = getTokenPath();
  try {
    await fs.unlink(tokenPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
