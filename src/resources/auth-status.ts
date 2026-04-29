import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadTokens } from "../auth/token-store.js";

export function registerAuthStatusResource(server: McpServer): void {
  server.resource(
    "auth-status",
    "mycase://auth/status",
    async () => {
      const tokens = await loadTokens().catch(() => null);
      const status = tokens
        ? {
            authenticated: true,
            user_id: tokens.user_id ?? "unknown",
            expires_at: new Date(tokens.expires_at).toISOString(),
            is_expired: Date.now() >= tokens.expires_at,
          }
        : {
            authenticated: false,
            user_id: null,
            expires_at: null,
            is_expired: true,
          };

      return {
        contents: [
          {
            uri: "mycase://auth/status",
            mimeType: "application/json",
            text: JSON.stringify(status, null, 2),
          },
        ],
      };
    }
  );
}
