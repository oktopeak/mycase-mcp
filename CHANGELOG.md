# Changelog

## [2.0.0] — 2026-05-22

### Breaking changes

- **Token storage layout (HTTP transport only)**: per-user tokens now live under
  `~/.oktopeak-mycase/users/<user-id>/tokens.enc` instead of the root
  `tokens.enc` file. **stdio users are completely unaffected** — the single-user
  path and keychain account are unchanged.
- **Keychain namespacing (HTTP transport only)**: each firm member's encryption
  key is stored in the OS keychain under the account name
  `encryption-key:<user-id>`. The stdio account `encryption-key` is unchanged.

### New features

- **`--transport=http [--port=N]`** CLI flag starts an HTTP + SSE server
  (default port 3000) capable of serving multiple simultaneous users.
- **Per-user API key authentication** for the HTTP server via
  `~/.oktopeak-mycase/api-keys.json` or the `MYCASE_HTTP_API_KEYS` env var.
- **`user_id` field in audit log entries** — every action logged in HTTP mode
  now includes the firm member's user identifier for compliance tracing.
- **`GET /oauth/callback`** endpoint on the HTTP server handles browser
  redirects after MyCase OAuth, storing tokens per-user automatically.
- **`GET /health`** endpoint returns server status and active session count.
- **`authenticate` tool in HTTP mode** returns an authorization URL for the
  user to open in their own browser instead of opening a local browser.
- **Per-user token isolation**: each staff member's MyCase OAuth tokens and
  encryption key are stored in completely separate namespaces.

### Internal changes

- `src/context.ts`: new `AsyncLocalStorage`-based request context carries
  `userId` through the entire async call stack without changing function signatures.
- `src/server-factory.ts`: new factory creates a fresh `McpServer` instance
  per SSE connection, enabling concurrent multi-user sessions.
- Per-user inflight token refresh deduplication prevents concurrent refresh
  storms for each user independently.

---

## [1.1.0] — 2025-xx-xx

- OS keychain integration for encryption key storage (`@napi-rs/keyring`)
- Auto-generate and store encryption key in macOS Keychain / Linux Secret Service / Windows Credential Manager
- Configurable OAuth URL overrides via env vars
- Token-store unit tests and improved authTools tests
- Bump vitest to ^4.1.7

## [1.0.0] — initial release

- 18 MCP tools covering cases, contacts, documents, tasks, calendar, calls, time entries, billing, and staff
- AES-256-GCM encrypted OAuth token storage
- JSON-lines audit log with rotation (ABA Opinion 512 compliance)
- Rate limiting at 30 req/min with automatic token refresh
