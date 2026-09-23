import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "../src/args.js";

test("parses the positional agent and session flow", () => {
  const result = parseArgs(["codex", "abc-123", "--json", "--space", "spc_one"]);
  assert.equal(result.agent, "codex");
  assert.equal(result.sessionId, "abc-123");
  assert.equal(result.options.json, true);
  assert.equal(result.options.space, "spc_one");
});

test("supports the interactive agent-only flow", () => {
  const result = parseArgs(["claude", "--limit=25"]);
  assert.equal(result.agent, "claude");
  assert.equal(result.sessionId, undefined);
  assert.equal(result.options.limit, 25);
});

test("rejects conflicting space selection", () => {
  assert.throws(() => parseArgs(["--space", "spc_one", "--new-space"]), /cannot be used together/);
  assert.throws(() => parseArgs(["codex", "one", "--limit=2x"]), /integer between 1 and 500/);
  assert.throws(() => parseArgs(["codex", "one", "--space="]), /requires a value/);
  assert.throws(() => parseArgs(["codex", "one", "--api-url", "https://api.example/other"]), /HTTPS origin or an HTTP loopback origin/);
  assert.equal(parseArgs([], { SPACEFAST_API_URL: "https://api.example/" }).options.apiUrl, "https://api.example");
});
