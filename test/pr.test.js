import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { formatSessionMarkdown, run } from "../src/cli.js";
import { resolvePullRequest, upsertSessionComment } from "../src/pr.js";

const pullUrl = "https://github.com/owner/repo/pull/42";
const marker = "<!-- push-session:session-one -->";

test("gh resolves the current branch, explicit number, and URL with repository visibility", async () => {
  for (const ref of [true, "42", pullUrl]) {
    const github = fakeGithub();
    const result = await resolvePullRequest({ cwd: "/work/repo", ref, execImpl: github.exec, env: {} });
    assert.deepEqual(result, { repo: "owner/repo", number: 42, url: pullUrl, isPrivate: true });
    const command = github.commands.find(({ args }) => args[0] === "pr");
    assert.deepEqual(command.args, ["pr", "view", ...(ref === true ? [] : [ref]), "--json", "number,url,state"]);
    assert.equal(command.options.cwd, "/work/repo");
  }
});

test("token fallback resolves a branch via HTTPS and SSH origin remotes", async () => {
  for (const remote of ["https://github.com/owner/repo.git", "git@github.com:owner/repo.git", "ssh://git@github.com/owner/repo.git"]) {
    const requests = [];
    const result = await resolvePullRequest({
      cwd: "/work/repo", env: { GITHUB_TOKEN: "token" },
      execImpl: async (command, args, options) => {
        if (command === "gh") return noGh();
        assert.equal(command, "git");
        assert.equal(options.cwd, "/work/repo");
        if (args[0] === "remote") return { stdout: `${remote}\n` };
        assert.deepEqual(args, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
        return { stdout: "feature/session\n" };
      },
      fetchImpl: async (url, init) => {
        requests.push(String(url));
        assert.equal(init.headers.authorization, "Bearer token");
        if (new URL(url).pathname.endsWith("/pulls")) {
          assert.equal(new URL(url).searchParams.get("head"), "owner:feature/session");
          assert.equal(new URL(url).searchParams.get("state"), "open");
          return jsonResponse([{ state: "open", html_url: pullUrl }]);
        }
        return jsonResponse({ private: false });
      },
    });
    assert.equal(result.isPrivate, false);
    assert.equal(result.number, 42);
    assert.equal(requests.length, 2);
  }
});

test("token fallback resolves a URL without git and a number using origin", async () => {
  for (const ref of [pullUrl, "42"]) {
    let gitCalls = 0;
    const result = await resolvePullRequest({
      ref, env: { GITHUB_TOKEN: "token" },
      execImpl: async (command, args) => {
        if (command === "gh") return noGh();
        gitCalls += 1;
        assert.deepEqual(args, ["remote", "get-url", "origin"]);
        return { stdout: "git@github.com:owner/repo.git\n" };
      },
      fetchImpl: async (url) => jsonResponse(String(url).endsWith("/pulls/42")
        ? { state: "open", html_url: pullUrl } : { private: true }),
    });
    assert.equal(result.url, pullUrl);
    assert.equal(gitCalls, ref === pullUrl ? 0 : 1);
  }
});

test("branch fallback refuses missing or ambiguous open PRs", async () => {
  for (const pulls of [[], [{}, {}]]) {
    await assert.rejects(resolvePullRequest({
      env: { GITHUB_TOKEN: "token" },
      execImpl: async (command, args) => command === "gh" ? noGh()
        : { stdout: args[0] === "remote" ? "git@github.com:owner/repo.git" : "feature" },
      fetchImpl: async () => jsonResponse(pulls),
    }), /exactly one open pull request/);
  }
});

test("resolution rejects closed PRs and unknown repository visibility", async () => {
  await assert.rejects(resolvePullRequest({ execImpl: fakeGithub({ state: "CLOSED" }).exec, env: {} }), /not open/);
  await assert.rejects(resolvePullRequest({ execImpl: fakeGithub({ isPrivate: null }).exec, env: {} }), /whether.*public/);
  await assert.rejects(resolvePullRequest({
    ref: pullUrl, execImpl: noGh, env: { GITHUB_TOKEN: "token" },
    fetchImpl: async () => jsonResponse({ state: "closed", html_url: pullUrl }),
  }), /not open/);
});

test("gh creates then updates exactly one marked session comment", async () => {
  const github = fakeGithub();
  const input = { repo: "owner/repo", number: 42, marker, execImpl: github.exec, env: {} };
  assert.equal((await upsertSessionComment({ ...input, body: "First link" })).action, "created");
  assert.equal((await upsertSessionComment({ ...input, body: "Updated link" })).action, "updated");
  assert.equal(github.comments.length, 1);
  assert.equal(github.comments[0].body, `${marker}\nUpdated link`);
  assert.deepEqual(github.writes.map(({ method }) => method), ["POST", "PATCH"]);
  assert.equal(github.writes[1].endpoint, "repos/owner/repo/issues/comments/7");
});

test("token upsert searches all comment pages and only updates an exact marker line", async () => {
  const requests = [];
  const body = "[View](https://sessions.example/link)";
  const result = await upsertSessionComment({
    repo: "owner/repo", number: 42, marker, body, env: { GITHUB_TOKEN: "token" }, execImpl: noGh,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      assert.equal(init.headers.authorization, "Bearer token");
      if (String(url).endsWith("page=1")) return jsonResponse(Array.from({ length: 100 }, (_, id) => ({ id, body: `Example: ${marker}` })));
      if (String(url).endsWith("page=2")) return jsonResponse([{ id: 123, body: `${marker}\r\nOld body` }]);
      assert.equal(init.method, "PATCH");
      assert.equal(String(url), "https://api.github.com/repos/owner/repo/issues/comments/123");
      assert.deepEqual(JSON.parse(init.body), { body: `${marker}\n${body}` });
      return jsonResponse({ html_url: `${pullUrl}#issuecomment-123` });
    },
  });
  assert.equal(result.action, "updated");
  assert.equal(requests.length, 3);
});

test("token upsert creates a comment and reports API failures without leaking credentials", async () => {
  const input = { repo: "owner/repo", number: 42, marker, body: "Session", env: { GITHUB_TOKEN: "secret-token" }, execImpl: noGh };
  const result = await upsertSessionComment({
    ...input,
    fetchImpl: async (url, init) => {
      if (init.method === "GET") return jsonResponse([]);
      assert.equal(init.method, "POST");
      assert.equal(String(url), "https://api.github.com/repos/owner/repo/issues/42/comments");
      return jsonResponse({ html_url: `${pullUrl}#issuecomment-1` });
    },
  });
  assert.equal(result.action, "created");
  await assert.rejects(upsertSessionComment({ ...input, fetchImpl: async () => jsonResponse({ message: "secret-token" }, 403) }),
    (error) => /403/.test(error.message) && !error.message.includes("secret-token"));
});

test("markdown includes escaped title, agent, message count and only the scoped share link", () => {
  const result = formatSessionMarkdown({ title: "Fix [router]\n<script>@team</script>", agent: "claude", messages: 2, url: "https://sessions.example/share" });
  assert.match(result, /^### Agent session\n/);
  assert.ok(result.includes("Fix \\[router\\] \\<script\\>\\@team\\</script\\>"));
  assert.match(result, /Agent: claude · 2 messages/);
  assert.match(result, /\[View the agent session\]\(<https:\/\/sessions.example\/share>\)/);
});

test("CLI publishes then creates and updates one private PR comment", async (context) => {
  const fixture = cliFixture(context);
  const first = await run(["claude", "session-one", "--pr", "--json"], fixture.dependencies);
  const second = await run(["claude", "session-one", "--pr", "--format", "json"], fixture.dependencies);
  assert.equal(first.pr.action, "created");
  assert.equal(second.pr.action, "updated");
  assert.equal(fixture.github.comments.length, 1);
  assert.match(fixture.github.comments[0].body, /share-2/);
  assert.doesNotMatch(fixture.github.comments[0].body, /claim-secret|claim\.example|version\.example|landing\.example/);
  assert.equal(fixture.confirmations.length, 0);
  assert.equal(fixture.warnings.length, 0);
  assert.equal(fixture.logs.length, 2);
  assert.equal(JSON.parse(fixture.logs[1]).pr.action, "updated");
});

test("CLI prints pasteable markdown when neither gh nor a token is available", async (context) => {
  const fixture = cliFixture(context);
  fixture.dependencies.execImpl = noGh;
  const result = await run(["claude", "session-one", "--pr"], fixture.dependencies);
  assert.equal(result.url, "https://sessions.example/share-1");
  assert.equal(result.pr.action, "skipped");
  assert.match(fixture.warnings[0], /Session published.*Install and sign in to gh, or set GITHUB_TOKEN/);
  assert.equal(fixture.logs[0], result.markdown);
  assert.match(result.markdown, /View the agent session/);
});

test("CLI keeps JSON valid on comment failure and supplies fallback markdown", async (context) => {
  const fixture = cliFixture(context, { failWrite: true });
  const result = await run(["claude", "session-one", "--pr", "--json"], fixture.dependencies);
  assert.equal(result.pr.action, "skipped");
  assert.equal(fixture.logs.length, 1);
  assert.equal(JSON.parse(fixture.logs[0]).markdown, result.markdown);
  assert.match(fixture.warnings[0], /Session published.*GitHub CLI request failed/);
  assert.doesNotMatch(fixture.warnings[0], /secret/);
});

test("CLI requires consent for public repositories and treats cancellation as a skipped comment", async (context) => {
  for (const consent of [false, true, Symbol("cancel")]) {
    const fixture = cliFixture(context, { isPrivate: false, consent });
    fixture.dependencies.interactive = true;
    const result = await run(["claude", "session-one", "--pr"], fixture.dependencies);
    assert.equal(fixture.confirmations.length, 1);
    assert.equal(fixture.confirmations[0].initialValue, false);
    assert.match(fixture.confirmations[0].message, /Anyone.*public PR/);
    assert.equal(fixture.github.writes.length, consent === true ? 1 : 0);
    assert.equal(result.pr.action, consent === true ? "created" : "skipped");
  }
});

test("CLI public PRs require --yes without a terminal; --yes skips only PR consent", async (context) => {
  for (const yes of [false, true]) {
    const fixture = cliFixture(context, { isPrivate: false });
    const result = await run(["claude", "session-one", "--pr", "--json", ...(yes ? ["--yes"] : [])], fixture.dependencies);
    assert.equal(result.pr.action, yes ? "created" : "skipped");
    assert.equal(fixture.github.writes.length, yes ? 1 : 0);
    assert.equal(fixture.confirmations.length, 0);
    if (!yes) assert.match(fixture.warnings[0], /requires --yes/);
  }
});

test("CLI refuses to post with unknown visibility even with --yes", async (context) => {
  const fixture = cliFixture(context, { isPrivate: null });
  const result = await run(["claude", "session-one", "--pr", "--yes", "--json"], fixture.dependencies);
  assert.equal(result.pr.action, "skipped");
  assert.equal(fixture.github.writes.length, 0);
});

test("markdown output works without GitHub and dry-run never contacts GitHub", async (context) => {
  const fixture = cliFixture(context);
  await run(["claude", "session-one", "--format", "markdown"], fixture.dependencies);
  assert.match(fixture.logs[0], /Agent: claude · 1 message\n/);
  assert.equal(fixture.github.commands.length, 0);
  const dryRun = await run(["claude", "session-one", "--pr", "--yes", "--dry-run", "--json"], fixture.dependencies);
  assert.equal(dryRun.dryRun, true);
  assert.equal(fixture.github.commands.length, 0);
  assert.equal(fixture.publishCount(), 1);
});

test("a failed publish never attempts a PR comment", async (context) => {
  const fixture = cliFixture(context);
  fixture.dependencies.fetchImpl = async () => jsonResponse({ message: "Publish failed" }, 500);
  await assert.rejects(run(["claude", "session-one", "--pr", "--yes"], fixture.dependencies), /Publish failed/);
  assert.equal(fixture.github.commands.length, 0);
});

function noGh() {
  throw Object.assign(new Error("gh missing"), { code: "ENOENT" });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeGithub({ isPrivate = true, state = "OPEN", failWrite = false } = {}) {
  const commands = [];
  const comments = [];
  const writes = [];
  return {
    commands, comments, writes,
    async exec(command, args, options) {
      commands.push({ command, args, options });
      assert.equal(command, "gh");
      if (args[0] === "--version") return { stdout: "gh version" };
      if (args[0] === "pr") return { stdout: JSON.stringify({ number: 42, url: pullUrl, state }) };
      assert.deepEqual(args.slice(0, 3), ["api", "--hostname", "github.com"]);
      const endpoint = args[3];
      const method = args[5];
      if (endpoint === "repos/owner/repo") return { stdout: JSON.stringify({ private: isPrivate }) };
      if (method === "GET") return { stdout: JSON.stringify(comments) };
      if (failWrite) throw new Error("secret comment body");
      assert.equal(args[6], "--raw-field");
      const body = args[7].slice("body=".length);
      writes.push({ endpoint, method, body });
      const comment = { id: 7, body, html_url: `${pullUrl}#issuecomment-7` };
      if (method === "POST") comments.push(comment);
      else comments[0] = comment;
      return { stdout: JSON.stringify(comment) };
    },
  };
}

function cliFixture(context, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "push-session-pr-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const github = fakeGithub(options);
  const logs = [];
  const warnings = [];
  const confirmations = [];
  const quiet = () => {};
  let publishes = 0;
  return {
    github, logs, warnings, confirmations, publishCount: () => publishes,
    dependencies: {
      env: { PUSH_SESSION_CONFIG: path.join(root, "config.json") },
      interactive: false,
      adapters: [{
        id: "claude", label: "Claude Code", installed: () => true,
        discover: () => [{ id: "session-one", title: "Fix the router", agent: "claude", agentLabel: "Claude Code" }],
        load: () => [{ role: "assistant", content: "Done" }],
      }],
      discoverSessionArtifacts: async () => [],
      resolveAuth: async () => null,
      execImpl: github.exec,
      log: (message) => logs.push(message),
      write: (message) => logs.push(message),
      warn: (message) => warnings.push(message),
      prompts: {
        intro: quiet, outro: quiet, note: quiet, log: { info: quiet },
        spinner: () => ({ start: quiet, stop: quiet, error: quiet }),
        isCancel: (value) => typeof value === "symbol",
        confirm: async (prompt) => { confirmations.push(prompt); return options.consent; },
      },
      fetchImpl: async (url) => {
        const pathname = new URL(url).pathname;
        if (pathname === "/v1/spaces/spc_pr/access") return jsonResponse({ data: [] });
        if (pathname === "/v1/spaces/spc_pr/share-links") return jsonResponse({ data: { url: `https://sessions.example/share-${publishes}` } });
        assert.equal(pathname, "/v1/publish");
        publishes += 1;
        return jsonResponse({ data: {
          space: { id: "spc_pr", liveUrl: "https://landing.example/" },
          claim: { key: "claim-secret", claimUrl: "https://claim.example/secret" },
          version: { immutableUrl: "https://version.example/" },
          next: { action: "done" },
        } });
      },
    },
  };
}

test("text output names the PR comment it created or updated", async () => {
  const { formatShareLinks } = await import("../src/cli.js");
  const text = formatShareLinks({
    title: "Demo",
    url: "https://sessions.example/s/1",
    pr: { action: "updated", commentUrl: "https://github.com/o/r/pull/1#issuecomment-2" },
  });
  assert.match(text, /PR comment \(updated\)/);
  assert.match(text, /issuecomment-2/);
});
