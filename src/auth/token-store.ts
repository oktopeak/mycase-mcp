import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { Entry } from "@napi-rs/keyring";
import type { MyCaseTokens } from "./oauth.js";

const TOKEN_DIR = path.join(os.homedir(), ".oktopeak-mycase");
const TOKEN_FILE = path.join(TOKEN_DIR, "tokens.enc");
const ALGORITHM = "aes-256-gcm";
const KEYCHAIN_SERVICE = "mycase-mcp";
const KEYCHAIN_ACCOUNT = "encryption-key";
const keychainEntry = new Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);

let cachedKey: Buffer | null = null;

function getEncryptionKey(): Buffer {
  if (cachedKey) return cachedKey;
  const envKey = process.env.ENCRYPTION_KEY;

  // CI / headless mode: if the env var is explicitly set, use it directly.
  // Attempt a best-effort keychain migration so the key survives env-var removal,
  // but never fail because the keychain is unavailable (no D-Bus, locked keychain, etc.).
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
      }
    } catch {
      // Keychain unavailable (headless/CI) — fine, the env var is used directly.
    }
    cachedKey = Buffer.from(envKey, "hex");
    return cachedKey;
  }

  // No env var: the OS keychain is the only source of truth.
  try {
    let keyHex = keychainEntry.getPassword();
    if (!keyHex) {
      keyHex = crypto.randomBytes(32).toString("hex");
      keychainEntry.setPassword(keyHex);
      console.error("[mycase-mcp] Generated a new encryption key and stored it in the OS keychain.");
    }
    cachedKey = Buffer.from(keyHex, "hex");
    return cachedKey;
  } catch (err) {
    throw new Error(
      `Keychain unavailable: ${(err as Error).message}. ` +
        `Set ENCRYPTION_KEY in your environment to run without a system keychain.`
    );
  }
}

// NOTE: intentionally async even though getEncryptionKey() is sync.
// Keeping a Promise-based signature lets callers await it and allows
// tests to use .rejects / .resolves — changing it to sync would require
// rewriting all those call-sites.
export async function initEncryptionKey(): Promise<void> {
  getEncryptionKey();
}

export function clearEncryptionKey(): void {
  cachedKey = null;
  try {
    keychainEntry.deletePassword();
  } catch {
    // Entry already absent or keychain unavailable — either way the key is gone.
  }
}

export async function saveTokens(tokens: MyCaseTokens): Promise<void> {
  await fs.mkdir(TOKEN_DIR, { recursive: true, mode: 0o700 });
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(tokens), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  await fs.writeFile(TOKEN_FILE, Buffer.concat([iv, authTag, encrypted]), { mode: 0o600 });
}

export async function loadTokens(): Promise<MyCaseTokens | null> {
  let combined: Buffer;
  try {
    combined = await fs.readFile(TOKEN_FILE);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  // Let keychain errors propagate — "Keychain unavailable" is not a decryption failure.
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
  try {
    await fs.unlink(TOKEN_FILE);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
