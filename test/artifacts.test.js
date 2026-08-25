import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseArtifactArgs } from "../src/artifacts/args.js";
import { parseClaudeArtifactTranscript } from "../src/artifacts/claude.js";
import { writeArtifactBundle } from "../src/artifacts/files.js";
import { renderClaudeArtifactBundle } from "../src/artifacts/render.js";

test("reconstructs every published Claude artifact version from transcript writes and edits", async (context) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "push-session-artifact-"));
  context.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const sessionId = "11111111-2222-4333-8444-555555555555";
  const sourcePath = path.join(home, "scratchpad", "dashboard.html");
  const transcriptPath = path.join(home, "projects", "-work-demo", `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  writeJsonl(transcriptPath, [
    { type: "user", sessionId, timestamp: "2026-08-01T12:00:00Z", cwd: "/work/demo", message: { content: "Build a dashboard" } },
    assistantTool(sessionId, "2026-08-01T12:00:01Z", { type: "tool_use", id: "write-1", name: "Write", input: { file_path: sourcePath, content: "<!doctype html><h1>Version one</h1>" } }),
    toolResult(sessionId, "2026-08-01T12:00:02Z", "write-1", "Wrote file"),
    assistantTool(sessionId, "2026-08-01T12:00:03Z", { type: "tool_use", id: "artifact-1", name: "Artifact", input: { file_path: sourcePath, title: "Dashboard", favicon: "📊", label: "first" } }),
    toolResult(sessionId, "2026-08-01T12:00:04Z", "artifact-1", `Published ${sourcePath} at https://claude.ai/code/artifact/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`),
    { type: "frame-link", sessionId, path: sourcePath, frameUrl: "https://claude.ai/code/artifact/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", title: "Dashboard", timestamp: "2026-08-01T12:00:04Z" },
    assistantTool(sessionId, "2026-08-01T12:01:00Z", { type: "tool_use", id: "edit-1", name: "Edit", input: { file_path: sourcePath, old_string: "Version one", new_string: "Version two", replace_all: false } }),
    toolResult(sessionId, "2026-08-01T12:01:01Z", "edit-1", "Updated file"),
    assistantTool(sessionId, "2026-08-01T12:01:02Z", { type: "tool_use", id: "artifact-2", name: "Artifact", input: { file_path: sourcePath, label: "second" } }),
    toolResult(sessionId, "2026-08-01T12:01:03Z", "artifact-2", `Published ${sourcePath} at https://claude.ai/code/artifact/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`),
    { type: "frame-link", sessionId, path: sourcePath, frameUrl: "https://claude.ai/code/artifact/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", title: "Dashboard", timestamp: "2026-08-01T12:01:03Z" },
  ]);

  const versions = await parseClaudeArtifactTranscript(transcriptPath, { home });
  assert.equal(versions.length, 2);
  assert.equal(versions[0].source.content, "<!doctype html><h1>Version one</h1>");
  assert.equal(versions[1].source.content, "<!doctype html><h1>Version two</h1>");
  assert.equal(versions[1].source.recoveredFrom, "transcript-write+transcript-edit");
  assert.equal(versions[1].artifactId, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  assert.equal(versions[1].label, "second");
});

test("uses Claude file history as the baseline for an edit when the live source is gone", async (context) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "push-session-history-"));
  context.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const sessionId = "history-session";
  const sourcePath = path.join(home, "gone.md");
  const transcriptPath = path.join(home, "projects", "-work-demo", `${sessionId}.jsonl`);
  const backupName = "deadbeef@v1";
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.mkdirSync(path.join(home, "file-history", sessionId), { recursive: true });
  fs.writeFileSync(path.join(home, "file-history", sessionId, backupName), "# Old title\n");
  writeJsonl(transcriptPath, [
    { type: "user", sessionId, timestamp: "2026-08-01T12:00:00Z", cwd: "/work/demo", message: { content: "Update it" } },
    assistantTool(sessionId, "2026-08-01T12:00:01Z", { type: "tool_use", id: "edit-1", name: "Edit", input: { file_path: sourcePath, old_string: "Old title", new_string: "New title" } }),
    { type: "file-history-delta", trackingPath: sourcePath, timestamp: "2026-08-01T12:00:01Z", backup: { backupFileName: backupName } },
    toolResult(sessionId, "2026-08-01T12:00:02Z", "edit-1", "Updated file"),
    assistantTool(sessionId, "2026-08-01T12:00:03Z", { type: "tool_use", id: "artifact-1", name: "Artifact", input: { file_path: sourcePath, title: "Recovered report" } }),
    toolResult(sessionId, "2026-08-01T12:00:04Z", "artifact-1", "Published at https://claude.ai/code/artifact/history-artifact"),
  ]);

  const [version] = await parseClaudeArtifactTranscript(transcriptPath, { home });
  assert.equal(version.source.content, "# New title\n");
  assert.equal(version.source.recoveredFrom, "file-history+transcript-edit");
});

test("recovers an exact durable source copied into a Git commit after publishing", async (context) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "push-session-git-source-"));
  context.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = path.join(home, "project");
  const sourcePath = path.join(home, "scratchpad", "report.html");
  const gitPath = "internal-docs/report.html";
  const commit = "1234567890abcdef1234567890abcdef12345678";
  const sessionId = "git-session";
  const transcriptPath = path.join(home, "projects", "-project", `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  writeJsonl(transcriptPath, [
    { type: "user", sessionId, cwd: project, timestamp: "2026-08-01T12:00:00Z", message: { content: "Publish it" } },
    assistantTool(sessionId, "2026-08-01T12:00:01Z", { type: "tool_use", id: "write-1", name: "Write", input: { file_path: sourcePath, content: "incomplete" } }),
    toolResult(sessionId, "2026-08-01T12:00:02Z", "write-1", "Wrote file"),
    assistantTool(sessionId, "2026-08-01T12:00:03Z", { type: "tool_use", id: "artifact-1", name: "Artifact", input: { file_path: sourcePath, title: "Git report" } }),
    toolResult(sessionId, "2026-08-01T12:00:04Z", "artifact-1", "Published at https://claude.ai/code/artifact/git-report"),
    assistantTool(sessionId, "2026-08-01T12:00:05Z", { type: "tool_use", id: "bash-1", name: "Bash", input: { command: `cp ${sourcePath} \"$WT/${gitPath}\" && git commit && git log --oneline -1` } }),
    toolResult(sessionId, "2026-08-01T12:00:06Z", "bash-1", `${commit.slice(0, 10)} Save artifact`),
  ]);

  const reads = [];
  const [version] = await parseClaudeArtifactTranscript(transcriptPath, {
    home,
    gitBlobReader: (actualProject, actualCommit, actualPath) => {
      reads.push({ project: actualProject, commit: actualCommit, gitPath: actualPath });
      return "<!doctype html><h1>Exact committed source</h1>";
    },
  });
  assert.equal(version.source.content, "<!doctype html><h1>Exact committed source</h1>");
  assert.equal(version.source.recoveredFrom, "git-snapshot");
  assert.deepEqual(reads, [{ project, commit: commit.slice(0, 10), gitPath }]);
});

test("renders HTML unchanged and Markdown as a self-contained HTML page", (context) => {
  const artifact = fakeArtifact();
  const bundle = renderClaudeArtifactBundle([artifact], { allVersions: true, exportedAt: "2026-08-01T12:00:00Z" });
  const latest = bundle.files.find((file) => file.path.endsWith(`/artifacts/${artifact.id}/index.html`));
  const oldMarkdown = bundle.files.find((file) => file.path.includes("versions/0001-first/index.html"));
  assert.equal(latest.content, "<!doctype html><h1>Latest</h1>");
  assert.match(oldMarkdown.content, /claude-artifact-data/);
  assert.match(oldMarkdown.content, /# First/);
  assert.equal(bundle.manifest.artifacts[0].versions[0].sha256, "old-hash");

  const output = fs.mkdtempSync(path.join(os.tmpdir(), "push-session-export-"));
  context.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const written = writeArtifactBundle(bundle, output);
  assert.equal(fs.existsSync(written.entryPath), true);
  assert.equal(fs.readFileSync(path.join(output, "artifacts", artifact.id, "index.html"), "utf8"), "<!doctype html><h1>Latest</h1>");
});

test("parses artifact commands independently from session sharing", () => {
  const parsed = parseArtifactArgs(["export", "artifact-id", "--versions", "--output", "./out"]);
  assert.equal(parsed.command, "export");
  assert.equal(parsed.query, "artifact-id");
  assert.equal(parsed.options.allVersions, true);
  assert.equal(parsed.options.output, "./out");
  assert.throws(() => parseArtifactArgs(["publish", "one", "--all"]), /query or --all/);
});

function fakeArtifact() {
  const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const versions = [
    {
      version: 1,
      label: "first",
      publishedAt: "2026-08-01T12:00:00Z",
      sourcePath: "/tmp/report.md",
      source: { content: "# First", extension: ".md", recoveredFrom: "transcript-write", bytes: 7, sha256: "old-hash" },
    },
    {
      version: 2,
      label: "latest",
      publishedAt: "2026-08-01T13:00:00Z",
      sourcePath: "/tmp/report.html",
      source: { content: "<!doctype html><h1>Latest</h1>", extension: ".html", recoveredFrom: "transcript-write", bytes: 35, sha256: "new-hash" },
    },
  ];
  return {
    id,
    url: `https://claude.ai/code/artifact/${id}`,
    sessionId: "session-id",
    title: "Recovered report",
    description: "Two versions",
    favicon: "📄",
    sourcePath: "/tmp/report.html",
    versions,
    recoverableVersions: 2,
    latest: versions[1],
  };
}

function assistantTool(sessionId, timestamp, part) {
  return { type: "assistant", sessionId, timestamp, message: { content: [part] } };
}

function toolResult(sessionId, timestamp, toolUseId, content) {
  return { type: "user", sessionId, timestamp, message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content }] } };
}

function writeJsonl(filePath, entries) {
  fs.writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}
