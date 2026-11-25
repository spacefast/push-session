import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { run } from "../src/cli.js";
import { browserCommand, runWeb } from "../src/web.js";

const adapter = {
  id: "codex",
  label: "Codex",
  aliases: [],
  installed: () => true,
  discover: () => [
    { agent: "codex", id: "old", title: "Older", project: "/work", updatedAt: 1_000 },
    { agent: "codex", id: "new:one", title: "Newer", updatedAt: 2_000 },
  ],
};

async function start(context, argv = [], publish = async () => ({ url: "https://sessions.example/s/1/", visibility: "public", spaceTitle: "AI sessions", redacted: 0 })) {
  const calls = [];
  const logged = [];
  const web = await runWeb(["--no-open", ...argv], {
    publish: (args) => { calls.push(args); return publish(args); },
    dependencies: { adapters: [adapter], env: { PUSH_SESSION_CONFIG: "/nonexistent/config.json", SPACEFAST_HOME: "/nonexistent" }, log: (line) => logged.push(line), resolveAuth: async () => null },
  });
  context.after(() => web.close());
  const url = new URL(web.url);
  const token = url.searchParams.get("t");
  const call = (path, { method = "GET", headers = {}, body } = {}) => fetch(new URL(path, url), { method, headers: { "x-push-session-token": token, ...headers }, body });
  return { web, url, token, calls, logged, call };
}

test("serves the picker and the session list only to requests that carry its token", async (context) => {
  const { url, token, logged, call } = await start(context);
  assert.equal(url.hostname, "127.0.0.1");
  assert.ok(token.length >= 32);
  assert.match(logged[0], /answers only on this machine/);

  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>push-session<\/title>/);
  assert.equal((await fetch(new URL("/", url))).status, 403, "the page needs the token from the printed address");
  assert.equal((await fetch(new URL("/api/sessions", url))).status, 403);
  assert.equal((await call("/api/sessions", { headers: { "x-push-session-token": "wrong" } })).status, 403);

  const sessions = (await (await call("/api/sessions")).json()).sessions;
  assert.deepEqual(sessions.map((session) => [session.key, session.title, session.agentLabel]), [["codex:new:one", "Newer", "Codex"], ["codex:old", "Older", "Codex"]]);
  assert.deepEqual(await (await call("/api/status")).json(), { signedIn: false, space: null });
});

test("refuses a request that reaches it under another host name", async (context) => {
  const { url, token } = await start(context);
  const status = await new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: url.port, path: "/api/sessions", headers: { host: "evil.example", "x-push-session-token": token } }, (response) => resolve(response.statusCode)).on("error", reject);
  });
  assert.equal(status, 403, "a page on another site cannot reach the server by pointing its own name at this machine");
});

test("publishes the chosen session with the chosen visibility and the command's own options", async (context) => {
  const { calls, call } = await start(context, ["--team", "acme", "--no-redact"]);
  const post = (body, headers = { "content-type": "application/json" }) => call("/api/publish", { method: "POST", headers, body: JSON.stringify(body) });

  assert.deepEqual(await (await post({ key: "codex:new:one", visibility: "public" })).json(), { ok: true, url: "https://sessions.example/s/1/", visibility: "public", spaceTitle: "AI sessions", redacted: 0 });
  assert.deepEqual(calls[0], ["codex", "new:one", "--json", "--public", "--team", "acme", "--no-redact"]);

  assert.equal((await (await post({ key: "codex:old", visibility: "everyone" })).json()).ok, false);
  assert.equal((await post({ key: "codex:old", visibility: "private" }, { "content-type": "text/plain" })).status, 415, "a form on another site cannot post here");
  assert.equal(calls.length, 1);

  const failing = await start(context, [], async () => { throw new Error("You're in more than one team."); });
  const answer = await (await failing.call("/api/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "codex:old", visibility: "private" }) })).json();
  assert.deepEqual(answer, { ok: false, error: "You're in more than one team." });
});

test("the web command takes publishing options, not sessions", async () => {
  await assert.rejects(run(["web", "--no-open", "codex"], {}), /chosen in the page/);
  await assert.rejects(run(["web", "--no-open", "--public"], {}), /chosen in the page/);
  await assert.rejects(run(["web", "--port", "abc"], {}), /--port must be a number/);
});

test("the web command answers --help and --version itself, and refuses options a page cannot honour", async () => {
  const printed = [];
  const original = console.log;
  console.log = (text) => printed.push(String(text));
  try {
    await run(["web", "--help"], {});
    await run(["web", "--version"], {});
  } finally {
    console.log = original;
  }
  assert.match(printed[0], /npx push-session web/);
  assert.match(printed[1], /^\d+\.\d+\.\d+/);
  for (const flag of ["--dry-run", "--new-space", "--pick-space"]) {
    await assert.rejects(run(["web", "--no-open", flag], {}), /chosen in the page/);
  }
});

test("a web address is opened without a shell, and nothing else is opened at all", () => {
  // On Windows `cmd` would run what follows an & in the address.
  const address = "https://sessions.example/sessions/x&calc.exe&rem/";
  assert.deepEqual(browserCommand(address, "win32"), ["rundll32", ["url.dll,FileProtocolHandler", address]]);
  assert.deepEqual(browserCommand(address, "darwin"), ["open", [address]]);
  assert.deepEqual(browserCommand("http://127.0.0.1:4173/?token=abc", "linux"), ["xdg-open", ["http://127.0.0.1:4173/?token=abc"]]);
  // A space or a quote would make Node quote the argument; an address carries neither.
  assert.deepEqual(browserCommand('https://sessions.example/a b"c/', "win32")[1][1], "https://sessions.example/a%20b%22c/");
  for (const other of ["file:///etc/passwd", "calc.exe", "", "javascript:alert(1)"]) assert.equal(browserCommand(other, "win32"), null);
});
