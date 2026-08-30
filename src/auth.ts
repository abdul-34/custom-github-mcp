import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

/**
 * Compares two secrets in constant time. Both sides are hashed first so the
 * comparison operates on fixed-length buffers and the token length does not
 * leak through timingSafeEqual's length check.
 */
export function secretsMatch(expected: string, presented: string): boolean {
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(presented).digest();
  return timingSafeEqual(a, b);
}

/**
 * Pulls the client's token off the request.
 *
 * `Authorization: Bearer <token>` is the supported mechanism. Some MCP clients
 * cannot attach custom headers, so a `?key=<token>` fallback is available when
 * MCP_ALLOW_QUERY_TOKEN is set — see the README for why that is weaker.
 */
export function extractToken(req: Request, allowQueryToken: boolean): string | undefined {
  const header = req.headers.authorization;
  if (header) {
    const [scheme, ...rest] = header.split(" ");
    if (scheme?.toLowerCase() === "bearer" && rest.length > 0) {
      const value = rest.join(" ").trim();
      if (value) return value;
    }
    return undefined;
  }

  if (allowQueryToken) {
    const key = req.query.key;
    if (typeof key === "string" && key.length > 0) return key;
  }

  return undefined;
}

function deny(res: Response, status: number, message: string): void {
  if (status === 401) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="github-mcp"');
  }
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code: -32001, message },
    id: null,
  });
}

export interface AuthOptions {
  token: string;
  allowQueryToken: boolean;
  allowedOrigins: string[];
}

/**
 * Rejects requests that do not present the shared secret, and requests carrying
 * an Origin that is not explicitly allowed. The Origin check is what stops a
 * page in the user's browser from driving this server via DNS rebinding: a
 * non-browser client sends no Origin at all and passes through.
 */
export function requireAuth(opts: AuthOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (origin && !opts.allowedOrigins.includes(origin)) {
      deny(res, 403, "Forbidden: origin not allowed");
      return;
    }

    const presented = extractToken(req, opts.allowQueryToken);
    if (!presented) {
      deny(res, 401, "Unauthorized: missing bearer token");
      return;
    }

    if (!secretsMatch(opts.token, presented)) {
      deny(res, 401, "Unauthorized: invalid bearer token");
      return;
    }

    next();
  };
}
