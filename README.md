# MyCase MCP Server

Connect Claude to your [MyCase](https://www.mycase.com) legal practice management system. Ask Claude to look up cases, find contacts, check your calendar, review billing — all without leaving your conversation.

Built by [Oktopeak](https://github.com/oktopeak).

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
        "MYCASE_CLIENT_SECRET": "your_client_secret",
        "ENCRYPTION_KEY": "your_64_char_hex_key"
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

## Generating an encryption key

Your tokens are stored encrypted on disk. You need to generate a random 32-byte key (64 hex characters) and keep it consistent across restarts — if you change it, you'll need to re-authenticate.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the output and use it as your `ENCRYPTION_KEY`.

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

# Generated above
ENCRYPTION_KEY=your_64_char_hex_encryption_key

# OAuth callback port (default: 5678)
# Must match the redirect URI registered with MyCase support
MYCASE_REDIRECT_PORT=5678
```

> **Note:** The redirect URI registered with MyCase support must match `http://127.0.0.1:{MYCASE_REDIRECT_PORT}/callback`. If you're unsure which port was registered, check with MyCase support.

---

## Secret handling

`MYCASE_CLIENT_SECRET` and `ENCRYPTION_KEY` are sensitive credentials. When passed via `claude_desktop_config.json`, restrict that file's permissions:

**macOS:**
```bash
chmod 600 ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

**Windows:** Right-click the file → Properties → Security → Edit → remove access for all accounts except your own user.

> OS keychain integration is planned for a future release.

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

Access tokens are valid for **24 hours** and refresh automatically. Refresh tokens last **2 weeks**. Once the refresh token expires you'll need to re-authenticate.

Your encrypted token file lives at `~/.oktopeak-mycase/tokens.enc`. To log out and remove it, call the **`logout`** tool.

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

## A note on multi-user support

This server is **single-tenant by design** — it stores one set of credentials at a time and is intended for a single firm running it locally. If you authenticate as a different user, the previous token is overwritten.

If you need multiple firms or users, you'd need to run separate instances with separate configurations.

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
- The `ENCRYPTION_KEY` never leaves your machine
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
