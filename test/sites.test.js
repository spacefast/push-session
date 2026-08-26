import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { renderSessionWithArtifacts } from "../src/artifacts/session.js";
import { discoverCodexSessionSites, parseCodexSitesTranscript } from "../src/artifacts/sites.js";

test("recovers the exact ChatGPT Sites commit and deployment package from a Codex session", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "push-session-sites-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectId = "appgprj_6a204c35ec20819185e5dc8cab8159ee";
  const transcript = path.join(root, "session.jsonl");
  const archive = path.join(root, "site-build.tar.gz");
  fs.mkdirSync(path.join(root, ".openai"));
  fs.mkdirSync(path.join(root, "app"));
  fs.writeFileSync(path.join(root, ".openai", "hosting.json"), JSON.stringify({ project_id: projectId }));
  fs.writeFileSync(path.join(root, "app", "page.tsx"), "export default function Page() { return <h1>Recorded Site</h1>; }\n");
  fs.writeFileSync(path.join(root, ".env"), "PRIVATE_TOKEN=do-not-upload\n");
  const archiveContent = siteArchive();
  fs.writeFileSync(archive, archiveContent);
  git(root, ["init", "-b", "main"]);
  git(root, ["add", "."]);
  git(root, ["-c", "user.name=Push Session", "-c", "user.email=push-session@example.test", "commit", "-m", "Recorded Site"]);
  const commit = git(root, ["rev-parse", "HEAD"]).trim();
  writeJsonl(transcript, siteTranscript({ projectId, archive, commit }));

  const sites = discoverCodexSessionSites({ filePath: transcript, project: root });
  assert.equal(sites.length, 1);
  assert.equal(sites[0].title, "Recorded Site");
  assert.equal(sites[0].url, "https://recorded-site.example.test/");
  assert.equal(sites[0].versions[0].commitSha, commit);
  assert.equal(sites[0].recoverableVersions, 1);
  assert.ok(sites[0].versions[0].source.files.some((file) => file.path === "app/page.tsx" && file.content.toString().includes("Recorded Site")));
  assert.ok(sites[0].versions[0].source.omittedFiles.includes(".env"));
  assert.deepEqual(sites[0].versions[0].source.archive.content, archiveContent);

  const bundle = renderSessionWithArtifacts(
    { agent: "codex", agentLabel: "Codex", id: "sites-session", title: "Build a Site", project: root },
    [
      { role: "tool", id: "save-site", name: "mcp__codex_apps__sites_save_site_version", output: "Saved version" },
      { role: "assistant", content: "Your Site is live at https://recorded-site.example.test/" },
    ],
    [],
    { sites, publishedAt: "2026-08-01T13:00:00Z" },
  );
  const versionBase = `sessions/sites-session/sites/${projectId}/versions/0007-7`;
  assert.equal(bundle.siteCount, 1);
  assert.equal(bundle.siteVersions, 1);
  assert.equal(bundle.recoveredSiteVersions, 1);
  assert.ok(bundle.files.some((file) => file.path === `${versionBase}/source/app/page.tsx`));
  assert.ok(bundle.files.some((file) => file.path === `${versionBase}/deployment.tar.gz`));
  assert.ok(!bundle.files.some((file) => file.path.endsWith("/.env")));

  const shell = payloadFromHtml(bundle.files.find((file) => file.path === "sessions/sites-session/index.html").content);
  assert.equal(shell.artifacts[0].kind, "chatgpt-site");
  assert.equal(shell.artifacts[0].href, `sites/${projectId}/index.html`);
  const events = bundle.files.filter((file) => file.path.includes("/pages/")).flatMap((file) => JSON.parse(file.content).events);
  assert.equal(events[0].payload.data.artifact.href, `sites/${projectId}/versions/0007-7/index.html`);
  assert.match(events[1].payload.detail, /https:\/\/recorded-site\.example\.test/);
});

test("recognizes Sites calls made through the Codex exec orchestrator", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "push-session-sites-exec-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const transcript = path.join(root, "session.jsonl");
  const projectId = "appgprj_nested123";
  writeJsonl(transcript, [
    responseItem({
      type: "custom_tool_call",
      name: "exec",
      call_id: "outer-save",
      input: `const result = await tools.mcp__codex_apps__sites_save_site_version({ project_id: "${projectId}", archive: "/tmp/site.tgz", commit_sha: "abc123" }); text(result);`,
    }),
    responseItem({
      type: "custom_tool_call_output",
      call_id: "outer-save",
      output: JSON.stringify({ structuredContent: { result: { project_id: projectId, version_id: "ver_nested", version_number: 2 } } }),
    }),
  ]);

  const sites = parseCodexSitesTranscript(transcript);
  assert.equal(sites.length, 1);
  assert.equal(sites[0].versions[0].id, "ver_nested");
  assert.equal(sites[0].versions[0].number, 2);
  assert.equal(sites[0].versions[0].commitSha, "abc123");
});

test("does not attach Sites that a session only listed", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "push-session-sites-list-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const transcript = path.join(root, "session.jsonl");
  writeJsonl(transcript, [
    responseItem({ type: "function_call", namespace: "mcp__codex_apps__sites", name: "_list_sites", call_id: "list-sites", arguments: "{}" }),
    responseItem({
      type: "function_call_output",
      call_id: "list-sites",
      output: JSON.stringify({ result: [{ id: "appgprj_unrelated123", title: "An unrelated Site" }] }),
    }),
  ]);

  assert.deepEqual(parseCodexSitesTranscript(transcript), []);
});

test("does not upload an arbitrary file named as a deployment archive in a transcript", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "push-session-sites-unsafe-archive-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const transcript = path.join(root, "session.jsonl");
  const unrelated = path.join(root, "unrelated.txt");
  const projectId = "appgprj_safearchive123";
  fs.writeFileSync(unrelated, "local file that is not a Sites package");
  writeJsonl(transcript, [
    responseItem({
      type: "function_call",
      name: "mcp__codex_apps__sites_save_site_version",
      call_id: "unsafe-save",
      arguments: JSON.stringify({ project_id: projectId, archive: unrelated, source: { commit_sha: "missing" } }),
    }),
    responseItem({
      type: "function_call_output",
      call_id: "unsafe-save",
      output: JSON.stringify({ result: { project_id: projectId, version_id: "ver_unsafe", version_number: 1 } }),
    }),
  ]);

  const sites = discoverCodexSessionSites({ filePath: transcript, project: path.join(root, "missing-project") });
  assert.equal(sites[0].recoverableVersions, 0);
  assert.equal(sites[0].versions[0].source, null);
});

function siteTranscript({ projectId, archive, commit }) {
  return [
    responseItem({
      type: "function_call",
      name: "mcp__codex_apps__sites_save_site_version",
      call_id: "save-site",
      arguments: JSON.stringify({ project_id: projectId, archive, commit_sha: commit }),
    }, "2026-08-01T12:00:00Z"),
    responseItem({
      type: "function_call_output",
      call_id: "save-site",
      output: JSON.stringify({ result: { project_id: projectId, title: "Recorded Site", slug: "recorded-site", version_id: "ver_7", version_number: 7, source: { commit_sha: commit } } }),
    }, "2026-08-01T12:00:01Z"),
    responseItem({
      type: "function_call",
      name: "mcp__codex_apps__sites_deploy_site_version",
      call_id: "deploy-site",
      arguments: JSON.stringify({ project_id: projectId, version_id: "ver_7" }),
    }, "2026-08-01T12:00:02Z"),
    responseItem({
      type: "function_call_output",
      call_id: "deploy-site",
      output: JSON.stringify({ result: { project_id: projectId, version_id: "ver_7", deployment_id: "dep_7", status: "succeeded", url: "https://recorded-site.example.test/" } }),
    }, "2026-08-01T12:00:03Z"),
  ];
}

function responseItem(payload, timestamp = "2026-08-01T12:00:00Z") {
  return { type: "response_item", timestamp, payload };
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function writeJsonl(filePath, entries) {
  fs.writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

function payloadFromHtml(html) {
  const payload = html.match(/<script id="push-session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
  assert.ok(payload);
  return JSON.parse(payload);
}

function siteArchive() {
  const entries = [
    ["dist/server/index.js", Buffer.from("export default { fetch() {} };\n")],
    ["dist/.openai/hosting.json", Buffer.from('{"project_id":"appgprj_6a204c35ec20819185e5dc8cab8159ee"}\n')],
  ];
  const blocks = [];
  for (const [name, content] of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    header.write("ustar\0", 257, 6, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
