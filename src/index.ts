import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Octokit } from "octokit";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cors from "cors";
import "dotenv/config";

import { registerGitHubTools } from "./tools.js";
import { requireAuth } from "./auth.js";
import { withPolicy } from "./policy.js";

// =============================================================================
// CONFIG
// =============================================================================
const PORT = parseInt(process.env.PORT || "8080", 10);
// 0.0.0.0 is required by containers and PaaS health checks. On a VM where a
// local reverse proxy is the only intended caller, set HOST=127.0.0.1 so the
// Node port is not reachable from the network at all.
const HOST = process.env.HOST || "0.0.0.0";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
const ALLOW_QUERY_TOKEN = process.env.MCP_ALLOW_QUERY_TOKEN === "true";
const READ_ONLY = process.env.MCP_READ_ONLY === "true";
// Defaults to 0 (trust nothing). A proxy hop must be opted into, because
// trusting X-Forwarded-For when nothing overwrites it lets a client spoof its
// own IP and walk straight past the rate limiters. Platform blueprints that do
// terminate at a proxy (Render, DO App Platform) set this to 1 explicitly.
const TRUST_PROXY = process.env.TRUST_PROXY ?? "0";

const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || "50", 10);
const SESSION_IDLE_MS = parseInt(process.env.SESSION_IDLE_MINUTES || "30", 10) * 60_000;

function csv(name: string): string[] {
  return (process.env[name] || "").split(",").map((s) => s.trim()).filter(Boolean);
}

const ALLOWED_ORIGINS = csv("ALLOWED_ORIGINS");
const ALLOWED_REPOS = csv("ALLOWED_REPOS").map((r) => r.toLowerCase());

if (!GITHUB_TOKEN) {
  console.error("GITHUB_TOKEN is missing!");
  process.exit(1);
}

// This server holds a PAT with read+write on every repo that token can see.
// Without a shared secret in front of it, anyone who learns the URL inherits
// that access, so refuse to start rather than come up unauthenticated.
if (!MCP_AUTH_TOKEN) {
  console.error(
    "MCP_AUTH_TOKEN is missing! Generate one with:\n" +
      "  openssl rand -hex 32\n" +
      "then set it as an environment variable. Clients must send it as\n" +
      "  Authorization: Bearer <token>"
  );
  process.exit(1);
}

if (MCP_AUTH_TOKEN.length < 32) {
  console.error("MCP_AUTH_TOKEN is too short — use at least 32 characters (openssl rand -hex 32).");
  process.exit(1);
}

const auth = requireAuth({
  token: MCP_AUTH_TOKEN,
  allowQueryToken: ALLOW_QUERY_TOKEN,
  allowedOrigins: ALLOWED_ORIGINS,
});

function createServer(): McpServer {
  const server = new McpServer({ name: "github-mcp", version: "1.0.0" });
  registerGitHubTools(
    withPolicy(server, { readOnly: READ_ONLY, allowedRepos: ALLOWED_REPOS }),
    GITHUB_TOKEN!
  );
  return server;
}

// =============================================================================
// APP
// =============================================================================
const app = express();

function parseTrustProxy(v: string): boolean | number | string {
  const t = v.trim().toLowerCase();
  if (t === "" || t === "false") return false;
  if (t === "true") return true; // trusts every hop — only behind a proxy you control
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  return v; // comma-separated IPs/subnets, or a named preset like "loopback"
}

const trustProxy = parseTrustProxy(TRUST_PROXY);
app.set("trust proxy", trustProxy);

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));

// Browser clients get no cross-origin access unless ALLOWED_ORIGINS names them.
// Native and server-side MCP clients send no Origin and are unaffected.
app.use(
  cors({
    origin: ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS : false,
    credentials: false,
    exposedHeaders: ["mcp-session-id"],
    allowedHeaders: ["Content-Type", "Authorization", "mcp-session-id", "mcp-protocol-version"],
  })
);
app.use(express.json({ limit: "4mb" }));

// Counts only responses that failed (4xx/5xx), so a legitimate client hammering
// the server is unaffected while credential guessing is throttled hard.
const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  skipSuccessfulRequests: true,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { jsonrpc: "2.0", error: { code: -32002, message: "Too many failed attempts" }, id: null },
});

// Generous ceiling on normal traffic — an MCP session makes many small calls.
const mcpLimiter = rateLimit({
  windowMs: 60_000,
  limit: parseInt(process.env.RATE_LIMIT_PER_MINUTE || "240", 10),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { jsonrpc: "2.0", error: { code: -32002, message: "Rate limit exceeded" }, id: null },
});

const guard = [authLimiter, mcpLimiter, auth];

// =============================================================================
// SESSIONS
// =============================================================================
interface Session {
  transport: StreamableHTTPServerTransport | SSEServerTransport;
  lastSeen: number;
}
const sessions = new Map<string, Session>();

function touch(id: string): void {
  const s = sessions.get(id);
  if (s) s.lastSeen = Date.now();
}

async function dropSession(id: string): Promise<void> {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  try {
    await s.transport.close?.();
  } catch {
    /* already gone */
  }
}

// An unbounded session map is a memory-exhaustion vector: every initialize call
// allocates a transport that nothing else frees. Evict the stalest session once
// the cap is hit, and sweep idle ones on a timer.
async function admitSession(id: string, transport: Session["transport"]): Promise<void> {
  if (sessions.size >= MAX_SESSIONS) {
    let oldest: string | undefined;
    let oldestSeen = Infinity;
    for (const [sid, s] of sessions) {
      if (s.lastSeen < oldestSeen) {
        oldestSeen = s.lastSeen;
        oldest = sid;
      }
    }
    if (oldest) {
      console.warn(`Session cap (${MAX_SESSIONS}) reached — evicting ${oldest}`);
      await dropSession(oldest);
    }
  }
  sessions.set(id, { transport, lastSeen: Date.now() });
}

const sweeper = setInterval(() => {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const [sid, s] of sessions) {
    if (s.lastSeen < cutoff) {
      console.log(`Sweeping idle session ${sid}`);
      void dropSession(sid);
    }
  }
}, 60_000);
sweeper.unref();

// =============================================================================
// STREAMABLE HTTP TRANSPORT (current protocol — POST/GET/DELETE on /mcp)
// =============================================================================
app.all("/mcp", ...guard, async (req, res) => {
  console.log(`Received ${req.method} request to /mcp`);

  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && sessions.has(sessionId)) {
      const existing = sessions.get(sessionId)!.transport;
      if (!(existing instanceof StreamableHTTPServerTransport)) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Session uses a different transport protocol" },
          id: null,
        });
        return;
      }
      transport = existing;
      touch(sessionId);
    } else if (!sessionId && req.method === "POST" && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          console.log(`StreamableHTTP session initialized: ${sid}`);
          void admitSession(sid, transport);
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          console.log(`Transport closed for session ${sid}`);
          sessions.delete(sid);
        }
      };

      await createServer().connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: No valid session ID provided" },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error handling /mcp request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// =============================================================================
// DEPRECATED SSE TRANSPORT (legacy protocol — GET /sse + POST /message)
// =============================================================================
app.get("/sse", ...guard, async (req, res) => {
  console.log("Received GET request to /sse (deprecated SSE transport)");

  res.setHeader("X-Accel-Buffering", "no");

  // The SDK resolves this against a dummy base and appends sessionId, so a
  // query token survives into the endpoint it advertises. That matters for
  // clients using ?key= — they cannot set a header on the POST callback either.
  const usedQueryToken = ALLOW_QUERY_TOKEN && typeof req.query.key === "string";
  const endpoint = usedQueryToken
    ? `/message?key=${encodeURIComponent(req.query.key as string)}`
    : "/message";

  const transport = new SSEServerTransport(endpoint, res);
  await admitSession(transport.sessionId, transport);

  res.on("close", () => {
    sessions.delete(transport.sessionId);
  });

  await createServer().connect(transport);
});

app.post("/message", ...guard, async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const existing = sessions.get(sessionId)?.transport;

  if (existing instanceof SSEServerTransport) {
    touch(sessionId);
    // express.json() already drained the stream, so hand the parsed body over
    // rather than letting the transport try to re-read it.
    await existing.handlePostMessage(req, res, req.body);
  } else {
    res.status(400).send("No SSE transport found for sessionId");
  }
});

// =============================================================================
// HEALTH / ROOT (public — no secrets, no GitHub access)
// =============================================================================
app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.get("/", (_req, res) => res.send("GitHub MCP Server is Live!"));

// Anything unhandled returns a generic error — no stack traces to clients.
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled error:", err.message);
  if (!res.headersSent) {
    res.status(500).json({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal server error" },
      id: null,
    });
  }
});

// =============================================================================
// STARTUP
// =============================================================================
async function checkGitHubToken(): Promise<void> {
  try {
    const octokit = new Octokit({ auth: GITHUB_TOKEN });
    const me = await octokit.rest.users.getAuthenticated();
    const scopes = me.headers["x-oauth-scopes"];
    console.log(`GitHub token OK — authenticated as ${me.data.login}`);
    if (typeof scopes === "string" && scopes.length > 0) {
      console.log(`GitHub token scopes: ${scopes}`);
      if (scopes.includes("delete_repo") || scopes.includes("admin:org")) {
        console.warn("WARNING: token carries destructive scopes (delete_repo/admin:org) this server does not need.");
      }
    }
  } catch (error) {
    // Non-fatal: GitHub could simply be unreachable at boot. Tools will surface
    // the real error per call.
    console.warn(`WARNING: could not verify GITHUB_TOKEN — ${(error as Error).message}`);
  }
}

const server = app.listen(PORT, HOST, () => {
  console.log(`Server listening on ${HOST}:${PORT}`);
  console.log(`Streamable HTTP: POST/GET/DELETE /mcp`);
  console.log(`Legacy SSE:      GET /sse + POST /message`);
  console.log(`Auth:            Authorization: Bearer <MCP_AUTH_TOKEN>${ALLOW_QUERY_TOKEN ? " (or ?key=)" : ""}`);
  console.log(`Mode:            ${READ_ONLY ? "READ-ONLY (write tools not registered)" : "read + write"}`);
  console.log(`Repos:           ${ALLOWED_REPOS.length > 0 ? ALLOWED_REPOS.join(", ") : "all repos the PAT can see"}`);
  console.log(`CORS origins:    ${ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS.join(", ") : "none (no cross-origin browser access)"}`);
  const xffTrusted = !(trustProxy === false || trustProxy === 0);
  console.log(
    `Trust proxy:     ${JSON.stringify(trustProxy)}` +
      (xffTrusted ? " — X-Forwarded-For is trusted" : " (client IP = socket address; X-Forwarded-For ignored)")
  );
  if (trustProxy === true) {
    console.warn(
      "WARNING: TRUST_PROXY=true trusts every hop. If this server is reachable " +
        "directly, a client can spoof X-Forwarded-For and bypass rate limiting. " +
        "Use the number of proxies in front of you (usually 1) instead."
    );
  }
  void checkGitHubToken();
});

// =============================================================================
// SHUTDOWN
// =============================================================================
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — shutting down...`);

  clearInterval(sweeper);
  server.close();
  await Promise.all([...sessions.keys()].map(dropSession));

  // Don't hang forever on a stuck connection.
  setTimeout(() => process.exit(0), 5_000).unref();
  process.exit(0);
}

// Render and most container platforms send SIGTERM, not SIGINT.
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  void shutdown("uncaughtException");
});
