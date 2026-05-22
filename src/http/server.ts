import express, { Request, Response, NextFunction } from "express";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMcpServer } from "../server-factory.js";
import { runWithUserId } from "../context.js";
import { resolveUserId, loadApiKeys } from "./api-keys.js";
import { consumePendingState } from "./oauth-callbacks.js";
import { exchangeCodeForTokens } from "../auth/oauth.js";
import { saveTokens } from "../auth/token-store.js";

interface Session {
  transport: SSEServerTransport;
  userId: string;
}

// Active SSE sessions keyed by the transport's session ID.
const sessions = new Map<string, Session>();

// Extend Express request to carry the resolved user identity.
declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? "";
  const apiKey = header.startsWith("Bearer ") ? header.slice(7) : "";
  const userId = apiKey ? resolveUserId(apiKey) : undefined;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized — provide a valid API key via Authorization: Bearer <key>" });
    return;
  }
  req.userId = userId;
  next();
}

/**
 * Creates and configures the Express application with all routes.
 * Exported separately from startHttpServer() to enable unit testing.
 */
export function createExpressApp(): express.Express {
  const app = express();
  app.use(express.json());

  // ── Health check ────────────────────────────────────────────────────────────
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", transport: "http", sessions: sessions.size });
  });

  // ── SSE endpoint: one McpServer + SSEServerTransport per connection ─────────
  app.get("/sse", authMiddleware, async (req: Request, res: Response) => {
    const userId = req.userId!;
    const server = createMcpServer();
    const transport = new SSEServerTransport(
      "/message",
      res as unknown as ServerResponse
    );

    sessions.set(transport.sessionId, { transport, userId });
    transport.onclose = () => sessions.delete(transport.sessionId);

    console.error(`[http] SSE connection opened for user="${userId}" session=${transport.sessionId}`);

    try {
      await runWithUserId(userId, () => server.connect(transport));
    } catch (err) {
      console.error(`[http] Session ${transport.sessionId} error: ${(err as Error).message}`);
      sessions.delete(transport.sessionId);
    }
  });

  // ── Message endpoint: route POST bodies to the correct session ──────────────
  app.post("/message", authMiddleware, async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId) {
      res.status(400).json({ error: "Missing mcp-session-id header" });
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      res.status(404).json({ error: "Session not found or expired" });
      return;
    }

    if (session.userId !== req.userId) {
      res.status(403).json({ error: "Session belongs to a different user" });
      return;
    }

    try {
      await runWithUserId(
        session.userId,
        () => session.transport.handlePostMessage(
          req as unknown as IncomingMessage,
          res as unknown as ServerResponse,
          req.body
        )
      );
    } catch (err) {
      console.error(`[http] Message handler error: ${(err as Error).message}`);
      if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── OAuth callback: browser redirect after MyCase authorization ─────────────
  app.get("/oauth/callback", async (req: Request, res: Response) => {
    const state = req.query.state as string | undefined;
    const code = req.query.code as string | undefined;
    const error = req.query.error as string | undefined;

    if (!state) {
      res.status(400).send("<html><body><h2>Missing state parameter.</h2></body></html>");
      return;
    }

    const pending = consumePendingState(state);
    if (!pending) {
      res.status(400).send("<html><body><h2>Unknown or expired authorization request.</h2></body></html>");
      return;
    }

    if (error) {
      res
        .status(400)
        .send(`<html><body><h2>Authentication failed.</h2><p>Error: ${escapeHtml(error)}</p></body></html>`);
      return;
    }

    if (!code) {
      res.status(400).send("<html><body><h2>No authorization code received.</h2></body></html>");
      return;
    }

    try {
      const tokens = await exchangeCodeForTokens(
        code,
        pending.clientId,
        pending.clientSecret,
        pending.redirectUri
      );
      await runWithUserId(pending.userId, () => saveTokens(tokens));
      console.error(`[http] OAuth complete for user="${pending.userId}"${tokens.firm_uuid ? ` firm=${tokens.firm_uuid}` : ""}`);
      res.send(
        "<html><body>" +
          "<h2>Authentication successful!</h2>" +
          "<p>You can close this tab and return to your chat.</p>" +
          "</body></html>"
      );
    } catch (err) {
      console.error(`[http] OAuth callback error: ${(err as Error).message}`);
      res
        .status(500)
        .send(`<html><body><h2>Authentication error.</h2><p>${escapeHtml((err as Error).message)}</p></body></html>`);
    }
  });

  return app;
}

export async function startHttpServer(port: number): Promise<void> {
  await loadApiKeys();
  const app = createExpressApp();
  app.listen(port, () => {
    console.error(`[mycase-mcp] HTTP server listening on port ${port}. Transport: SSE`);
    console.error(`[mycase-mcp]   SSE endpoint:      GET  http://localhost:${port}/sse`);
    console.error(`[mycase-mcp]   Message endpoint:  POST http://localhost:${port}/message`);
    console.error(`[mycase-mcp]   OAuth callback:    GET  http://localhost:${port}/oauth/callback`);
    console.error(`[mycase-mcp]   Health check:      GET  http://localhost:${port}/health`);
  });
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
