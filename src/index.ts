#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

import { registerAuthTools } from "./auth/authTools.js";
import { registerCaseTools } from "./tools/cases.js";
import { registerContactTools } from "./tools/contacts.js";
import { registerDocumentTools } from "./tools/documents.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerCalendarTools } from "./tools/calendar.js";
import { registerCallTools } from "./tools/calls.js";
import { registerBillingTools } from "./tools/billing.js";
import { registerAuthStatusResource } from "./resources/auth-status.js";
import { registerComplianceResource } from "./resources/compliance.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

function assertEnv(name: string): void {
  if (!process.env[name]) {
    console.error(`[mycase-mcp] ERROR: Required environment variable ${name} is not set.`);
    console.error(`[mycase-mcp] Copy .env.example to .env and fill in the values.`);
    process.exit(1);
  }
}

assertEnv("MYCASE_CLIENT_ID");
assertEnv("MYCASE_CLIENT_SECRET");
assertEnv("ENCRYPTION_KEY");

const server = new McpServer({ name: "mycase-mcp", version: "1.0.0" });

registerAuthTools(server);
registerCaseTools(server);
registerContactTools(server);
registerDocumentTools(server);
registerTaskTools(server);
registerCalendarTools(server);
registerCallTools(server);
registerBillingTools(server);
registerAuthStatusResource(server);
registerComplianceResource(server);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[mycase-mcp] Server running on stdio. Ready for connections.");
