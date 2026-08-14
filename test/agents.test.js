import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createClaudeAdapter } from "../src/agents/claude.js";
import { createCodexAdapter } from "../src/agents/codex.js";

test("discovers and maps a Codex session with paired tool output", (context) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "push-session-codex-"));
  context.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const directory = path.join(home, "sessions", "2026", "08", "13");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "rollout-test.jsonl");
  writeJsonl(file, [
    { type: "session_meta", payload: { id: "codex-session", timestamp: "2026-08-13T12:00:00Z", cwd: "/work/demo" } },
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

function writeJsonl(filePath, entries) {
  fs.writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}
