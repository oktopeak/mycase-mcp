import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createRequire } from "module";

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

const _require = createRequire(import.meta.url);
const { version } = _require("../package.json") as { version: string };

export function createMcpServer(): McpServer {
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

  return server;
}
