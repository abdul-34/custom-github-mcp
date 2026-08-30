# Deployment

The server is a stock Node 20+ HTTP service with no native dependencies, no
database, and no build-time platform coupling. Anything that can run Node or a
container can host it.

Read [SECURITY.md](SECURITY.md) first. Two settings below are security-relevant
on every platform: **TLS** and **`TRUST_PROXY`**.

## Platform compatibility

| Platform | Works | Notes |
| --- | --- | --- |
| **DO App Platform** | ✅ | Spec included: [`.do/app.yaml`](.do/app.yaml). Managed TLS. Set `TRUST_PROXY=1`. |
| **DO Droplet** | ✅ | Cheapest option. **You must add TLS yourself** — see below. Leave `TRUST_PROXY` at its `0` default unless you put a proxy in front. |
| **Render** | ✅ | Blueprint included: [`render.yaml`](render.yaml). Managed TLS. `TRUST_PROXY=1`. |
| **Fly.io** | ✅ | Uses the [`Dockerfile`](Dockerfile). Managed TLS. `TRUST_PROXY=1`. |
| **Railway / Koyeb** | ✅ | Dockerfile or Node buildpack. Managed TLS. `TRUST_PROXY=1`. |
| **Docker anywhere** | ✅ | [`Dockerfile`](Dockerfile) is multi-stage and runs as non-root. |
| **AWS App Runner / Cloud Run** | ✅ | Container. Set `instance_count`/`max-instances` to **1** — sessions are in memory. |
| **Cloudflare Workers** | ❌ | Needs a port: no listening socket, and the in-memory session map does not survive isolate recycling. Would require Durable Objects. |
| **Vercel / Netlify functions** | ❌ | Same reason — no long-lived process for SSE or sessions. |

Everywhere: **run exactly one instance.** Sessions live in memory, so a second
replica behind a load balancer breaks any client whose requests land on it.

## Resource requirements

Measured with 5 concurrent sessions: **~105 MB RSS**. Runtime fits comfortably
in 512 MB.

The *build* is the tight part. `npm ci` plus `tsc` on a 512 MB box can OOM. Two
ways around it, both fine:

- Add swap (the Droplet steps below do this), or
- Build the image elsewhere and deploy the artifact.

## DigitalOcean App Platform

Managed, closest to Render, no server administration.

```bash
doctl apps create --spec .do/app.yaml
```

Edit `.do/app.yaml` first: set your `repo`, and replace both `CHANGE_ME`
secrets. Or use the control panel — create the app from your repo, set
`GITHUB_TOKEN` and `MCP_AUTH_TOKEN` as encrypted env vars, and set
`TRUST_PROXY=1`.

TLS and the `*.ondigitalocean.app` domain are handled for you.

## DigitalOcean Droplet

The cheapest path, and the one with the most footguns. A Droplet is a bare VM:
**nothing terminates TLS and nothing sets `X-Forwarded-For` unless you install
it.**

### Why TLS is mandatory here

Clients send `Authorization: Bearer <MCP_AUTH_TOKEN>` on every request. Over
plain HTTP that token crosses the network in cleartext, and anyone who captures
it gets your PAT's access to your repositories. Do not expose this server on
`http://`. The steps below use Caddy, which obtains and renews a Let's Encrypt
certificate automatically.

### Setup

Create an Ubuntu 24.04 Droplet, point a DNS A record at it, then:

```bash
# 1. Swap, so the build does not OOM on a 512 MB box
fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# 2. Node 20 + Caddy
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs caddy

# 3. Build as an unprivileged user
useradd -r -m -d /opt/github-mcp -s /usr/sbin/nologin mcp
git clone https://github.com/YOUR_USERNAME/github-mcp.git /opt/github-mcp/app
chown -R mcp:mcp /opt/github-mcp
cd /opt/github-mcp/app && sudo -u mcp npm ci && sudo -u mcp npm run build
```

Secrets go in a root-owned file the service reads — never in the unit file,
which is world-readable:

```bash
cat > /etc/github-mcp.env <<'ENV'
GITHUB_TOKEN=ghp_your_token
MCP_AUTH_TOKEN=your_openssl_rand_hex_32
PORT=8080
# Caddy is the only thing in front, and it sets X-Forwarded-For.
TRUST_PROXY=1
MCP_READ_ONLY=false
ALLOWED_REPOS=
ENV
chmod 600 /etc/github-mcp.env
```

```ini
# /etc/systemd/system/github-mcp.service
[Unit]
Description=GitHub MCP Server
After=network.target

[Service]
Type=simple
User=mcp
WorkingDirectory=/opt/github-mcp/app
EnvironmentFile=/etc/github-mcp.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5

# Bind to loopback only. Caddy reaches it; the internet cannot.
Environment=HOST=127.0.0.1

# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/opt/github-mcp/app
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6
MemoryMax=400M

[Install]
WantedBy=multi-user.target
```

```
# /etc/caddy/Caddyfile — replace with your domain
mcp.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

```bash
systemctl daemon-reload && systemctl enable --now github-mcp && systemctl restart caddy

# Firewall: only SSH and HTTP(S). The Node port stays unreachable from outside.
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
```

Verify, then connect to `https://mcp.example.com/mcp`:

```bash
curl https://mcp.example.com/health                    # {"status":"ok"}
curl -o /dev/null -w '%{http_code}\n' -X POST https://mcp.example.com/mcp   # 401
```

A `401` on that second command is the correct answer — it proves auth is on.

### Updating

```bash
cd /opt/github-mcp/app && sudo -u mcp git pull && sudo -u mcp npm ci && sudo -u mcp npm run build
systemctl restart github-mcp
```

## Docker

```bash
docker build -t github-mcp .
docker run -d --name github-mcp -p 127.0.0.1:8080:8080 \
  -e GITHUB_TOKEN=ghp_... \
  -e MCP_AUTH_TOKEN=$(openssl rand -hex 32) \
  -e TRUST_PROXY=1 \
  --restart unless-stopped --memory 400m \
  github-mcp
```

Publishing to `127.0.0.1:8080` rather than `0.0.0.0:8080` keeps the container
off the public internet so your TLS proxy stays the only entry point.

## The TRUST_PROXY setting

This one is easy to get wrong and the failure is silent.

The rate limiters bucket by client IP. When `TRUST_PROXY` is non-zero, Express
takes the client IP from the `X-Forwarded-For` header. That is correct behavior
**only when something in front of the server overwrites that header** — which is
what a real proxy does.

If the server is reachable directly and `TRUST_PROXY` is non-zero, a client can
send its own `X-Forwarded-For` and get a fresh rate-limit bucket on every
request. Brute-force protection stops working entirely, with no error and
nothing in the logs.

| Setup | Value |
| --- | --- |
| Behind Render / App Platform / Fly / Cloud Run | `1` |
| Behind your own single nginx or Caddy | `1` |
| Node exposed directly to the internet | `0` (the default) |
| Behind Cloudflare **and** your own proxy | `2` |

The default is `0`, so a plain Droplet deploy is safe out of the box and you opt
in when you add a proxy. The startup log prints the effective value — check it
after deploying.
