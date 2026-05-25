import crypto from "crypto";
import express, { Request, Response, NextFunction } from "express";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "../server-factory.js";
import { runWithUserId } from "../context.js";
import { resolveUserId, loadApiKeys } from "./api-keys.js";
import { consumePendingState } from "./oauth-callbacks.js";
import { exchangeCodeForTokens } from "../auth/oauth.js";
import { saveTokens } from "../auth/token-store.js";

interface Session {
  transport: StreamableHTTPServerTransport;
  userId: string;
}

const MAX_SESSIONS_PER_USER = 10;

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
 *
 * @param sessions - Active MCP sessions map. Defaults to a fresh Map so each
 *   test invocation gets isolated state rather than sharing module-level state.
 */
export function createExpressApp(
  sessions = new Map<string, Session>()
): express.Express {
  const app = express();
  app.use(express.json());

  // Per-user session count index — O(1) cap check without scanning the sessions Map.
  // Seeded from the injected sessions map so pre-populated test fixtures work correctly.
  const userSessionCounts = new Map<string, number>();
  for (const { userId } of sessions.values()) {
    userSessionCounts.set(userId, (userSessionCounts.get(userId) ?? 0) + 1);
  }

  function incrementUserCount(userId: string): void {
    userSessionCounts.set(userId, (userSessionCounts.get(userId) ?? 0) + 1);
  }
  function decrementUserCount(userId: string): void {
    const n = userSessionCounts.get(userId) ?? 1;
    if (n <= 1) userSessionCounts.delete(userId);
    else userSessionCounts.set(userId, n - 1);
  }

  // ── Health check ────────────────────────────────────────────────────────────
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", transport: "http", sessions: sessions.size });
  });

  // ── MCP Streamable HTTP endpoint ────────────────────────────────────────────
  // POST /mcp  — initialize new session (no Mcp-Session-Id) or send message
  // GET  /mcp  — open SSE stream for server→client notifications
  // DELETE /mcp — terminate session
  async function mcpHandler(req: Request, res: Response): Promise<void> {
    const userId = req.userId!;
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    console.error(`[http] ${req.method} /mcp user="${userId}"${sessionId ? ` session=${sessionId}` : " (new session)"}`);

    if (sessionId) {
      // Route to an existing session.
      const session = sessions.get(sessionId);
      if (!session) {
        console.error(`[http] 404 session not found user="${userId}" session=${sessionId}`);
        res.status(404).json({ error: "Session not found or expired" });
        return;
      }
      if (session.userId !== userId) {
        console.error(`[http] 403 cross-user attempt user="${userId}" session=${sessionId} owner="${session.userId}"`);
        res.status(403).json({ error: "Session belongs to a different user" });
        return;
      }
      try {
        await runWithUserId(userId, () =>
          session.transport.handleRequest(
            req as unknown as IncomingMessage,
            res as unknown as ServerResponse,
            req.body
          )
        );
      } catch (err) {
        console.error(`[http] handler error user="${userId}" session=${sessionId}: ${(err as Error).message}`);
        if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
      }
      return;
    }

    // No Mcp-Session-Id — only POST can initialize a new session.
    if (req.method !== "POST") {
      res.status(400).json({ error: "Mcp-Session-Id header required for GET and DELETE" });
      return;
    }

    // Per-user session cap.
    if ((userSessionCounts.get(userId) ?? 0) >= MAX_SESSIONS_PER_USER) {
      console.error(`[http] 429 session cap reached user="${userId}" count=${userSessionCounts.get(userId)}`);
      res.status(429).json({ error: `Too many concurrent sessions (max ${MAX_SESSIONS_PER_USER} per user)` });
      return;
    }

    // New session: create transport, wire callbacks, connect a fresh McpServer.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, { transport, userId });
        incrementUserCount(userId);
        console.error(`[http] session opened  user="${userId}" session=${sid} (total for user: ${userSessionCounts.get(userId)})`);
      },
      onsessionclosed: (sid) => {
        const count = (userSessionCounts.get(userId) ?? 1) - 1;
        sessions.delete(sid);
        decrementUserCount(userId);
        console.error(`[http] session closed  user="${userId}" session=${sid} (total for user: ${count})`);
      },
    });

    const mcpServer = createMcpServer();
    try {
      await runWithUserId(userId, async () => {
        await mcpServer.connect(transport);
        await transport.handleRequest(
          req as unknown as IncomingMessage,
          res as unknown as ServerResponse,
          req.body
        );
      });
    } catch (err) {
      console.error(`[http] Session init error: ${(err as Error).message}`);
      if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    }
  }

  app.post("/mcp", authMiddleware, mcpHandler);
  app.get("/mcp", authMiddleware, mcpHandler);
  app.delete("/mcp", authMiddleware, mcpHandler);

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

  if (process.env.ENCRYPTION_KEY) {
    console.error(
      "[mycase-mcp] WARNING: ENCRYPTION_KEY is set in HTTP mode — all users share one encryption key.\n" +
      "[mycase-mcp]          For production deployments, remove ENCRYPTION_KEY and rely on the OS\n" +
      "[mycase-mcp]          keychain so each user gets an independently rotatable encryption key."
    );
  }

  const app = createExpressApp();
  app.listen(port, () => {
    console.error(`[mycase-mcp] HTTP server listening on port ${port}. Transport: Streamable HTTP`);
    console.error(`[mycase-mcp]   MCP endpoint:   POST/GET/DELETE  http://localhost:${port}/mcp`);
    console.error(`[mycase-mcp]   OAuth callback: GET              http://localhost:${port}/oauth/callback`);
    console.error(`[mycase-mcp]   Health check:   GET              http://localhost:${port}/health`);
  });
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
