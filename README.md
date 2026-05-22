# MyCase MCP Server

Connect Claude to your [MyCase](https://www.mycase.com) legal practice management system. Ask Claude to look up cases, find contacts, check your calendar, review billing — all without leaving your conversation.

Built by [Oktopeak](https://github.com/oktopeak).

---

## Demo

Watch Claude pull live data from MyCase in under a minute — cases, contacts, documents, calendar — without copying client information into chat.

[![MyCase MCP — live demo on YouTube](https://img.youtube.com/vi/jkQ7BUdXztg/maxresdefault.jpg)](https://youtu.be/jkQ7BUdXztg)

---

## What it does

Once connected, Claude can talk directly to your MyCase firm data. You can ask things like:

- *"What open cases do we have for Jane Smith?"*
- *"Show me all tasks due this week"*
- *"What's the outstanding balance on the Anderson case?"*
- *"Log a 20-minute call with client #1234 about the settlement"*
- *"List documents attached to case 98765"*

Everything goes through MyCase's official OAuth 2.0 API. Your credentials never leave your machine — tokens are stored locally, encrypted with AES-256-GCM.

---

## Prerequisites

- **Node.js 18+**
- A **MyCase account** with firm admin access
- **MyCase API credentials** — reach out to [MyCase support](https://www.mycase.com/support/) to request OAuth client credentials for your firm. You'll receive a `client_id` and `client_secret`.

---

## Installation

### With Claude Desktop (recommended)

Add this to your Claude Desktop config file:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`  
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "mycase": {
      "command": "npx",
      "args": ["-y", "@oktopeak/mycase-mcp"],
      "env": {
        "MYCASE_CLIENT_ID": "your_client_id",
        "MYCASE_CLIENT_SECRET": "your_client_secret"
      }
    }
  }
}
```

Restart Claude Desktop and you're done.

### Standalone / development

```bash
npm install -g @oktopeak/mycase-mcp
```

---

## Configuration

If running locally (not via Claude Desktop env vars), copy `.env.example` to `.env` and fill it in:

```bash
cp .env.example .env
```

```env
# From MyCase support
MYCASE_CLIENT_ID=your_client_id
MYCASE_CLIENT_SECRET=your_client_secret

# OAuth callback port (default: 5678)
# Must match the redirect URI registered with MyCase support
MYCASE_REDIRECT_PORT=5678

# ENCRYPTION_KEY is optional — a key is auto-generated on first run and
# stored in your OS keychain. Only set this for CI or headless environments.
# ENCRYPTION_KEY=your_64_char_hex_encryption_key
```

> **Note:** The redirect URI registered with MyCase support must match `http://127.0.0.1:{MYCASE_REDIRECT_PORT}/callback`. If you're unsure which port was registered, check with MyCase support.

---

## Secret handling

`MYCASE_CLIENT_SECRET` is the only sensitive credential that needs to live in your config file. The encryption key is managed automatically by the OS keychain — it never appears in any config file.

When using `claude_desktop_config.json`, restrict that file's permissions so other users on the machine can't read your client secret:

**macOS:**
```bash
chmod 600 ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

**Windows:** Right-click the file → Properties → Security → Edit → remove access for all accounts except your own user.

---

## log-call (experimental)

The `log-call` tool is gated behind an environment variable while its API endpoint is being verified:

```env
MYCASE_EXPERIMENTAL_TOOLS=1
```

Add this to your `claude_desktop_config.json` env block or `.env` file to enable it. Leave it unset to keep it hidden from Claude.

---

## Authentication

The first time you use it, you need to authenticate with MyCase:

1. In Claude, call the **`authenticate`** tool
2. Your browser will open the MyCase login page
3. Log in and grant access
4. Return to Claude — you're connected

Access tokens are valid for **24 hours** and refresh automatically. Refresh tokens typically last **2 weeks** (set by the MyCase API). Once the refresh token expires you'll need to re-authenticate.

Your encrypted token file lives at `~/.oktopeak-mycase/tokens.enc` (stdio mode) or `~/.oktopeak-mycase/users/<user-id>/tokens.enc` (HTTP mode). To log out and remove it, call the **`logout`** tool.

> **Note:** If the OS keychain is cleared or the encryption key is lost, the existing token file can no longer be decrypted. The server will silently treat it as absent and you'll need to re-authenticate — no data is lost, just the stored session.

---

## Available tools

### Authentication
| Tool | Description |
|---|---|
| `authenticate` | Open the MyCase OAuth page and store your tokens |
| `auth-status` | Check if you're connected and when your token expires |
| `logout` | Remove stored tokens from disk |

### Cases
| Tool | Description |
|---|---|
| `list-cases` | List cases, optionally filtered by status (`open`/`closed`) or updated date |
| `get-case` | Get full details for a case by ID |
| `create-case` | Create a new case with clients, staff, and metadata |

### Contacts
| Tool | Description |
|---|---|
| `search-contacts` | Search for clients, people, or companies by name, email, or phone |
| `get-contact` | Get full contact details by ID |

### Tasks
| Tool | Description |
|---|---|
| `list-tasks` | List tasks, optionally filtered by case or completion status |
| `create-task` | Create a new task linked to a case |

### Documents
| Tool | Description |
|---|---|
| `list-documents` | List documents, optionally filtered by case |
| `get-document-url` | Get a download URL for a specific document |

### Calendar
| Tool | Description |
|---|---|
| `list-calendar-events` | List upcoming events within a date range |

### Calls
| Tool | Description |
|---|---|
| `log-call` | Log a phone call linked to a case or contact (**experimental** — requires `MYCASE_EXPERIMENTAL_TOOLS=1`) |

### Staff
| Tool | Description |
|---|---|
| `list-staff` | List all staff members in the firm |
| `get-staff` | Get full details for a staff member by ID |

### Billing
| Tool | Description |
|---|---|
| `list-time-entries` | List billable time entries, filtered by case or date range |
| `get-billing-summary` | Get total billed, outstanding, and paid amounts for a case |

---

## Hosted deployment (law firm / multi-user)

> **v2.0.0+** — Run one shared instance for your entire firm. Each staff member connects with their own API key and maintains independent MyCase credentials.

### 1. Start in HTTP mode

```bash
MYCASE_CLIENT_ID=... \
MYCASE_CLIENT_SECRET=... \
MYCASE_HTTP_BASE_URL=https://mycase-mcp.lawfirm.com \
  mycase-mcp --transport=http --port=3000
```

`MYCASE_HTTP_BASE_URL` must be the public URL where the server is reachable — it is used as the OAuth redirect URI base.

### 2. Provision API keys

Create `~/.oktopeak-mycase/api-keys.json` on the server:

```json
{
  "keys": {
    "sk_alice_replace_with_real_random_key": "alice@lawfirm.com",
    "sk_bob_replace_with_real_random_key":   "bob@lawfirm.com"
  }
}
```

Protect it: `chmod 600 ~/.oktopeak-mycase/api-keys.json`

For container deployments you can use an env var instead:

```bash
MYCASE_HTTP_API_KEYS=alice@lawfirm.com:sk_alice_key,bob@lawfirm.com:sk_bob_key
```

### 3. Connect Claude Desktop

Each staff member adds their personal API key to their Claude Desktop config:

```json
{
  "mcpServers": {
    "mycase": {
      "transport": "sse",
      "url": "https://mycase-mcp.lawfirm.com/sse",
      "headers": {
        "Authorization": "Bearer sk_alice_replace_with_real_random_key"
      }
    }
  }
}
```

### 4. Per-user authentication

Each staff member calls the `authenticate` tool once. In HTTP mode the tool returns an authorization URL to open in their browser rather than launching one automatically:

```
To authenticate, open this URL in your browser:

https://auth.mycase.com/login_sessions/new?...

After completing authorization, call auth-status to confirm you're connected.
```

Tokens are stored separately for each user under `~/.oktopeak-mycase/users/<user-id>/`.

### 5. nginx reverse-proxy setup

```nginx
server {
    listen 443 ssl;
    server_name mycase-mcp.lawfirm.com;

    ssl_certificate     /etc/letsencrypt/live/mycase-mcp.lawfirm.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mycase-mcp.lawfirm.com/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # Required for SSE streams:
        proxy_set_header   Connection '';
        proxy_buffering    off;
        proxy_cache        off;
        chunked_transfer_encoding on;

        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # SSE connections are long-lived:
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

### Audit log

Every tool call in HTTP mode is logged to `~/.oktopeak-mycase/audit.log` with a `user_id` field identifying the firm member:

```json
{"timestamp":"2026-05-22T10:30:00.000Z","user_id":"alice@lawfirm.com","tool":"list-cases","args":{},"outcome":"success","firm_uuid":"firm-abc","result_count":12}
```

---

## Development

```bash
git clone https://github.com/oktopeak/mycase-mcp.git
cd mycase-mcp
npm install
cp .env.example .env   # fill in your credentials
npm run build
npm run inspect        # opens the MCP inspector in your browser
```

### Running tests

```bash
npm test               # run once
npm run test:watch     # watch mode
```

---

## Security

- OAuth tokens are encrypted at rest using **AES-256-GCM**
- The encryption key is auto-generated on first run and stored in your **OS keychain** (macOS Keychain / Linux Secret Service / Windows Credential Manager) — it never appears in any config file
- Token and audit log files are stored in `~/.oktopeak-mycase/` with mode `0600` (owner-read/write only) on Unix/macOS
- On Windows, restrict `%APPDATA%\.oktopeak-mycase` via folder Properties → Security
- All API calls go directly from your machine to `external-integrations.mycase.com`

### Vulnerability scan

`npm audit --omit=dev` reports **0 production vulnerabilities**. The `vitest` dev-dependency carries 5 moderate findings (esbuild, vite) that are unreachable in production and require a major vitest version bump to resolve. They have no impact on deployed server instances.

---

## License

MIT — see [LICENSE](./LICENSE).

---

Built with the [Model Context Protocol SDK](https://github.com/modelcontextprotocol/sdk) by Anthropic.
