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

function fakeAdapter() {
  const session = {
    agent: "codex",
    agentLabel: "Codex",
    id: "session-one",
    title: "Session one",
  };
  return {
    id: "codex",
    label: "Codex",
    installed: () => true,
    discover: () => [session],
    load: () => [{ role: "assistant", content: "Done" }],
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
