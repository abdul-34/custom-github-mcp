# GitHub MCP

A GitHub MCP server for Claude and other MCP clients. No OAuth — it uses a
GitHub Personal Access Token, protected by a shared bearer token so only your
clients can reach it.

22 tools across repos, files, search, branches, commits, pull requests, issues,
and releases.

> **Read [SECURITY.md](SECURITY.md) before deploying.** This server exposes a
> PAT over HTTP. Anyone who can reach the URL and present the auth token
> inherits that token's access to your repositories.

## Quick start

### 1. Create a GitHub PAT

https://github.com/settings/tokens?type=beta → **Generate new token**

Scopes: `repo`, `read:org`, `read:user`, `workflow`.

Prefer a **fine-grained token limited to specific repositories** — that is the
strongest control available here, stronger than anything the server enforces.

### 2. Generate a server auth token

```bash
openssl rand -hex 32
```

This is the secret your MCP client presents to the server. It is **not** your
GitHub PAT — keep the two separate.

### 3. Deploy

Any Node 20+ host or container platform works. Config is included for the
common ones:

| Platform | Cost | Setup |
| --- | --- | --- |
| **DO App Platform** | smallest shared-CPU instance | `doctl apps create --spec .do/app.yaml` |
| **DO Droplet** | cheapest basic droplet | [systemd + Caddy walkthrough](DEPLOYMENT.md#digitalocean-droplet) |
| **Render** | free tier available | Blueprint — [`render.yaml`](render.yaml) |
| **Fly / Railway / Koyeb** | varies | [`Dockerfile`](Dockerfile) |
| **Any Docker host** | — | `docker build -t github-mcp .` |

Not compatible: Cloudflare Workers, Vercel/Netlify functions. Both need a
long-lived process for sessions and SSE. See
[DEPLOYMENT.md](DEPLOYMENT.md#platform-compatibility).

Locally, or on any VM:

```bash
npm ci && npm run build
GITHUB_TOKEN=... MCP_AUTH_TOKEN=... npm start
```

The server refuses to start without a valid `MCP_AUTH_TOKEN`. That is
deliberate — it never comes up unauthenticated.

**Two settings matter on every platform:**

- **TLS.** The auth token is a bearer header on every request. Managed
  platforms terminate TLS for you; on a bare VM you must add a proxy that does.
- **`TRUST_PROXY`.** `1` behind a proxy, `0` (the default) when Node is exposed
  directly. Wrong value silently disables rate limiting —
  [details](DEPLOYMENT.md#the-trust_proxy-setting).

Run **one instance** — sessions are held in memory.

### 4. Connect your client

```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://your-app.onrender.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_MCP_AUTH_TOKEN" }
    }
  }
}
```

If your client cannot send custom headers, set `MCP_ALLOW_QUERY_TOKEN=true` and
append the token to the URL:

```
https://your-app.onrender.com/mcp?key=YOUR_MCP_AUTH_TOKEN
```

This is weaker — URLs end up in proxy logs, browser history, and referrer
headers — so prefer the header wherever the client supports it.

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `GITHUB_TOKEN` | yes | — | GitHub PAT the tools act with |
| `MCP_AUTH_TOKEN` | yes | — | Shared secret clients must present (min 32 chars) |
| `MCP_READ_ONLY` | no | `false` | Register read tools only; write tools are never exposed |
| `ALLOWED_REPOS` | no | *(all)* | Comma-separated `owner/repo` allowlist for repo-scoped tools |
| `MCP_ALLOW_QUERY_TOKEN` | no | `false` | Also accept the token as `?key=` |
| `ALLOWED_ORIGINS` | no | *(none)* | Comma-separated browser origins allowed to call the server |
| `RATE_LIMIT_PER_MINUTE` | no | `240` | Per-IP request ceiling |
| `MAX_SESSIONS` | no | `50` | Concurrent session cap (LRU eviction) |
| `SESSION_IDLE_MINUTES` | no | `30` | Idle session timeout |
| `TRUST_PROXY` | no | `0` | Proxy hops to trust for client IPs. `1` behind a proxy |
| `HOST` | no | `0.0.0.0` | Bind address. `127.0.0.1` to expose only to a local proxy |
| `PORT` | no | `8080` | Listen port |

See [.env.example](.env.example) for a copyable template.

## Security summary

- Bearer auth on every MCP route, compared in constant time
- Fail-closed startup — no token, no server
- Origin allowlisting (DNS-rebinding defense) and CORS off by default
- Brute-force limiting: 20 failed auth attempts per IP per 15 min
- Bounded sessions with idle sweeping
- Optional read-only mode and per-repo allowlisting
- `helmet` headers, generic error responses
- `X-Forwarded-For` ignored by default, so rate limiting cannot be spoofed past

Full detail and the hardening checklist: [SECURITY.md](SECURITY.md).

## Transports

- **Streamable HTTP** (current): `POST`/`GET`/`DELETE` on `/mcp`
- **SSE** (deprecated): `GET /sse` + `POST /message`

Sessions are held in memory, so run a single instance. Multiple replicas behind
a load balancer will break sessions.

## Development

```bash
npm ci
cp .env.example .env    # fill in GITHUB_TOKEN and MCP_AUTH_TOKEN
npm run dev
```

## Docs

- [DEPLOYMENT.md](DEPLOYMENT.md) — platform compatibility, DigitalOcean guides, TLS
- [SECURITY.md](SECURITY.md) — threat model, controls, hardening checklist

## License

MIT — see [LICENSE](LICENSE).
