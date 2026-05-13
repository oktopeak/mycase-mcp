import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import os from "os";
import type { MyCaseTokens } from "./oauth.js";

const TOKEN_DIR = path.join(os.homedir(), ".oktopeak-mycase");
const TOKEN_FILE = path.join(TOKEN_DIR, "tokens.enc");
const ALGORITHM = "aes-256-gcm";

function getEncryptionKey(): Buffer {
  const keyHex = process.env.ENCRYPTION_KEY;
  if (!keyHex) throw new Error("ENCRYPTION_KEY is not set in .env!");
  if (keyHex.length !== 64)
    throw new Error(
      `ENCRYPTION_KEY must be 64 hex chars (32 bytes). Got ${keyHex.length}.`
    );
  return Buffer.from(keyHex, "hex");
}

export async function saveTokens(tokens: MyCaseTokens): Promise<void> {
  await fs.mkdir(TOKEN_DIR, { recursive: true });
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(tokens), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  await fs.writeFile(TOKEN_FILE, Buffer.concat([iv, authTag, encrypted]));
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
    const key = getEncryptionKey();
    const iv = combined.subarray(0, 12);
    const authTag = combined.subarray(12, 28);
    const encrypted = combined.subarray(28);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return JSON.parse(decrypted.toString("utf8")) as MyCaseTokens;
  } catch (err: unknown) {
    console.error(
      `[token-store] Decryption failed — file corrupt or ENCRYPTION_KEY changed. ` +
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
