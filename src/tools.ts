import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Octokit } from "octokit";

export function registerGitHubTools(server: McpServer, token: string): void {
  const octokit = new Octokit({ auth: token });

  /* ── repos ─────────────────────────────────────────────────────── */

  server.tool(
    "list_repos",
    "List repositories for the authenticated user or a specified user/org",
    {
      owner: z.string().optional().describe("Username or org"),
      type: z.enum(["all", "owner", "public", "private", "member"]).optional().default("all"),
      per_page: z.number().optional().default(30),
      page: z.number().optional().default(1),
    },
    async ({ owner, type, per_page, page }) => {
      const r = owner
        ? await octokit.rest.repos.listForUser({ username: owner, type: type as any, per_page, page })
        : await octokit.rest.repos.listForAuthenticatedUser({ type: type as any, per_page, page });
      const repos = r.data.map((x) => ({
        name: x.full_name, description: x.description, private: x.private,
        url: x.html_url, default_branch: x.default_branch, language: x.language, updated_at: x.updated_at,
      }));
      return { content: [{ type: "text" as const, text: JSON.stringify(repos, null, 2) }] };
    }
  );

  server.tool(
    "get_file_contents",
    "Get the contents of a file or directory from a repository",
    { owner: z.string(), repo: z.string(), path: z.string(), ref: z.string().optional() },
    async ({ owner, repo, path, ref }) => {
      const params: any = { owner, repo, path };
      if (ref) params.ref = ref;
      const r = await octokit.rest.repos.getContent(params);
      if (Array.isArray(r.data)) {
        return { content: [{ type: "text" as const, text: JSON.stringify(r.data.map((i) => ({ name: i.name, path: i.path, type: i.type, size: i.size })), null, 2) }] };
      }
      if ("content" in r.data && r.data.encoding === "base64") {
        return { content: [{ type: "text" as const, text: Buffer.from(r.data.content, "base64").toString("utf-8") }] };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(r.data, null, 2) }] };
    }
  );

  server.tool(
    "search_code",
    "Search for code across GitHub repositories",
    { query: z.string(), per_page: z.number().optional().default(10) },
    async ({ query, per_page }) => {
      const r = await octokit.rest.search.code({ q: query, per_page });
      return { content: [{ type: "text" as const, text: JSON.stringify(r.data.items.map((i) => ({ name: i.name, path: i.path, repository: i.repository.full_name, url: i.html_url })), null, 2) }] };
    }
  );

  server.tool(
    "search_repos",
    "Search for repositories on GitHub",
    { query: z.string(), per_page: z.number().optional().default(10) },
    async ({ query, per_page }) => {
      const r = await octokit.rest.search.repos({ q: query, per_page });
      return { content: [{ type: "text" as const, text: JSON.stringify(r.data.items.map((x) => ({ name: x.full_name, description: x.description, stars: x.stargazers_count, url: x.html_url })), null, 2) }] };
    }
  );

  server.tool(
    "create_repository",
    "Create a new GitHub repository",
    {
      name: z.string(),
      description: z.string().optional(),
      private: z.boolean().optional().default(true),
      auto_init: z.boolean().optional().default(true),
    },
    async ({ name, description, private: priv, auto_init }) => {
      const r = await octokit.rest.repos.createForAuthenticatedUser({ name, description, private: priv, auto_init });
      return { content: [{ type: "text" as const, text: JSON.stringify({ name: r.data.full_name, url: r.data.html_url, clone_url: r.data.clone_url, private: r.data.private }, null, 2) }] };
    }
  );

  /* ── branches / commits ────────────────────────────────────────── */

  server.tool(
    "list_branches",
    "List branches in a repository",
    { owner: z.string(), repo: z.string(), per_page: z.number().optional().default(30) },
    async ({ owner, repo, per_page }) => {
      const r = await octokit.rest.repos.listBranches({ owner, repo, per_page });
      return { content: [{ type: "text" as const, text: JSON.stringify(r.data.map((b) => ({ name: b.name, sha: b.commit.sha, protected: b.protected })), null, 2) }] };
    }
  );

  server.tool(
    "list_commits",
    "List commits on a branch",
    { owner: z.string(), repo: z.string(), sha: z.string().optional(), per_page: z.number().optional().default(10) },
    async ({ owner, repo, sha, per_page }) => {
      const params: any = { owner, repo, per_page };
      if (sha) params.sha = sha;
      const r = await octokit.rest.repos.listCommits(params);
      return { content: [{ type: "text" as const, text: JSON.stringify(r.data.map((c) => ({ sha: c.sha, message: c.commit.message, author: c.commit.author?.name, date: c.commit.author?.date })), null, 2) }] };
    }
  );

  server.tool(
    "create_branch",
    "Create a new branch",
    { owner: z.string(), repo: z.string(), branch: z.string(), from_branch: z.string().optional() },
    async ({ owner, repo, branch, from_branch }) => {
      const src = from_branch || (await octokit.rest.repos.get({ owner, repo })).data.default_branch;
      const ref = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${src}` });
      const r = await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: ref.data.object.sha });
      return { content: [{ type: "text" as const, text: JSON.stringify({ ref: r.data.ref, sha: r.data.object.sha }, null, 2) }] };
    }
  );

  /* ── file operations ───────────────────────────────────────────── */

  server.tool(
    "create_or_update_file",
    "Create or update a file in a repository",
    {
      owner: z.string(), repo: z.string(), path: z.string(), content: z.string(),
      message: z.string(), branch: z.string().optional(), sha: z.string().optional(),
    },
    async ({ owner, repo, path, content, message, branch, sha }) => {
      const params: any = { owner, repo, path, message, content: Buffer.from(content).toString("base64") };
      if (branch) params.branch = branch;
      if (sha) params.sha = sha;
      const r = await octokit.rest.repos.createOrUpdateFileContents(params);
      return { content: [{ type: "text" as const, text: JSON.stringify({ commit_sha: r.data.commit.sha, url: r.data.content?.html_url }, null, 2) }] };
    }
  );

  server.tool(
    "push_files",
    "Push multiple files in a single commit",
    {
      owner: z.string(), repo: z.string(), branch: z.string(), message: z.string(),
      files: z.array(z.object({ path: z.string(), content: z.string() })),
    },
    async ({ owner, repo, branch, message, files }) => {
      const ref = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
      const latestSha = ref.data.object.sha;
      const commit = await octokit.rest.git.getCommit({ owner, repo, commit_sha: latestSha });
      const blobs = await Promise.all(
        files.map(async (f: { path: string; content: string }) => {
          const blob = await octokit.rest.git.createBlob({ owner, repo, content: Buffer.from(f.content).toString("base64"), encoding: "base64" });
          return { path: f.path, mode: "100644" as const, type: "blob" as const, sha: blob.data.sha };
        })
      );
      const tree = await octokit.rest.git.createTree({ owner, repo, base_tree: commit.data.tree.sha, tree: blobs });
      const newCommit = await octokit.rest.git.createCommit({ owner, repo, message, tree: tree.data.sha, parents: [latestSha] });
      await octokit.rest.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: newCommit.data.sha });
      return { content: [{ type: "text" as const, text: JSON.stringify({ commit_sha: newCommit.data.sha, files_pushed: files.length }, null, 2) }] };
    }
  );

  server.tool(
    "delete_file",
    "Delete a file from a repository",
    { owner: z.string(), repo: z.string(), path: z.string(), message: z.string(), branch: z.string(), sha: z.string() },
    async ({ owner, repo, path, message, branch, sha }) => {
      const r = await octokit.rest.repos.deleteFile({ owner, repo, path, message, branch, sha });
      return { content: [{ type: "text" as const, text: JSON.stringify({ commit_sha: r.data.commit.sha }, null, 2) }] };
    }
  );

  /* ── pull requests ─────────────────────────────────────────────── */

  server.tool(
    "list_pull_requests",
    "List pull requests in a repository",
    { owner: z.string(), repo: z.string(), state: z.enum(["open", "closed", "all"]).optional().default("open"), per_page: z.number().optional().default(10) },
    async ({ owner, repo, state, per_page }) => {
      const r = await octokit.rest.pulls.list({ owner, repo, state, per_page });
      return { content: [{ type: "text" as const, text: JSON.stringify(r.data.map((pr) => ({ number: pr.number, title: pr.title, state: pr.state, author: pr.user?.login, url: pr.html_url })), null, 2) }] };
    }
  );

  server.tool(
    "create_pull_request",
    "Create a new pull request",
    { owner: z.string(), repo: z.string(), title: z.string(), body: z.string().optional(), head: z.string(), base: z.string(), draft: z.boolean().optional().default(false) },
    async ({ owner, repo, title, body, head, base, draft }) => {
      const r = await octokit.rest.pulls.create({ owner, repo, title, body, head, base, draft });
      return { content: [{ type: "text" as const, text: JSON.stringify({ number: r.data.number, title: r.data.title, url: r.data.html_url }, null, 2) }] };
    }
  );

  server.tool(
    "merge_pull_request",
    "Merge a pull request",
    { owner: z.string(), repo: z.string(), pull_number: z.number(), merge_method: z.enum(["merge", "squash", "rebase"]).optional().default("merge") },
    async ({ owner, repo, pull_number, merge_method }) => {
      const r = await octokit.rest.pulls.merge({ owner, repo, pull_number, merge_method });
      return { content: [{ type: "text" as const, text: JSON.stringify({ merged: r.data.merged, sha: r.data.sha }, null, 2) }] };
    }
  );

  server.tool(
    "get_pull_request_diff",
    "Get files changed in a pull request",
    { owner: z.string(), repo: z.string(), pull_number: z.number() },
    async ({ owner, repo, pull_number }) => {
      const r = await octokit.rest.pulls.listFiles({ owner, repo, pull_number });
      return { content: [{ type: "text" as const, text: JSON.stringify(r.data.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch?.substring(0, 2000) })), null, 2) }] };
    }
  );

  /* ── issues ────────────────────────────────────────────────────── */

  server.tool(
    "list_issues",
    "List issues in a repository",
    { owner: z.string(), repo: z.string(), state: z.enum(["open", "closed", "all"]).optional().default("open"), per_page: z.number().optional().default(10) },
    async ({ owner, repo, state, per_page }) => {
      const r = await octokit.rest.issues.listForRepo({ owner, repo, state, per_page });
      return { content: [{ type: "text" as const, text: JSON.stringify(r.data.filter((i) => !i.pull_request).map((i) => ({ number: i.number, title: i.title, state: i.state, author: i.user?.login, url: i.html_url })), null, 2) }] };
    }
  );

  server.tool(
    "create_issue",
    "Create a new issue",
    { owner: z.string(), repo: z.string(), title: z.string(), body: z.string().optional(), labels: z.array(z.string()).optional(), assignees: z.array(z.string()).optional() },
    async ({ owner, repo, title, body, labels, assignees }) => {
      const r = await octokit.rest.issues.create({ owner, repo, title, body, labels, assignees });
      return { content: [{ type: "text" as const, text: JSON.stringify({ number: r.data.number, title: r.data.title, url: r.data.html_url }, null, 2) }] };
    }
  );

  server.tool(
    "update_issue",
    "Update an existing issue",
    { owner: z.string(), repo: z.string(), issue_number: z.number(), title: z.string().optional(), body: z.string().optional(), state: z.enum(["open", "closed"]).optional(), labels: z.array(z.string()).optional() },
    async ({ owner, repo, issue_number, title, body, state, labels }) => {
      const params: any = { owner, repo, issue_number };
      if (title) params.title = title;
      if (body) params.body = body;
      if (state) params.state = state;
      if (labels) params.labels = labels;
      const r = await octokit.rest.issues.update(params);
      return { content: [{ type: "text" as const, text: JSON.stringify({ number: r.data.number, state: r.data.state, url: r.data.html_url }, null, 2) }] };
    }
  );

  server.tool(
    "add_issue_comment",
    "Add a comment to an issue or PR",
    { owner: z.string(), repo: z.string(), issue_number: z.number(), body: z.string() },
    async ({ owner, repo, issue_number, body }) => {
      const r = await octokit.rest.issues.createComment({ owner, repo, issue_number, body });
      return { content: [{ type: "text" as const, text: JSON.stringify({ id: r.data.id, url: r.data.html_url }, null, 2) }] };
    }
  );

  /* ── releases / user ───────────────────────────────────────────── */

  server.tool(
    "create_release",
    "Create a new release",
    { owner: z.string(), repo: z.string(), tag_name: z.string(), name: z.string().optional(), body: z.string().optional(), draft: z.boolean().optional().default(false), prerelease: z.boolean().optional().default(false) },
    async ({ owner, repo, tag_name, name, body, draft, prerelease }) => {
      const params: any = { owner, repo, tag_name, draft, prerelease };
      if (name) params.name = name;
      if (body) params.body = body;
      const r = await octokit.rest.repos.createRelease(params);
      return { content: [{ type: "text" as const, text: JSON.stringify({ id: r.data.id, tag: r.data.tag_name, url: r.data.html_url }, null, 2) }] };
    }
  );

  server.tool(
    "get_authenticated_user",
    "Get info about the authenticated GitHub user",
    {},
    async () => {
      const r = await octokit.rest.users.getAuthenticated();
      return { content: [{ type: "text" as const, text: JSON.stringify({ login: r.data.login, name: r.data.name, email: r.data.email, public_repos: r.data.public_repos, url: r.data.html_url }, null, 2) }] };
    }
  );

  server.tool(
    "search_issues",
    "Search for issues and PRs across GitHub",
    { query: z.string(), per_page: z.number().optional().default(10) },
    async ({ query, per_page }) => {
      const r = await octokit.rest.search.issuesAndPullRequests({ q: query, per_page });
      return { content: [{ type: "text" as const, text: JSON.stringify(r.data.items.map((i) => ({ number: i.number, title: i.title, state: i.state, type: i.pull_request ? "pr" : "issue", url: i.html_url })), null, 2) }] };
    }
  );
}
