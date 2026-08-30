import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Tools that change state on GitHub. In read-only mode these are never
 * registered, so they do not appear in tools/list at all — a client cannot call
 * what it cannot see.
 */
export const MUTATING_TOOLS = new Set([
  "create_repository",
  "create_branch",
  "create_or_update_file",
  "push_files",
  "delete_file",
  "create_pull_request",
  "merge_pull_request",
  "create_issue",
  "update_issue",
  "add_issue_comment",
  "create_release",
]);

/** Tools whose target repo cannot be checked against an allowlist. */
const UNSCOPEABLE_TOOLS = new Set(["create_repository"]);

export interface Policy {
  readOnly: boolean;
  /** Lowercased "owner/repo" entries. Empty means every repo the PAT can see. */
  allowedRepos: string[];
}

function repoDenied(args: unknown, allowed: string[]): string | undefined {
  if (allowed.length === 0) return undefined;
  if (typeof args !== "object" || args === null) return undefined;

  const { owner, repo } = args as { owner?: unknown; repo?: unknown };
  if (typeof owner !== "string" || typeof repo !== "string") return undefined;

  const target = `${owner}/${repo}`.toLowerCase();
  if (allowed.includes(target)) return undefined;

  return `Repository "${owner}/${repo}" is not in ALLOWED_REPOS. This server is restricted to: ${allowed.join(", ")}`;
}

/**
 * Wraps an McpServer so tool registration and tool calls are filtered through
 * the policy. Returns the server unchanged when no policy is configured, so the
 * default path carries no overhead.
 */
export function withPolicy(server: McpServer, policy: Policy): McpServer {
  if (!policy.readOnly && policy.allowedRepos.length === 0) return server;

  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop !== "tool") return Reflect.get(target, prop, receiver);

      return (...args: unknown[]) => {
        const name = args[0] as string;

        if (policy.readOnly && MUTATING_TOOLS.has(name)) return undefined;
        if (policy.allowedRepos.length > 0 && UNSCOPEABLE_TOOLS.has(name)) return undefined;

        const last = args.length - 1;
        const handler = args[last];
        if (typeof handler === "function" && policy.allowedRepos.length > 0) {
          args[last] = async (toolArgs: unknown, ...rest: unknown[]) => {
            const denied = repoDenied(toolArgs, policy.allowedRepos);
            if (denied) {
              return { content: [{ type: "text" as const, text: denied }], isError: true };
            }
            return (handler as (...a: unknown[]) => unknown)(toolArgs, ...rest);
          };
        }

        return (target.tool as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}
