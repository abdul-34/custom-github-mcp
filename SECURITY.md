# Security

## Threat model

This server holds a GitHub Personal Access Token and exposes it over HTTP as MCP
tools. **Anyone who can reach the URL and present `MCP_AUTH_TOKEN` gets the full
capability of that PAT** — every repo it can see, read and write.

There is no per-user identity. The auth token is a single shared secret, not a
login. Treat it like a password, and treat the PAT as the real blast radius.

## What the server enforces

| Control | Behavior |
| --- | --- |
| Bearer auth | Required on `/mcp`, `/sse`, `/message`. Compared in constant time over SHA-256 digests so token length does not leak. |
| Fail-closed startup | Missing or sub-32-char `MCP_AUTH_TOKEN` aborts the boot. The server never comes up unauthenticated. |
| Origin allowlist | A request with an `Origin` not in `ALLOWED_ORIGINS` is rejected with 403 — the DNS-rebinding defense. Non-browser clients send no `Origin`. |
| CORS | Off by default. No cross-origin browser access unless `ALLOWED_ORIGINS` names an origin. |
| Brute-force limiting | 20 failed auth attempts per IP per 15 min, then 429. Successful requests are not counted. |
| Request limiting | 240 requests per IP per minute (`RATE_LIMIT_PER_MINUTE`). |
| Session bounds | Capped at `MAX_SESSIONS` with LRU eviction, plus an idle sweep every minute. Stops unbounded transport allocation. |
| Read-only mode | `MCP_READ_ONLY=true` never registers the 11 write tools — they are absent from `tools/list`, not merely refused. |
| Repo allowlist | `ALLOWED_REPOS` rejects repo-scoped calls outside the list and drops `create_repository`. |
| Security headers | `helmet` defaults; `x-powered-by` disabled. |
| Fail-safe proxy trust | `TRUST_PROXY` defaults to `0`, so `X-Forwarded-For` is ignored unless a proxy hop is explicitly opted into. |
| Error handling | Clients get a generic JSON-RPC error. Stack traces stay in server logs. |

## Hardening checklist

- [ ] **Scope the PAT to the minimum.** A fine-grained token limited to specific
      repositories is a far stronger control than anything this server does. If
      the PAT cannot reach a repo, no bug here can either.
- [ ] Set `MCP_READ_ONLY=true` unless you actually need writes.
- [ ] Set `ALLOWED_REPOS` to the repos you intend to expose.
- [ ] Generate `MCP_AUTH_TOKEN` with `openssl rand -hex 32`. Never reuse it.
- [ ] Leave `MCP_ALLOW_QUERY_TOKEN=false` unless a client forces otherwise.
- [ ] Rotate both tokens if the URL or logs are ever exposed.
- [ ] Keep the deployment single-instance — sessions are in-memory.
- [ ] **Serve over TLS.** The auth token is sent as a bearer header on every
      request; over plain HTTP it is exposed to anyone on the path. Managed
      platforms do this for you. On a bare VM you must put a TLS proxy in front
      — see [DEPLOYMENT.md](DEPLOYMENT.md).
- [ ] **Set `TRUST_PROXY` to match your topology.** Non-zero when Node is
      directly reachable lets a client spoof `X-Forwarded-For` and bypass rate
      limiting entirely, silently. The default of `0` is safe for direct
      exposure; use `1` behind exactly one proxy.
- [ ] On a VM, set `HOST=127.0.0.1` so only the local reverse proxy can reach
      the Node port.

## Known limitations

- **No per-user identity or audit trail.** Every authenticated client is
  indistinguishable and acts as the PAT owner.
- **In-memory sessions.** Multiple replicas behind a load balancer will break
  sessions. Run one instance.
- **Search tools are not repo-scoped.** `search_code`, `search_repos`, and
  `search_issues` query GitHub globally and return what the PAT can see;
  `ALLOWED_REPOS` does not constrain them. They are read-only.
- **Rate limits are per IP.** A distributed source is not meaningfully limited,
  and they are in-process — restarting the server clears them.
- **No TLS of its own.** The server speaks plain HTTP and relies on the platform
  or a reverse proxy to terminate TLS.

## Reporting a vulnerability

Please open a GitHub security advisory rather than a public issue.
