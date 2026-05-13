import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

export function createMockServer() {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;

  return {
    server,
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const h = handlers.get(name);
      if (!h) throw new Error(`Tool "${name}" not registered`);
      return h(args);
    },
  };
}

export function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

export const MOCK_TOKENS = {
  access_token: "test-access-token",
  refresh_token: "test-refresh-token",
  expires_at: Date.now() + 86400 * 1000,
  firm_uuid: "firm-123",
};
