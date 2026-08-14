import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { byRecent, latestJsonLineTimestamp, timestamp } from "../src/agents/common.js";

test("normalizes epoch timestamps from seconds, milliseconds, and microseconds", () => {
  assert.equal(timestamp(1_786_622_400), 1_786_622_400_000);
  assert.equal(timestamp(1_786_622_400_000), 1_786_622_400_000);
  assert.equal(timestamp(1_786_622_400_000_000), 1_786_622_400_000);
});

test("reads the newest semantic timestamp from a JSONL tail", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "push-session-tail-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "session.jsonl");
  fs.writeFileSync(file, [
    JSON.stringify({ timestamp: "2026-08-13T12:00:00Z", content: "x".repeat(2_000) }),
    JSON.stringify({ timestamp: "2026-08-13T12:05:00Z" }),
    "{partial",
  ].join("\n"));

  assert.equal(latestJsonLineTimestamp(file, 256), Date.parse("2026-08-13T12:05:00Z"));
});

test("sorts sessions deterministically by update time, creation time, then id", () => {
  const sessions = [
    { id: "b", createdAt: 100, updatedAt: 200 },
    { id: "a", createdAt: 100, updatedAt: 200 },
    { id: "new", createdAt: 300, updatedAt: 400 },
  ];
  assert.deepEqual(sessions.sort(byRecent).map((session) => session.id), ["new", "a", "b"]);
});
