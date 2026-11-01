import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { formatShareLinks, run } from "../src/cli.js";
import { loadConfig, saveConfig } from "../src/config.js";

test("prints each share URL on its own unbroken output line", () => {
  const accessUrl = "https://sessions.example/sessions/session-id?__=access-token";
  const versionUrl = "https://v2.sessions.example/";
  const output = formatShareLinks({
    url: accessUrl,
    versionUrl,
    claimUrl: "https://claim.example/one",
    claimExpiresAt: "2026-08-20T00:00:00Z",
  });

  assert.equal(output.split("\n").filter((line) => line.includes(accessUrl)).length, 1);
  assert.equal(output.split("\n").filter((line) => line.includes(versionUrl)).length, 1);
  assert.match(output, /Link\n/);
});

test("explicit session lookup checks every matching ID despite the picker limit", async () => {
  const adapter = fakeAdapter();
  const first = adapter.discover()[0];
  adapter.discover = ({ limit }) => limit === Infinity
    ? [first, { ...first, id: "session-two" }]
    : [first];
  await assert.rejects(run(["codex", "session", "--limit", "1", "--dry-run", "--json"], {
    adapters: [adapter],
  }), /ambiguous \(2 matches\)/);
});

test("one searchable picker lists every agent's sessions newest first", async () => {
  const codex = fakeAdapter("codex");
  codex.discover = () => [{ agent: "codex", agentLabel: "Codex", id: "codex-old", title: "Fix the router", project: "/work/api", updatedAt: 1_000 }];
  const claude = fakeAdapter("claude");
  claude.discover = () => [{ agent: "claude", agentLabel: "Claude Code", id: "claude-new", title: "Draft the launch post", updatedAt: 2_000 }];
  const prompts = fakePrompts([0]);

  const result = await run(["--dry-run"], { adapters: [codex, claude], prompts, interactive: true, log: () => {} });

  const [picker] = prompts.asked;
  assert.deepEqual(picker.options.filter((option) => typeof option.value === "number").map((option) => option.label), ["Draft the launch post", "Fix the router"]);
  assert.match(picker.options[1].hint, /^Codex · .* · \/work\/api · codex-old$/);
  assert.deepEqual(picker.options.filter((option) => typeof option.value === "number" && picker.filter("codex api", option)).map((option) => option.label), ["Fix the router"]);
  assert.equal(result.sessionId, "claude-new");
});

test("picker pages across all sessions and searches beyond the page limit", async () => {
  const adapter = fakeAdapter();
  const first = adapter.discover()[0];
  adapter.discover = ({ limit } = {}) => Array.from({ length: 5 }, (_, index) => ({
    ...first, id: `session-${index}`, title: `Session ${index}`, updatedAt: 5 - index,
  })).slice(0, limit);
  const prompts = fakePrompts(["next", "previous", "search", "Session 4", "clear", "next", "next", 0]);
  const result = await run(["codex", "--limit", "2", "--dry-run"], {
    adapters: [adapter], prompts, interactive: true, log: () => {},
  });
  assert.equal(result.sessionId, "session-4");
  const pickers = prompts.asked.filter((prompt) => prompt.options);
  assert.deepEqual(pickers[1].options.filter((item) => typeof item.value === "number").map((item) => item.label), ["Session 2", "Session 3"]);
  assert.deepEqual(pickers[2].options.filter((item) => typeof item.value === "number").map((item) => item.label), ["Session 0", "Session 1"]);
  assert.equal(pickers[3].options[0].label, "Session 4");
  assert.equal(pickers.at(-1).options.some((item) => item.value === "next"), false);
});

test("reuses the first global session space on later runs", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "push-session-global-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { PUSH_SESSION_CONFIG: path.join(root, "config.json"), SPACEFAST_HOME: root };
  const projectStateBefore = fs.existsSync(path.join(process.cwd(), ".spacefast"));
  const publishPayloads = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith("/share-links")) {
      return jsonResponse(201, { data: { url: "https://sessions.example/__/access" } });
    }
    const payload = JSON.parse(init.body.get("payload"));
    publishPayloads.push(payload);
    return jsonResponse(201, {
      data: {
        space: { id: "spc_global", liveUrl: "https://sessions.example/" },
        claim: { key: "global-claim", claimUrl: "https://claim.example/global" },
        next: { action: "done" },
      },
    });
  };
  const dependencies = { adapters: [fakeAdapter()], env, fetchImpl, log: () => {}, warn: () => {} };

  await run(["codex", "session-one", "--json"], dependencies);
  await run(["codex", "session-one", "--json"], dependencies);

  assert.equal(publishPayloads[0].space?.title, "Shared AI sessions");
  assert.equal(publishPayloads[1].spaceId, "spc_global");
  assert.equal(loadConfig(env).space.id, "spc_global");
  assert.equal(fs.existsSync(path.join(process.cwd(), ".spacefast")), projectStateBefore);
});

test("replaces rejected implicit global state without blocking the publish", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "push-session-fallback-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { PUSH_SESSION_CONFIG: path.join(root, "config.json"), SPACEFAST_HOME: root };
  saveConfig({ version: 1, space: { id: "spc_stale", claimToken: "stale-key" } }, env);
  const warnings = [];
  const publishPayloads = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith("/share-links")) {
      return jsonResponse(201, { data: { url: "https://sessions.example/__/new-access" } });
    }
    const payload = JSON.parse(init.body.get("payload"));
    publishPayloads.push(payload);
    if (payload.spaceId === "spc_stale") {
      return jsonResponse(401, { code: "invalid_credential", message: "Expired" });
    }
    return jsonResponse(201, {
      data: {
        space: { id: "spc_replacement", liveUrl: "https://sessions.example/" },
        claim: { key: "replacement-key", claimUrl: "https://claim.example/replacement" },
        next: { action: "done" },
      },
    });
  };

  const result = await run(["codex", "session-one", "--json"], {
    adapters: [fakeAdapter()],
    env,
    fetchImpl,
    log: () => {},
    warn: (message) => warnings.push(message),
  });

  assert.equal(result.spaceId, "spc_replacement");
  assert.deepEqual(publishPayloads.map((payload) => payload.spaceId || null), ["spc_stale", null]);
  assert.equal(loadConfig(env).space.id, "spc_replacement");
  assert.equal(loadConfig(env).space.claimToken, "replacement-key");
  assert.match(warnings[0], /no longer reusable/);
});

test("alternate API publishes and unreadable config keep the saved anonymous space", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "push-session-one-off-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { PUSH_SESSION_CONFIG: path.join(root, "config.json"), SPACEFAST_HOME: root };
  saveConfig({ version: 1, space: { id: "spc_global", claimToken: "global-key" } }, env);
  const requests = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith("/share-links")) return jsonResponse(201, { data: { url: "https://sessions.example/private" } });
    requests.push({ url: String(url), payload: JSON.parse(init.body.get("payload")) });
    return jsonResponse(201, {
      data: {
        space: { id: "spc_alt", liveUrl: "https://sessions.example/" },
        claim: { key: "new-key" },
        next: { action: "done" },
      },
    });
  };
  const dependencies = { adapters: [fakeAdapter()], env, fetchImpl, log: () => {} };
  await run(["codex", "session-one", "--json", "--api-url", "https://alternate.example/"], dependencies);

  assert.equal(requests[0].url, "https://alternate.example/v1/publish?wait=1");
  assert.equal(requests[0].payload.spaceId, undefined);
  assert.deepEqual(loadConfig(env).space, { id: "spc_global", claimToken: "global-key" });

  const unreadable = '{"space":{"id":"spc_global","accessToken":"saved-key"},"apiUrl":"file:///invalid"}';
  fs.writeFileSync(env.PUSH_SESSION_CONFIG, unreadable);
  const warnings = [];
  await run(["codex", "session-one", "--json"], { ...dependencies, warn: (message) => warnings.push(message) });
  assert.equal(fs.readFileSync(env.PUSH_SESSION_CONFIG, "utf8"), unreadable);
  assert.match(warnings[0], /config\.json/);
});

test("signed in, the first pick becomes the default Space and --pick-space replaces it", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "push-session-owned-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { PUSH_SESSION_CONFIG: path.join(root, "config.json"), SPACEFAST_HOME: root };
  fs.writeFileSync(path.join(root, "auth.json"), JSON.stringify({
    accessToken: "sf-login-token",
    apiUrl: "https://api.spacefast.com",
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  }));
  const api = fakeOwnedApi([
    { id: "spc_notes", title: "Team notes", slug: "team-notes", liveUrl: "https://team-notes.space.fast/" },
    { id: "spc_demo", title: "Demo", slug: "demo", liveUrl: "https://demo.space.fast/" },
  ]);
  const prompts = fakePrompts(["spc_notes", "spc_demo"]);
  const output = [];
  const dependencies = { adapters: [fakeAdapter()], env, fetchImpl: api.fetch, prompts, interactive: true, log: () => {}, write: (text) => output.push(text) };

  const first = await run(["codex", "session-one"], dependencies);
  const second = await run(["codex", "session-one"], dependencies);
  const repicked = await run(["codex", "session-one", "--pick-space"], dependencies);

  assert.equal(prompts.asked.length, 2);
  assert.match(prompts.asked[0].options[0].label, /New Space · AI sessions/);
  assert.deepEqual([first, second, repicked].map((result) => result.spaceId), ["spc_notes", "spc_notes", "spc_demo"]);
  assert.ok(api.publishes.every((publish) => publish.authorization === "Bearer sf-login-token"));
  assert.equal(second.spaceTitle, "Team notes");
  assert.match(output[1], /Space\n.*Team notes/);
  assert.doesNotMatch(output[1], /Claim/);
  assert.deepEqual(loadConfig(env).owned["https://api.spacefast.com"], {
    id: "spc_demo",
    title: "Demo",
    liveUrl: "https://demo.space.fast/",
  });
  assert.equal(JSON.stringify(loadConfig(env)).includes("sf-login-token"), false);
});

test("--space publishes once without moving the saved default Space", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "push-session-space-once-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { PUSH_SESSION_CONFIG: path.join(root, "config.json"), SPACEFAST_HOME: root, SPACEFAST_TOKEN: "owned-token" };
  saveConfig({ version: 1, owned: { "https://api.spacefast.com": { id: "spc_default", title: "AI sessions" } } }, env);
  const api = fakeOwnedApi([]);
  const dependencies = { adapters: [fakeAdapter()], env, fetchImpl: api.fetch, log: () => {} };

  await run(["codex", "session-one", "--json", "--space", "spc_other"], dependencies);
  await run(["codex", "session-one", "--json"], dependencies);

  assert.deepEqual(api.publishes.map((publish) => publish.payload.spaceId), ["spc_other", "spc_default"]);
  assert.equal(loadConfig(env).owned["https://api.spacefast.com"].id, "spc_default");
});

test("without a terminal, signed-in publishing reuses the AI sessions Space or creates a private one", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "push-session-headless-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const reuseEnv = { PUSH_SESSION_CONFIG: path.join(root, "reuse.json"), SPACEFAST_HOME: root, SPACEFAST_TOKEN: "owned-token" };
  const createEnv = { ...reuseEnv, PUSH_SESSION_CONFIG: path.join(root, "create.json") };
  const reuseApi = fakeOwnedApi([
    { id: "spc_close", title: "AI sessions archive" },
    { id: "spc_ai", title: "AI sessions", liveUrl: "https://ai-sessions.space.fast/" },
  ]);
  const createApi = fakeOwnedApi([{ id: "spc_close", title: "AI sessions archive" }]);

  await run(["codex", "session-one", "--json"], { adapters: [fakeAdapter()], env: reuseEnv, fetchImpl: reuseApi.fetch, log: () => {} });
  const created = await run(["codex", "session-one", "--json"], { adapters: [fakeAdapter()], env: createEnv, fetchImpl: createApi.fetch, log: () => {} });

  assert.match(reuseApi.listUrls[0], /query=AI\+sessions/);
  assert.equal(reuseApi.publishes[0].payload.spaceId, "spc_ai");
  assert.equal(loadConfig(reuseEnv).owned["https://api.spacefast.com"].id, "spc_ai");
  assert.deepEqual(createApi.publishes[0].payload.space, { title: "AI sessions" });
  assert.equal(createApi.publishes[0].payload.access, "private");
  assert.equal(created.spaceTitle, "AI sessions");
  assert.equal(loadConfig(createEnv).owned["https://api.spacefast.com"].id, created.spaceId);
});

test("a new Space asks which team owns it when the credential spans teams", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "push-session-team-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { PUSH_SESSION_CONFIG: path.join(root, "config.json"), SPACEFAST_HOME: root, SPACEFAST_TOKEN: "owned-token" };
  const api = fakeOwnedApi([]);
  const teams = [{ id: "team_a", slug: "acme", name: "Acme" }, { id: "team_b", slug: "side", name: "Side project" }];
  const fetchImpl = async (url, init) => {
    if (new URL(url).pathname === "/v1/publish" && !JSON.parse(init.body.get("payload")).teamId) {
      return jsonResponse(400, { code: "team_required", detail: "Select a team for the new space.", details: { teams } });
    }
    return api.fetch(url, init);
  };
  const prompts = fakePrompts([null, "team_b"]);
  prompts.select = async (options) => {
    prompts.asked.push(options);
    return prompts.asked.length === 1 ? options.options[0].value : "team_b";
  };

  await run(["codex", "session-one"], { adapters: [fakeAdapter()], env, fetchImpl, prompts, interactive: true, log: () => {}, write: () => {} });
  await assert.rejects(
    run(["codex", "session-one", "--json", "--new-space"], { adapters: [fakeAdapter()], env, fetchImpl, log: () => {} }),
    /--team <slug> \(acme, side\)/,
  );

  assert.equal(prompts.asked[1].message, "Which team owns the new Space?");
  assert.equal(api.publishes[0].payload.teamId, "team_b");
  assert.equal(loadConfig(env).owned["https://api.spacefast.com"].title, "AI sessions");
});

test("a saved Space that is gone stops a headless publish and names the way out", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "push-session-gone-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { PUSH_SESSION_CONFIG: path.join(root, "config.json"), SPACEFAST_HOME: root, SPACEFAST_TOKEN: "owned-token" };
  saveConfig({ version: 1, owned: { "https://api.spacefast.com": { id: "spc_deleted", title: "Old sessions" } } }, env);
  const api = fakeOwnedApi([], { missing: new Set(["spc_deleted"]) });

  await assert.rejects(
    run(["codex", "session-one", "--json"], { adapters: [fakeAdapter()], env, fetchImpl: api.fetch, log: () => {} }),
    /"Old sessions" is gone or no longer yours.*--pick-space.*--space/,
  );
  assert.equal(api.publishes.length, 1);
  assert.equal(loadConfig(env).owned["https://api.spacefast.com"].id, "spc_deleted");
});

test("uploads recovered artifacts with their Claude session", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "push-session-claude-artifacts-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { PUSH_SESSION_CONFIG: path.join(root, "config.json"), SPACEFAST_HOME: root };
  const uploadedPaths = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith("/share-links")) {
      return jsonResponse(201, { data: { url: "https://sessions.example/__/with-artifacts" } });
    }
    uploadedPaths.push(...init.body.getAll("files").map((file) => file.name));
    return jsonResponse(201, {
      data: {
        space: { id: "spc_artifact_session", liveUrl: "https://sessions.example/" },
        claim: { key: "artifact-session-key" },
        next: { action: "done" },
      },
    });
  };
  const artifactId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const version = {
    version: 1,
    toolUseId: "artifact-tool",
    label: "first",
    sourcePath: "/tmp/artifact.html",
    publishedAt: "2026-08-01T12:00:00Z",
    source: {
      content: "<!doctype html><h1>Artifact</h1>",
      extension: ".html",
      recoveredFrom: "transcript-write",
      bytes: 39,
      sha256: "artifact-hash",
    },
  };
  const artifact = {
    id: artifactId,
    url: `https://claude.ai/code/artifact/${artifactId}`,
    sessionId: "session-one",
    sessionIds: ["session-one"],
    title: "Session artifact",
    favicon: "🧩",
    sourcePath: version.sourcePath,
    versions: [version],
    recoverableVersions: 1,
    latest: version,
  };
  const adapter = fakeAdapter("claude", [
    { role: "tool", id: "artifact-tool", name: "Artifact", output: `Published ${artifact.url}` },
    { role: "assistant", content: `[Open artifact](${artifact.url})` },
  ]);

  const result = await run(["claude", "session-one", "--json"], {
    adapters: [adapter],
    discoverSessionArtifacts: async () => [artifact],
    env,
    fetchImpl,
    log: () => {},
    warn: () => {},
  });

  assert.equal(result.artifacts, 1);
  assert.equal(result.artifactVersions, 1);
  assert.ok(uploadedPaths.includes(`sessions/session-one/artifacts/${artifactId}/index.html`));
  assert.ok(uploadedPaths.includes(`sessions/session-one/artifacts/${artifactId}/versions/0001-first/index.html`));
});

test("uploads recovered ChatGPT Sites with their Codex session", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "push-session-chatgpt-sites-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { PUSH_SESSION_CONFIG: path.join(root, "config.json"), SPACEFAST_HOME: root };
  const uploadedPaths = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith("/share-links")) return jsonResponse(201, { data: { url: "https://sessions.example/__/with-site" } });
    uploadedPaths.push(...init.body.getAll("files").map((file) => file.name));
    return jsonResponse(201, {
      data: {
        space: { id: "spc_site_session", liveUrl: "https://sessions.example/" },
        claim: { key: "site-session-key" },
        next: { action: "done" },
      },
    });
  };
  const site = {
    id: "appgprj_testsite123",
    projectId: "appgprj_testsite123",
    title: "Session Site",
    slug: "session-site",
    url: "https://session-site.example.test/",
    callIds: ["save-site"],
    recoverableVersions: 1,
    versions: [{
      id: "ver_1",
      number: 1,
      commitSha: "abc123",
      callIds: ["save-site"],
      liveUrl: "https://session-site.example.test/",
      source: {
        recoveredFrom: "git-commit",
        files: [{ path: "app/page.tsx", content: Buffer.from("export default function Page() {}"), bytes: 33, sha256: "hash", contentType: "text/plain; charset=utf-8" }],
        omittedFiles: [],
        archive: null,
      },
    }],
  };

  const result = await run(["codex", "session-one", "--json"], {
    adapters: [fakeAdapter("codex", [{ role: "tool", id: "save-site", name: "save_site_version", output: "Saved" }])],
    discoverSessionSites: async () => [site],
    env,
    fetchImpl,
    log: () => {},
    warn: () => {},
  });

  assert.equal(result.sites, 1);
  assert.equal(result.siteVersions, 1);
  assert.equal(result.recoveredSiteVersions, 1);
  assert.ok(uploadedPaths.includes("sessions/session-one/sites/appgprj_testsite123/index.html"));
  assert.ok(uploadedPaths.includes("sessions/session-one/sites/appgprj_testsite123/versions/0001-1/source/app/page.tsx"));
});

function fakeAdapter(id = "codex", messages = [{ role: "assistant", content: "Done" }]) {
  const session = {
    agent: id,
    agentLabel: id === "claude" ? "Claude Code" : "Codex",
    id: "session-one",
    title: "Session one",
  };
  return {
    id,
    label: session.agentLabel,
    installed: () => true,
    discover: () => [session],
    load: () => messages,
  };
}

function fakeOwnedApi(spaces, { missing = new Set() } = {}) {
  const publishes = [];
  const listUrls = [];
  let created = 0;
  return {
    publishes,
    listUrls,
    async fetch(url, init = {}) {
      const target = new URL(url);
      if (target.pathname === "/v1/spaces") {
        listUrls.push(target.href);
        const query = target.searchParams.get("query")?.toLowerCase();
        return jsonResponse(200, {
          data: spaces.filter((space) => !query || space.title.toLowerCase().includes(query)),
          pagination: { nextCursor: null, hasMore: false },
        });
      }
      if (target.pathname.endsWith("/share-links")) {
        return jsonResponse(201, { data: { url: `https://sessions.example/${target.pathname.split("/")[3]}/link` } });
      }
      const payload = JSON.parse(init.body.get("payload"));
      publishes.push({ payload, authorization: init.headers.authorization });
      if (missing.has(payload.spaceId)) return jsonResponse(404, { code: "not_found", detail: "Space not found." });
      const space = payload.spaceId
        ? spaces.find((item) => item.id === payload.spaceId) || { id: payload.spaceId, title: payload.spaceId }
        : { id: `spc_created_${(created += 1)}`, title: payload.space.title };
      return jsonResponse(201, { data: { space: { liveUrl: "https://sessions.example/", ...space }, next: { action: "done" } } });
    },
  };
}

function fakePrompts(answers) {
  const asked = [];
  const quiet = () => {};
  const answer = async (options) => {
    asked.push(options);
    return answers.shift();
  };
  return {
    asked,
    intro: quiet,
    outro: quiet,
    note: quiet,
    cancel: quiet,
    isCancel: () => false,
    log: { warn: quiet, info: quiet },
    spinner: () => ({ start: quiet, stop: quiet, error: quiet, message: quiet }),
    text: answer,
    select: answer,
    autocomplete: answer,
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
