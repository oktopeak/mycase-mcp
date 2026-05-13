import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadTokens, clearTokens } from "./token-store.js";
import { runOAuthFlow } from "./oauth.js";
import { auditLog } from "../audit/logger.js";

export function registerAuthTools(server: McpServer): void {
  server.tool(
    "authenticate",
    "Open the MyCase OAuth authorization page in the browser and store the resulting tokens encrypted on disk. Must be called before any other MyCase tools.",
    {},
    async () => {
      try {
        await runOAuthFlow();
        const tokens = await loadTokens();
        await auditLog({ tool: "authenticate", args: {}, outcome: "success", user_id: tokens?.user_id, result_count: 1 });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                firm_uuid: tokens?.firm_uuid ?? "unknown",
                message: "Successfully authenticated with MyCase. You can now use the other MyCase tools.",
              }),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({ tool: "authenticate", args: {}, outcome: "error", error: msg });
        return { content: [{ type: "text", text: `Authentication failed: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    "auth-status",
    "Check whether the server is authenticated with MyCase and when the token expires.",
    {},
    async () => {
      try {
        const tokens = await loadTokens();
        if (!tokens) {
          await auditLog({ tool: "auth-status", args: {}, outcome: "success", result_count: 0 });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  authenticated: false,
                  message: 'Not authenticated. Use the "authenticate" tool to connect to MyCase.',
                }),
              },
            ],
          };
        }

        const expiresAt = new Date(tokens.expires_at).toISOString();
        const isExpired = Date.now() >= tokens.expires_at;
        await auditLog({ tool: "auth-status", args: {}, outcome: "success", user_id: tokens.user_id, result_count: 1 });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                authenticated: true,
                firm_uuid: tokens.firm_uuid ?? "unknown",
                expires_at: expiresAt,
                is_expired: isExpired,
              }),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({ tool: "auth-status", args: {}, outcome: "error", error: msg });
        return { content: [{ type: "text", text: `Error checking auth status: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    "logout",
    "Remove the stored MyCase tokens from disk.",
    {},
    async () => {
      try {
        const tokens = await loadTokens();
        await clearTokens();
        await auditLog({ tool: "logout", args: {}, outcome: "success", user_id: tokens?.user_id, result_count: 0 });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: 'Logged out. Use "authenticate" to reconnect.',
              }),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = (err as Error).message;
        await auditLog({ tool: "logout", args: {}, outcome: "error", error: msg });
        return { content: [{ type: "text", text: `Logout failed: ${msg}` }], isError: true };
      }
    }
  );
}
