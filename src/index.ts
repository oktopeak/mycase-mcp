#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

import { initEncryptionKey } from "./auth/token-store.js";
import { createMcpServer } from "./server-factory.js";
import { startHttpServer } from "./http/server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

function warnMissingEnv(name: string): void {
  if (!process.env[name]) {
    console.error(`[mycase-mcp] WARNING: Required environment variable ${name} is not set.`);
    console.error(`[mycase-mcp] Copy .env.example to .env and fill in the values.`);
  }
}

warnMissingEnv("MYCASE_CLIENT_ID");
warnMissingEnv("MYCASE_CLIENT_SECRET");

// Parse CLI flags: --transport=stdio|http  --port=<number>
const cliArgs = process.argv.slice(2);
const transportArg = cliArgs.find((a) => a.startsWith("--transport="))?.split("=")[1] ?? "stdio";
const portArg = parseInt(cliArgs.find((a) => a.startsWith("--port="))?.split("=")[1] ?? "3000", 10);

if (transportArg !== "stdio" && transportArg !== "http") {
  console.error(`[mycase-mcp] ERROR: Unknown transport "${transportArg}". Use --transport=stdio or --transport=http.`);
  process.exit(1);
}

if (transportArg === "http") {
  // HTTP + SSE mode — multi-user, per-session McpServer instances.
  // Encryption keys are lazily initialised per user on first token access.
  await startHttpServer(portArg);
} else {
  // stdio mode — single-user, original behaviour unchanged.
  const server = createMcpServer();

  try {
    await initEncryptionKey();
  } catch (err) {
    console.error(`[mycase-mcp] WARNING: ${(err as Error).message}`);
    console.error("[mycase-mcp] Token operations will be unavailable. Set ENCRYPTION_KEY to run without a system keychain.");
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mycase-mcp] Server running on stdio. Ready for connections.");
}
