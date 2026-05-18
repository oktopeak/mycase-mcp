import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import os from "os";
import keytar from "keytar";
const { getPassword, setPassword, deletePassword } = keytar;
import type { MyCaseTokens } from "./oauth.js";

const TOKEN_DIR = path.join(os.homedir(), ".oktopeak-mycase");
const TOKEN_FILE = path.join(TOKEN_DIR, "tokens.enc");
const ALGORITHM = "aes-256-gcm";
const KEYCHAIN_SERVICE = "mycase-mcp";
const KEYCHAIN_ACCOUNT = "encryption-key";

async function getEncryptionKey(): Promise<Buffer> {
  let keyHex = await getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);

  if (!keyHex) {
    const envKey = process.env.ENCRYPTION_KEY;
    if (envKey) {
      if (envKey.length !== 64)
        throw new Error(`ENCRYPTION_KEY must be 64 hex chars (32 bytes). Got ${envKey.length}.`);
      keyHex = envKey;
      await setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, keyHex);
      console.error(
        "[mycase-mcp] Encryption key migrated to OS keychain. " +
          "You can now remove ENCRYPTION_KEY from your .env file."
      );
    } else {
      keyHex = crypto.randomBytes(32).toString("hex");
      await setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, keyHex);
      console.error("[mycase-mcp] Generated a new encryption key and stored it in the OS keychain.");
    }
  }

  return Buffer.from(keyHex, "hex");
}

export async function initEncryptionKey(): Promise<void> {
  await getEncryptionKey();
}

export async function clearEncryptionKey(): Promise<void> {
  await deletePassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
}

export async function saveTokens(tokens: MyCaseTokens): Promise<void> {
  await fs.mkdir(TOKEN_DIR, { recursive: true, mode: 0o700 });
  const key = await getEncryptionKey();
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
  try {
    const key = await getEncryptionKey();
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
