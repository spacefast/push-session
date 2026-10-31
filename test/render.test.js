import assert from "node:assert/strict";
import test from "node:test";

import { createSharePath, renderSession, renderSessionBundle, toT3WireItem } from "../src/render.js";

const session = {
  agent: "codex",
  agentLabel: "Codex",
  id: "abc",
  title: "A <great> session",
  project: "/work",
  createdAt: 1,
};

test("renders a small T3-wire shell with transcript data in bounded JSON pages", () => {
  const bundle = renderSessionBundle(
    session,
    [
      { role: "user", content: "Hello </script><script>alert(1)</script>" },
      { role: "tool", name: "exec_command", input: { cmd: "npm test" }, output: "ok", status: "completed" },
      { role: "assistant", content: "**Done**" },
    ],
    {
      basePath: "sessions/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222",
      pageItems: 1,
      publishedAt: "2026-08-13T12:00:00Z",
    },
  );

  assert.equal(bundle.pageCount, 3);
  assert.equal(bundle.files.length, 4);
  assert.equal(bundle.entryPath, "sessions/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/index.html");
  const html = bundle.files[0].content;
  assert.match(html, /id="push-session-data"/);
  assert.match(html, /<title>A &lt;great&gt; session · Codex<\/title>/);
  assert.doesNotMatch(html, /Hello <\/script>/);
  assert.doesNotMatch(html, /alert\(1\)/, "transcript content should not be embedded in the shell");
  assert.match(html, /https:\/\/github\.com\/spacefast\/push-session/);
  assert.doesNotMatch(html, /github\.com\/pingdotgg|What you see is parts of/);
  assert.ok(html.length > 100_000, "viewer bundle should be embedded");

  const firstPage = JSON.parse(bundle.files[1].content);
  const toolPage = JSON.parse(bundle.files[2].content);
  assert.equal(firstPage.protocol, "t3code.provider-runtime/v2");
  assert.equal(firstPage.events[0].type, "item.completed");
  assert.equal(firstPage.events[0].payload.itemType, "user_message");
  assert.equal(toolPage.events[0].payload.itemType, "command_execution");
  assert.match(toolPage.events[0].payload.detail, /Input\n\{\n  "cmd": "npm test"/);
  assert.equal(toolPage.events[0].payload.data.label, "npm test");
  assert.equal(toolPage.events[0].payload.data.action, "command");
});

test("uses the session ID as the single route segment", () => {
  assert.equal(createSharePath("agent/session id"), "sessions/agent-session-id");
  assert.match(createSharePath(), /^sessions\/[0-9a-f]{8}-[0-9a-f-]{27}$/);

  const bundle = renderSessionBundle(session, [{ role: "assistant", content: "Done" }]);
  assert.equal(bundle.basePath, "sessions/abc");
  assert.equal(bundle.entryPath, "sessions/abc/index.html");
});

test("maps adapters into T3 provider-runtime wire language", () => {
  assert.deepEqual(
    toT3WireItem({ role: "tool", name: "apply_patch", input: "patch", output: "done", status: "failed" }, 0),
    {
      eventId: "push-session:event:file_change-1",
      provider: "unknown",
      threadId: "push-session-thread",
      itemId: "file_change-1",
      type: "item.completed",
      createdAt: "1970-01-01T00:00:00.000Z",
      payload: {
        itemType: "file_change",
        status: "failed",
        title: "apply_patch",
        detail: "Input\npatch\n\nOutput\ndone",
        data: { name: "apply_patch", label: "Edited files", action: "edit" },
      },
    },
  );
});

test("renderSession remains a shell-only compatibility helper", () => {
  const html = renderSession(session, [{ role: "assistant", content: "private transcript marker" }]);
  assert.match(html, /push-session-data/);
  assert.doesNotMatch(html, /private transcript marker/);
});

test("splits a single giant wire item without dropping its data", () => {
  const marker = 'large "tool" output\n'.repeat(20_000);
  const bundle = renderSessionBundle(
    session,
    [{ role: "tool", name: "exec_command", output: marker }],
    { basePath: "sessions/a/b", pageBytes: 32 * 1024 },
  );
  assert.ok(bundle.pageCount > 2);
  const events = bundle.files.slice(1).flatMap((file) => JSON.parse(file.content).events);
  assert.equal(events.map((event) => event.payload.detail).join(""), `Output\n${marker}`);
  assert.ok(bundle.files.slice(1).every((file) => Buffer.byteLength(file.content) < 33 * 1024));
});

test("labels tool calls with T3 Code's work-log vocabulary", () => {
  const label = (message) => toT3WireItem({ role: "tool", ...message }, 0, { project: "/work" }).payload.data;
  assert.deepEqual(label({ name: "Read", input: { file_path: "/work/src/app.js" } }), {
    name: "Read", label: "Read src/app.js", action: "read", paths: ["src/app.js"],
  });
  assert.equal(label({ name: "Grep", input: { pattern: "TODO", path: "/work/src" } }).label, "Searched TODO in src");
  assert.equal(label({ name: "exec_command", input: { cmd: ["bash", "-lc", "npm test"] } }).label, "npm test");
  assert.equal(label({ name: "mcp__github__create_issue", input: {} }).label, "github: create issue");
  assert.equal(label({ name: "apply_patch", input: "*** Begin Patch\n*** Update File: a.js\n*** Update File: b.js\n" }).label, "Edited a.js +1 more");
});
