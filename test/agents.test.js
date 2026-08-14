import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createClaudeAdapter } from "../src/agents/claude.js";
import { createCodexAdapter } from "../src/agents/codex.js";
import { createCursorAdapter } from "../src/agents/cursor.js";
import { createGeminiAdapter } from "../src/agents/gemini.js";
import { createPiAdapter } from "../src/agents/pi.js";

test("discovers and maps a Codex session with paired tool output", (context) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "push-session-codex-"));
  context.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const directory = path.join(home, "sessions", "2026", "08", "13");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "rollout-test.jsonl");
  writeJsonl(file, [
    { type: "session_meta", payload: { id: "codex-session", timestamp: "2026-08-13T12:00:00Z", cwd: "/work/demo" } },
    { type: "response_item", timestamp: "2026-08-13T12:00:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\n\n<INSTRUCTIONS>generated context</INSTRUCTIONS>" }] } },
    { type: "response_item", timestamp: "2026-08-13T12:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Build the thing" }] } },
    { type: "response_item", timestamp: "2026-08-13T12:00:02Z", payload: { type: "function_call", name: "exec_command", call_id: "call-1", arguments: "{\"cmd\":\"npm test\"}" } },
    { type: "response_item", timestamp: "2026-08-13T12:00:03Z", payload: { type: "function_call_output", call_id: "call-1", output: JSON.stringify({ output: "x".repeat(12_000), exit_code: 0 }) } },
    { type: "response_item", timestamp: "2026-08-13T12:00:04Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] } },
  ]);

  const adapter = createCodexAdapter({ home });
  const sessions = adapter.discover();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, "codex-session");
  assert.equal(sessions[0].title, "Build the thing");
  const messages = adapter.load(sessions[0]);
  assert.deepEqual(messages.map((message) => message.role), ["user", "tool", "assistant"]);
  assert.equal(messages[1].name, "exec_command");
  assert.deepEqual(messages[1].input, { cmd: "npm test" });
  assert.equal(messages[1].output.length, 12_000, "tool output should be preserved for paging");
  assert.equal(messages[1].status, "completed");
});

test("discovers and maps a Claude session with paired tool output", (context) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "push-session-claude-"));
  context.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const directory = path.join(home, "projects", "-work-demo");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "claude-session.jsonl");
  writeJsonl(file, [
    { type: "user", timestamp: "2026-08-13T12:00:00Z", cwd: "/work/demo", message: { content: "Fix the test" } },
    { type: "assistant", timestamp: "2026-08-13T12:00:01Z", message: { model: "claude-sonnet", content: [{ type: "text", text: "I will inspect it." }, { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "test.js" } }] } },
    { type: "user", timestamp: "2026-08-13T12:00:02Z", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "test contents" }] } },
    { type: "assistant", timestamp: "2026-08-13T12:00:03Z", message: { content: [{ type: "text", text: "Fixed." }] } },
  ]);

  const adapter = createClaudeAdapter({ home });
  const sessions = adapter.discover();
  assert.equal(sessions[0].title, "Fix the test");
  const messages = adapter.load(sessions[0]);
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "tool", "assistant"]);
  assert.equal(messages[2].name, "Read");
  assert.equal(messages[2].output, "test contents");
});

test("discovers Codex sessions with large metadata and transcript timestamps", (context) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "push-session-codex-large-"));
  context.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const directory = path.join(home, "sessions", "2026", "08", "13");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "rollout-large.jsonl");
  writeJsonl(file, [
    { type: "session_meta", payload: { id: "large-session", timestamp: "2026-08-13T12:00:00Z", cwd: "/work/large", base_instructions: "x".repeat(300_000) } },
    { type: "response_item", timestamp: "2026-08-13T12:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Find me after the large metadata" }] } },
    { type: "response_item", timestamp: "2026-08-13T12:05:00Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Found." }] } },
  ]);
  fs.utimesSync(file, new Date("2026-08-14T00:00:00Z"), new Date("2026-08-14T00:00:00Z"));

  const [session] = createCodexAdapter({ home }).discover();
  assert.equal(session.title, "Find me after the large metadata");
  assert.equal(session.project, "/work/large");
  assert.equal(session.updatedAt, Date.parse("2026-08-13T12:05:00Z"));
});

test("uses Claude resume metadata, transcript freshness, and excludes sidechains", (context) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "push-session-claude-index-"));
  context.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const projectDir = path.join(home, "projects", "-lossy-project-slug");
  fs.mkdirSync(projectDir, { recursive: true });
  writeJsonl(path.join(projectDir, "main.jsonl"), [
    { type: "user", uuid: "one", parentUuid: null, timestamp: "2026-08-13T12:00:00Z", message: { content: "/compact" } },
    { type: "user", uuid: "two", parentUuid: "one", timestamp: "2026-08-13T12:10:00Z", cwd: "/work/from-transcript", message: { content: "Real prompt" } },
  ]);
  writeJsonl(path.join(projectDir, "side.jsonl"), [
    { type: "user", isSidechain: true, timestamp: "2026-08-13T13:00:00Z", message: { content: "Subagent prompt" } },
  ]);
  fs.writeFileSync(path.join(projectDir, "sessions-index.json"), JSON.stringify({
    version: 1,
    originalPath: "/work/canonical-project",
    entries: [
      { sessionId: "main", summary: "Canonical resume title", firstPrompt: "/compact", created: "2026-08-13T12:00:00Z", modified: "2026-08-13T12:05:00Z", projectPath: "/work/canonical-project" },
      { sessionId: "side", isSidechain: true, modified: "2026-08-13T13:00:00Z" },
    ],
  }));

  const sessions = createClaudeAdapter({ home }).discover();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, "Canonical resume title");
  assert.equal(sessions[0].project, "/work/canonical-project");
  assert.equal(sessions[0].updatedAt, Date.parse("2026-08-13T12:10:00Z"));
});

test("discovers modern Gemini JSONL sessions using project and summary metadata", (context) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "push-session-gemini-"));
  context.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const chatsDir = path.join(home, "tmp", "project-hash", "chats");
  fs.mkdirSync(chatsDir, { recursive: true });
  fs.writeFileSync(path.join(home, "projects.json"), JSON.stringify({ projects: { "/work/gemini-project": "project-hash" } }));
  writeJsonl(path.join(chatsDir, "session-modern.jsonl"), [
    { sessionId: "gemini-session", projectHash: "project-hash", startTime: "2026-08-13T12:00:00Z", lastUpdated: "2026-08-13T12:00:00Z", kind: "main" },
    { id: "one", timestamp: "2026-08-13T12:00:01Z", type: "user", content: [{ text: "/help" }] },
    { id: "two", timestamp: "2026-08-13T12:00:02Z", type: "user", content: [{ text: "Explain the repository" }] },
    { id: "three", timestamp: "2026-08-13T12:00:03Z", type: "gemini", content: [{ text: "Certainly." }] },
    { $set: { lastUpdated: "2026-08-13T12:05:00Z", summary: "Repository walkthrough", messageCount: 3 } },
  ]);

  const adapter = createGeminiAdapter({ home });
  const [session] = adapter.discover();
  assert.equal(session.id, "gemini-session");
  assert.equal(session.title, "Repository walkthrough");
  assert.equal(session.project, "/work/gemini-project");
  assert.equal(session.updatedAt, Date.parse("2026-08-13T12:05:00Z"));
  assert.deepEqual(adapter.load(session).map((message) => message.role), ["user", "user", "assistant"]);
  assert.equal(adapter.discover({ query: "gemini-session" })[0].id, "gemini-session");
});

test("uses Cursor workspace metadata and message timestamps when available", (context) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "push-session-cursor-"));
  context.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const projectDir = path.join(home, "projects", "lossy-project-slug");
  const id = "cursor-session";
  const transcriptDir = path.join(projectDir, "agent-transcripts", id);
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, ".workspace-trusted"), JSON.stringify({ workspacePath: "/work/exact-cursor-project" }));
  writeJsonl(path.join(transcriptDir, `${id}.jsonl`), [
    { role: "user", timestamp: 1_786_622_400, message: { content: [{ type: "text", text: "<environment_context>generated</environment_context>" }] } },
    { role: "user", timestamp: 1_786_622_460, message: { content: [{ type: "text", text: "<user_query>Fix the parser</user_query>" }] } },
    { role: "assistant", timestamp: 1_786_622_520, message: { content: [{ type: "text", text: "Done." }] } },
  ]);

  const adapter = createCursorAdapter({ home });
  const [session] = adapter.discover();
  assert.equal(session.title, "Fix the parser");
  assert.equal(session.project, "/work/exact-cursor-project");
  assert.equal(session.createdAt, 1_786_622_400_000);
  assert.equal(session.updatedAt, 1_786_622_520_000);
  assert.deepEqual(adapter.load(session).map((message) => message.content), ["Fix the parser", "Done."]);
});

test("discovers Pi sessions and renders only the active branch", (context) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "push-session-pi-"));
  context.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const projectDir = path.join(home, "sessions", "--work-pi-project--");
  fs.mkdirSync(path.join(projectDir, "subagents", "nested"), { recursive: true });
  const file = path.join(projectDir, "session.jsonl");
  writeJsonl(file, [
    { type: "session", version: 3, id: "019-pi-session", timestamp: "2026-08-13T12:00:00Z", cwd: "/work/exact-pi-project" },
    { type: "message", id: "user", parentId: null, timestamp: "2026-08-13T12:00:00Z", message: { role: "user", content: [{ type: "text", text: "Fix the Pi parser" }], timestamp: Date.parse("2026-08-13T12:00:00Z") } },
    { type: "message", id: "abandoned", parentId: "user", timestamp: "2026-08-13T12:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "Abandoned response" }], timestamp: Date.parse("2026-08-13T12:00:01Z") } },
    { type: "message", id: "assistant", parentId: "user", timestamp: "2026-08-13T12:00:02Z", message: { role: "assistant", model: "gpt-test", content: [{ type: "text", text: "I will inspect it." }, { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/parser.js" } }], timestamp: Date.parse("2026-08-13T12:00:02Z") } },
    { type: "message", id: "result", parentId: "assistant", timestamp: "2026-08-13T12:10:00Z", message: { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "parser contents" }], isError: false, timestamp: Date.parse("2026-08-13T12:10:00Z") } },
    { type: "custom_message", id: "custom", parentId: "result", timestamp: "2026-08-13T12:10:01Z", customType: "notice", content: "Extension notice", display: true },
    { type: "session_info", id: "info", parentId: "custom", timestamp: "2026-08-13T12:11:00Z", name: "Named Pi session" },
  ]);
  writeJsonl(path.join(projectDir, "subagents", "nested", "child.jsonl"), [
    { type: "session", version: 3, id: "nested-session", timestamp: "2026-08-13T13:00:00Z", cwd: "/work/subagent" },
  ]);

  const adapter = createPiAdapter({ home });
  const sessions = adapter.discover();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, "019-pi-session");
  assert.equal(sessions[0].title, "Named Pi session");
  assert.equal(sessions[0].project, "/work/exact-pi-project");
  assert.equal(sessions[0].updatedAt, Date.parse("2026-08-13T12:00:02Z"));
  assert.equal(sessions[0].messageCount, 4);
  assert.equal(adapter.discover({ query: "019-pi-session" })[0].id, "019-pi-session");

  const messages = adapter.load(sessions[0]);
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "tool", "tool"]);
  assert.equal(messages.some((message) => message.content === "Abandoned response"), false);
  assert.equal(messages[2].name, "read");
  assert.deepEqual(messages[2].input, { path: "src/parser.js" });
  assert.equal(messages[2].output, "parser contents");
  assert.equal(messages[3].name, "notice");
});

test("honors Pi's configured flat session directory", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "push-session-pi-custom-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "agent");
  const sessionDir = path.join(root, "custom-sessions");
  fs.mkdirSync(path.join(sessionDir, "nested"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ sessionDir }));
  writeJsonl(path.join(sessionDir, "custom.jsonl"), [
    { type: "session", version: 3, id: "custom-pi-session", timestamp: "2026-08-13T12:00:00Z", cwd: "/work/custom" },
    { type: "message", id: "user", parentId: null, timestamp: "2026-08-13T12:01:00Z", message: { role: "user", content: "Custom directory" } },
  ]);
  writeJsonl(path.join(sessionDir, "nested", "ignored.jsonl"), [
    { type: "session", version: 3, id: "ignored", timestamp: "2026-08-13T13:00:00Z", cwd: "/work/ignored" },
  ]);

  const [session] = createPiAdapter({ home }).discover();
  assert.equal(session.id, "custom-pi-session");
  assert.equal(session.title, "Custom directory");
});

function writeJsonl(filePath, entries) {
  fs.writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}
