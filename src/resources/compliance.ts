import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerComplianceResource(server: McpServer): void {
  server.resource(
    "compliance-notice",
    "mycase://compliance/notice",
    async () => ({
      contents: [
        {
          uri: "mycase://compliance/notice",
          mimeType: "text/plain",
          text: `MyCase MCP — Compliance Notice

This connector enables Claude to access your MyCase practice management data.

DATA HANDLING
• All MyCase data is fetched live on demand — nothing is stored or cached locally.
• OAuth tokens are encrypted with AES-256-GCM and stored only on this machine (~/.oktopeak-mycase/tokens.enc).
• No data is transmitted to any third-party service beyond the MyCase API.

AUDIT LOGGING
• Every tool call is logged to ~/.oktopeak-mycase/audit.log in JSON-lines format.
• Logs include: timestamp, tool name, arguments (secrets redacted), outcome, user ID, case ID, result count.
• This log supports ABA Opinion 512 compliance documentation requirements.

WRITE ACCESS
• Only create-task, create-note (if enabled), and log-call can modify MyCase data.
• All other tools are strictly read-only.

RATE LIMITING
• Requests are capped at 30 per minute (rolling window) to protect your MyCase account.
• Automatic retry with backoff on 429 Too Many Requests responses.
• Auto-refresh of access tokens on 401 Unauthorized responses.

ADVANCED TIER REQUIRED
• The MyCase API requires the Advanced tier subscription ($109/user/month).
• Ensure your account has API access enabled in MyCase developer settings.`,
        },
      ],
    })
  );
}
