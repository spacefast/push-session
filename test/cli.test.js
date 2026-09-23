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
  assert.match(output, /Access\n/);
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

test("reuses the first global session space on later runs", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "push-session-global-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { PUSH_SESSION_CONFIG: path.join(root, "config.json") };
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
  const env = { PUSH_SESSION_CONFIG: path.join(root, "config.json") };
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

test("one-off space and alternate API publishes preserve the saved global space", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "push-session-one-off-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { PUSH_SESSION_CONFIG: path.join(root, "config.json"), SPACEFAST_TOKEN: "owned-token" };
  saveConfig({ version: 1, space: { id: "spc_global", claimToken: "global-key" } }, env);
  const requests = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith("/share-links")) return jsonResponse(201, { data: { url: "https://sessions.example/private" } });
    requests.push({ url: String(url), payload: JSON.parse(init.body.get("payload")) });
    return jsonResponse(201, {
      data: {
        space: { id: requests.length === 1 ? "spc_other" : "spc_alt", liveUrl: "https://sessions.example/" },
        claim: { key: "new-key" },
        next: { action: "done" },
      },
    });
  };
  const dependencies = { adapters: [fakeAdapter()], env, fetchImpl, log: () => {} };
  await run(["codex", "session-one", "--json", "--space", "spc_other"], dependencies);
  await run(["codex", "session-one", "--json", "--api-url", "https://alternate.example/"], dependencies);

  assert.equal(requests[0].payload.spaceId, "spc_other");
  assert.equal(requests[1].url, "https://alternate.example/v1/publish?wait=1");
  assert.equal(requests[1].payload.spaceId, undefined);
  assert.deepEqual(loadConfig(env).space, { id: "spc_global", claimToken: "global-key" });

  const unreadable = '{"space":{"id":"spc_global","accessToken":"saved-key"},"apiUrl":"file:///invalid"}';
  fs.writeFileSync(env.PUSH_SESSION_CONFIG, unreadable);
  const warnings = [];
  await run(["codex", "session-one", "--json"], { ...dependencies, warn: (message) => warnings.push(message) });
  assert.equal(fs.readFileSync(env.PUSH_SESSION_CONFIG, "utf8"), unreadable);
  assert.match(warnings[0], /config\.json/);
});

test("uploads recovered artifacts with their Claude session", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "push-session-claude-artifacts-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { PUSH_SESSION_CONFIG: path.join(root, "config.json") };
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
  const env = { PUSH_SESSION_CONFIG: path.join(root, "config.json") };
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

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
