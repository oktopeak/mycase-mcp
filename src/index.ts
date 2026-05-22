#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "module";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

import { initEncryptionKey } from "./auth/token-store.js";
import { registerAuthTools } from "./auth/authTools.js";
import { registerCaseTools } from "./tools/cases.js";
import { registerContactTools } from "./tools/contacts.js";
import { registerDocumentTools } from "./tools/documents.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerCalendarTools } from "./tools/calendar.js";
import { registerCallTools } from "./tools/calls.js";
import { registerBillingTools } from "./tools/billing.js";
import { registerStaffTools } from "./tools/staff.js";
import { registerAuthStatusResource } from "./resources/auth-status.js";
import { registerComplianceResource } from "./resources/compliance.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

// Warn on missing env vars but let the server start so auth-status can guide the user
function warnMissingEnv(name: string): void {
  if (!process.env[name]) {
    console.error(`[mycase-mcp] WARNING: Required environment variable ${name} is not set.`);
    console.error(`[mycase-mcp] Copy .env.example to .env and fill in the values.`);
  }
}

warnMissingEnv("MYCASE_CLIENT_ID");
warnMissingEnv("MYCASE_CLIENT_SECRET");

const _require = createRequire(import.meta.url);
const { version } = _require("../package.json") as { version: string };

const server = new McpServer({ name: "mycase-mcp", version });

registerAuthTools(server);
registerCaseTools(server);
registerContactTools(server);
registerDocumentTools(server);
registerTaskTools(server);
registerCalendarTools(server);
registerBillingTools(server);
registerStaffTools(server);

if (process.env.MYCASE_EXPERIMENTAL_TOOLS === "1") {
  registerCallTools(server);
}

registerAuthStatusResource(server);
registerComplianceResource(server);

// Eagerly initialise the encryption key so it is migrated to the OS keychain
// on first startup, even before any tool is called.
// A caught error here means the keychain is unavailable — the server still starts
// so auth-status can report the problem, but token operations will fail with a
// clear "Set ENCRYPTION_KEY" message until the issue is resolved.
try {
  await initEncryptionKey();
} catch (err) {
  console.error(`[mycase-mcp] WARNING: ${(err as Error).message}`);
  console.error("[mycase-mcp] Token operations will be unavailable. Set ENCRYPTION_KEY to run without a system keychain.");
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[mycase-mcp] Server running on stdio. Ready for connections.");
