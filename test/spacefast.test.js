import assert from "node:assert/strict";
import test from "node:test";

import { publishSession } from "../src/spacefast.js";

test("publishes paged files and creates a page-view-only Spacefast link", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/share-links")) {
      return jsonResponse(201, { data: { id: "lnk_one", url: "https://sessions.example/__/recipient-key" } });
    }
    return jsonResponse(201, {
      data: {
        space: { id: "spc_one", liveUrl: "https://sessions.example/" },
        version: { immutableUrl: "https://v1.sessions.example/" },
        claim: { key: "secret-key", claimUrl: "https://claim.example/one", url: "https://sessions.example/__/key", expiresAt: "2026-08-20T00:00:00Z" },
        next: { action: "done", hint: "Done" },
      },
    });
  };
  const basePath = "sessions/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
  const entryPath = `${basePath}/index.html`;
  const result = await publishSession({
    fetchImpl,
    session: { agent: "codex", id: "private-id", title: "Demo" },
    basePath,
    entryPath,
    files: [
      { path: entryPath, content: "<h1>Hello</h1>", contentType: "text/html" },
      { path: `${basePath}/pages/0001.json`, content: '{"items":[]}', contentType: "application/json" },
    ],
  });

  assert.equal(requests[0].url, "https://api.spacefast.com/v1/publish?wait=1");
  assert.match(requests[0].init.headers["x-spacefast-idempotency-principal"], /^[0-9a-f]{64}$/);
  const payload = JSON.parse(requests[0].init.body.get("payload"));
  assert.equal(payload.publishMode, "additive");
  assert.equal(payload.space.title, "Shared AI sessions");
  assert.deepEqual(requests[0].init.body.getAll("files").map((file) => file.name), [entryPath, `${basePath}/pages/0001.json`]);

  const linkBody = JSON.parse(requests[1].init.body);
  assert.equal(requests[1].init.headers.authorization, "Bearer secret-key");
  assert.equal(linkBody.landingPath, `/${basePath}`);
  assert.deepEqual(linkBody.resources, { include: [`/${basePath}`, `/${basePath}/**`] });
  assert.deepEqual(linkBody.capabilities, ["page.view"]);
  assert.equal(result.shareUrl, "https://sessions.example/__/recipient-key");
  assert.equal(result.landingUrl, `https://sessions.example/${entryPath}`);
  assert.equal(result.space.claimToken, "secret-key");
});

test("updates a selected space with bearer authentication", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/share-links")) return jsonResponse(201, { data: { url: "https://sessions.example/__/owned-link" } });
    return jsonResponse(201, {
      data: {
        space: { id: "spc_saved", liveUrl: "https://sessions.example/" },
        version: { immutableUrl: "https://v2.sessions.example/" },
        next: { action: "done", hint: "Done" },
      },
    });
  };
  await publishSession({
    fetchImpl,
    session: { agent: "claude", id: "session-2" },
    html: "ok",
    spaceId: "spc_saved",
    accessToken: "token-value",
  });
  assert.equal(requests[0].init.headers.authorization, "Bearer token-value");
  assert.equal(JSON.parse(requests[0].init.body.get("payload")).spaceId, "spc_saved");
  assert.equal(requests[1].init.headers.authorization, "Bearer token-value");
});

test("switches giant sessions to manifest uploads and follows upload receipts", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const requestUrl = String(url);
    requests.push({ url: requestUrl, init });
    if (requestUrl === "https://upload.example/file") return new Response(null, { status: 204 });
    if (requestUrl === "https://api.spacefast.com/resume") {
      return jsonResponse(200, {
        data: {
          space: { id: "spc_big", liveUrl: "https://big.example/" },
          version: { immutableUrl: "https://big-version.example/" },
          next: { action: "done", hint: "Done" },
        },
      });
    }
    if (requestUrl.endsWith("/share-links")) return jsonResponse(201, { data: { url: "https://big.example/__/link" } });
    return jsonResponse(201, {
      data: {
        space: { id: "spc_big", liveUrl: "https://big.example/" },
        claim: { key: "big-secret" },
        upload: {
          targets: [{ path: "sessions/a/b/index.html", method: "PUT", url: "https://upload.example/file", headers: { authorization: "Upload signed" } }],
          links: { resume: "/resume", finalize: "/finalize" },
        },
        next: { action: "upload", url: "/resume", hint: "Upload" },
      },
    });
  };
  const result = await publishSession({
    fetchImpl,
    session: { title: "Big" },
    basePath: "sessions/a/b",
    entryPath: "sessions/a/b/index.html",
    files: [{ path: "sessions/a/b/index.html", content: "large-data", contentType: "text/html" }],
    inlineLimitBytes: 1,
  });

  assert.equal(requests[0].init.headers["content-type"], "application/json");
  const manifest = JSON.parse(requests[0].init.body);
  assert.equal(manifest.files[0].size, 10);
  assert.match(manifest.files[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(requests[1].url, "https://upload.example/file");
  assert.equal(requests[1].init.headers.authorization, "Upload signed");
  assert.equal(requests[2].url, "https://api.spacefast.com/resume");
  assert.equal(result.shareUrl, "https://big.example/__/link");
});

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
