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
  const turn = { internal_chat_message_metadata_passthrough: { turn_id: "turn-1" } };
  writeJsonl(file, [
    { type: "session_meta", payload: { cwd: "/work/demo", id: "codex-session", timestamp: "2026-08-13T12:00:00Z", source: "cli" } },
    { type: "turn_context", payload: { model: "gpt-test" } },
    { type: "response_item", timestamp: "2026-08-13T12:00:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\n\n<INSTRUCTIONS>generated context</INSTRUCTIONS>" }] } },
    { type: "response_item", timestamp: "2026-08-13T12:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>\n## My request for Codex:\nBuild the thing" }], ...turn } },
    { type: "event_msg", timestamp: "2026-08-13T12:00:01Z", payload: { type: "user_message", message: "Build the thing" } },
    { type: "response_item", timestamp: "2026-08-13T12:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Build the thing" }], ...turn } },
    { type: "response_item", timestamp: "2026-08-13T12:00:02Z", payload: { type: "function_call", name: "exec_command", call_id: "call-1", arguments: "{\"cmd\":\"npm test\"}" } },
    { type: "response_item", timestamp: "2026-08-13T12:00:03Z", payload: { type: "function_call_output", call_id: "call-1", output: JSON.stringify({ output: "x".repeat(12_000), exit_code: 0 }) } },
    { type: "response_item", timestamp: "2026-08-13T12:00:04Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] } },
    { type: "response_item", timestamp: "2026-08-13T12:00:05Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Untracked follow-up" }] } },
  ]);
  writeJsonl(path.join(directory, "rollout-subagent.jsonl"), [
    { type: "session_meta", payload: { id: "subagent-session", source: { subagent: { thread_spawn: { parent_thread_id: "codex-session" } } } } },
    { type: "response_item", timestamp: "2026-08-13T12:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Review this" }] } },
  ]);
  writeJsonl(path.join(directory, "rollout-context-only.jsonl"), [
    { type: "session_meta", payload: { id: "context-only" } },
    { type: "response_item", timestamp: "2026-08-13T12:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }] } },
  ]);

  const adapter = createCodexAdapter({ home });
  const sessions = adapter.discover();
  assert.deepEqual(sessions.map((session) => session.id), ["codex-session"]);
  assert.equal(sessions[0].title, "Build the thing");
  assert.equal(sessions[0].model, "gpt-test");
  assert.equal(adapter.discover({ query: "codex-session" })[0].id, "codex-session");

  writeJsonl(path.join(home, "session_index.jsonl"), [
    { id: "codex-session", thread_name: "Newest rename", updated_at: "2026-08-13T13:00:00Z" },
    { id: "codex-session", thread_name: "Older rename", updated_at: "2026-08-13T12:30:00Z" },
  ]);
  assert.equal(adapter.discover()[0].title, "Newest rename");

  const messages = adapter.load(sessions[0]);
  assert.deepEqual(messages.map((message) => message.role), ["user", "tool", "assistant", "user"]);
  assert.equal(messages[0].content, "Build the thing", "a prompt logged as event and response items appears once");
  assert.equal(messages[3].content, "Untracked follow-up");
  assert.equal(messages[2].model, "gpt-test");
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

  const archived = path.join(home, "archived_sessions", "archived-copy.jsonl");
  fs.mkdirSync(path.dirname(archived), { recursive: true });
  writeJsonl(archived, [
    { type: "session_meta", payload: { id: "large-session", timestamp: "2026-08-12T12:00:00Z" } },
    { type: "response_item", timestamp: "2026-08-12T12:01:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Old copy" }] } },
  ]);
  fs.utimesSync(archived, new Date("2026-08-15T00:00:00Z"), new Date("2026-08-15T00:00:00Z"));

  const [session] = createCodexAdapter({ home }).discover();
  assert.equal(session.title, "Find me after the large metadata");
  assert.equal(session.project, "/work/large");
  assert.equal(session.updatedAt, Date.parse("2026-08-13T12:05:00Z"));
  assert.equal(session.filePath, file);
  assert.equal(createCodexAdapter({ home }).discover({ query: "large-session" })[0].filePath, file);
});

test("titles Claude sessions by rename, then AI title, then first real prompt, and skips hidden records", (context) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "push-session-claude-titles-"));
  context.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const projectDir = path.join(home, "projects", "-lossy-project-slug");
  fs.mkdirSync(path.join(projectDir, "main", "subagents"), { recursive: true });
  const prompt = (text, extra = {}) => ({ type: "user", timestamp: "2026-08-13T12:00:00Z", message: { content: text }, ...extra });
  writeJsonl(path.join(projectDir, "renamed.jsonl"), [
    prompt("/compact"),
    prompt("<command-name>/model</command-name>"),
    prompt("Caveat: injected", { isMeta: true }),
    prompt("Real prompt\nsecond line", { cwd: "/work/from-transcript" }),
    { type: "assistant", timestamp: "2026-08-13T12:10:00Z", message: { model: "<synthetic>", content: [{ type: "text", text: "API error" }] } },
    { type: "custom-title", customTitle: "First rename", sessionId: "renamed" },
    // Enough filler that the newest title records fall outside the prefix read.
    ...Array.from({ length: 60 }, (_, index) => ({ type: "progress", timestamp: "2026-08-13T12:10:00Z", data: `${index}:${"x".repeat(40_000)}` })),
    { type: "ai-title", aiTitle: "Generated title", sessionId: "renamed" },
    { type: "custom-title", customTitle: "Final rename", sessionId: "renamed" },
  ]);
  writeJsonl(path.join(projectDir, "generated.jsonl"), [
    prompt("Derived only"),
    { type: "ai-title", aiTitle: "Generated wins over derived" },
    { type: "custom-title", customTitle: "Cleared" },
    { type: "custom-title", customTitle: "" },
  ]);
  writeJsonl(path.join(projectDir, "derived.jsonl"), [
    prompt("Summary of earlier work", { isCompactSummary: true }),
    prompt("Derived from the first real prompt"),
  ]);
  writeJsonl(path.join(projectDir, "side.jsonl"), [prompt("Subagent prompt", { isSidechain: true })]);
  writeJsonl(path.join(projectDir, "main", "subagents", "agent-1.jsonl"), [prompt("Nested subagent")]);

  const adapter = createClaudeAdapter({ home });
  const sessions = adapter.discover();
  const titles = Object.fromEntries(sessions.map((session) => [session.id, session.title]));
  assert.deepEqual(titles, {
    renamed: "Final rename",
    generated: "Generated wins over derived",
    derived: "Derived from the first real prompt",
  });
  const renamed = sessions.find((session) => session.id === "renamed");
  assert.equal(renamed.project, "/work/from-transcript");
  assert.equal(renamed.model, undefined);
  assert.equal(renamed.updatedAt, Date.parse("2026-08-13T12:10:00Z"));
  const derived = adapter.load(sessions.find((session) => session.id === "derived"));
  assert.deepEqual(derived.map((message) => message.content), ["Derived from the first real prompt"]);
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
  assert.equal(sessions[0].updatedAt, Date.parse("2026-08-13T12:11:00Z"));
  assert.equal(sessions[0].messageCount, 2);
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
    { type: "session_info", id: "named", parentId: "user", name: "Abandoned name" },
    { type: "session_info", id: "cleared", parentId: "user", name: "" },
    { type: "message", id: "empty", parentId: "user", timestamp: "2026-08-13T12:02:00Z", message: { role: "assistant", content: null } },
  ]);
  writeJsonl(path.join(sessionDir, "nested", "ignored.jsonl"), [
    { type: "session", version: 3, id: "ignored", timestamp: "2026-08-13T13:00:00Z", cwd: "/work/ignored" },
  ]);

  const [session] = createPiAdapter({ home }).discover();
  assert.equal(session.id, "custom-pi-session");
  assert.equal(session.title, "Custom directory", "the latest session_info, even on another branch, clears the name");
});

function writeJsonl(filePath, entries) {
  fs.writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

test("discovers T3 threads and maps messages and completed tool activity", async (context) => {
  const { execFileSync } = await import("node:child_process");
  const { createT3Adapter } = await import("../src/agents/t3.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "push-session-t3-"));
  context.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, "userdata"));
  const file = path.join(home, "userdata", "state.sqlite");
  execFileSync("sqlite3", [file], { input: `
    CREATE TABLE projection_projects (project_id TEXT, workspace_root TEXT);
    CREATE TABLE projection_threads (thread_id TEXT, project_id TEXT, title TEXT, worktree_path TEXT, model_selection_json TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT);
    CREATE TABLE projection_thread_messages (thread_id TEXT, role TEXT, text TEXT, created_at TEXT);
    CREATE TABLE projection_thread_activities (thread_id TEXT, activity_id TEXT, kind TEXT, summary TEXT, payload_json TEXT, created_at TEXT);
    INSERT INTO projection_projects VALUES ('project', '/work/demo');
    INSERT INTO projection_threads VALUES ('t3-session', 'project', 'Renamed thread', NULL, '{"model":"gpt-test"}', '2026-08-13T12:00:00Z', '2026-08-13T12:03:00Z', NULL);
    INSERT INTO projection_threads SELECT 'deleted', project_id, title, worktree_path, model_selection_json, created_at, updated_at, updated_at FROM projection_threads;
    INSERT INTO projection_thread_messages VALUES ('deleted', 'user', 'Hidden', '2026-08-13T12:00:00Z');
    INSERT INTO projection_thread_messages VALUES ('t3-session', 'user', 'Fix it', '2026-08-13T12:00:00Z');
    INSERT INTO projection_thread_messages VALUES ('t3-session', 'assistant', 'Done', '2026-08-13T12:03:00Z');
    INSERT INTO projection_thread_activities VALUES ('t3-session', 'tool', 'tool.updated', 'Running', '{}', '2026-08-13T12:01:00Z');
    INSERT INTO projection_thread_activities VALUES ('t3-session', 'tool', 'tool.completed', 'Run tests', '{"data":{"toolName":"Bash","input":{"command":"npm test"},"result":{"content":"failed test","is_error":true}}}', '2026-08-13T12:02:00Z');
  ` });
  const adapter = createT3Adapter({ home });
  assert.equal(adapter.installed(), true);
  const [session] = adapter.discover();
  assert.deepEqual(adapter.discover().map((item) => item.id), ["t3-session"]);
  assert.equal(session.title, "Renamed thread");
  assert.equal(session.project, "/work/demo");
  assert.equal(session.messageCount, 2);
  assert.equal(session.model, "gpt-test");
  assert.equal(adapter.discover({ query: "t3-s", limit: 1 })[0].id, session.id);
  assert.deepEqual(adapter.discover({ query: "' OR 1=1 --" }), []);
  const messages = adapter.load(session);
  assert.deepEqual(messages.map((item) => item.role), ["user", "tool", "assistant"]);
  assert.equal(messages[1].name, "Bash");
  assert.deepEqual(messages[1].input, { command: "npm test" });
  assert.equal(messages[1].output, "failed test");
  assert.equal(messages[1].status, "failed");
  assert.equal(messages[2].content, "Done");

  // Upgrading leaves the V1 file frozen. New threads live only in the V2 copy.
  const v2File = path.join(home, "userdata", "statev2.sqlite");
  execFileSync("sqlite3", [v2File], { input: `
    CREATE TABLE projection_projects (project_id TEXT, workspace_root TEXT);
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, project_id TEXT, title TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_messages (thread_id TEXT, role TEXT, created_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_turn_items (thread_id TEXT, turn_item_id TEXT, ordinal INTEGER, type TEXT, status TEXT, updated_at TEXT, payload_json TEXT);
    INSERT INTO projection_projects VALUES ('project', '/work/demo');
    INSERT INTO orchestration_v2_projection_threads VALUES ('v2-session', 'project', 'Active V2 thread', '2026-11-01T12:00:00Z', '2026-11-01T12:03:00Z', NULL, '{"modelSelection":{"model":"gpt-v2"},"worktreePath":"/work/v2"}');
    INSERT INTO orchestration_v2_projection_threads SELECT 'child', project_id, title, created_at, updated_at, NULL, '{"lineage":{"parentThreadId":"v2-session"}}' FROM orchestration_v2_projection_threads;
    INSERT INTO orchestration_v2_projection_threads SELECT 'deleted', project_id, title, created_at, updated_at, updated_at, '{}' FROM orchestration_v2_projection_threads WHERE thread_id = 'v2-session';
    INSERT INTO orchestration_v2_projection_messages VALUES ('child', 'user', '2026-11-01T12:00:00Z', '{"text":"Child prompt"}');
    INSERT INTO orchestration_v2_projection_messages VALUES ('deleted', 'user', '2026-11-01T12:00:00Z', '{"text":"Deleted prompt"}');
    INSERT INTO orchestration_v2_projection_messages VALUES ('v2-session', 'user', '2026-11-01T12:00:00Z', '{"text":"New prompt"}');
    INSERT INTO orchestration_v2_projection_messages VALUES ('v2-session', 'assistant', '2026-11-01T12:03:00Z', '{"text":"New reply"}');
    INSERT INTO orchestration_v2_projection_turn_items VALUES ('v2-session', 'command', 1, 'command_execution', 'failed', '2026-11-01T12:02:00Z', '{"input":"npm test","output":"v2 failure","exitCode":1,"startedAt":"2026-11-01T12:01:00Z"}');
    INSERT INTO orchestration_v2_projection_turn_items VALUES ('v2-session', 'dynamic', 2, 'dynamic_tool', 'completed', '2026-11-01T12:02:00Z', '{"toolName":"Read","input":{"file_path":"src/app.js"},"output":"source contents"}');
  ` });
  const [active] = adapter.discover();
  assert.deepEqual(adapter.discover().map((item) => item.id), ["v2-session"]);
  assert.equal(active.filePath, v2File);
  assert.equal(active.project, "/work/v2");
  assert.equal(active.model, "gpt-v2");
  assert.equal(active.messageCount, 2);
  const current = adapter.load(active);
  assert.deepEqual(current.map((item) => item.role), ["user", "tool", "tool", "assistant"]);
  assert.equal(current[0].content, "New prompt");
  assert.deepEqual(current[1].input, { cmd: "npm test" });
  assert.equal(current[1].output, "v2 failure");
  assert.equal(current[1].status, "failed");
  assert.equal(current[2].name, "Read");
  assert.equal(current[2].output, "source contents");
  assert.equal(current[3].content, "New reply");
  fs.rmSync(file);
  assert.equal(adapter.installed(), true, "fresh V2 installations need no V1 file");
  assert.equal(adapter.discover({ query: "v2-s" })[0].id, "v2-session");
  assert.equal(createT3Adapter({ stateDir: path.dirname(v2File) }).discover()[0].filePath, v2File);
});
