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
  assert.throws(() => parseArgs(["--pick-space", "--space", "spc_one"]), /--space and --pick-space cannot be used together/);
  assert.throws(() => parseArgs(["codex", "one", "--limit=2x"]), /integer between 1 and 500/);
  assert.throws(() => parseArgs(["codex", "one", "--space="]), /requires a value/);
  assert.throws(() => parseArgs(["codex", "one", "--api-url", "https://api.example/other"]), /HTTPS origin or an HTTP loopback origin/);
  assert.equal(parseArgs([], { SPACEFAST_API_URL: "https://api.example/" }).options.apiUrl, "https://api.example");
});

test("parses PR references, optional branch lookup, and consent", () => {
  assert.equal(parseArgs(["claude", "--pr"]).options.pr, true);
  const result = parseArgs(["claude", "session-one", "--pr", "--yes", "--format", "markdown"]);
  assert.equal(result.sessionId, "session-one");
  assert.equal(result.options.pr, true);
  assert.equal(result.options.yes, true);
  assert.equal(result.options.format, "markdown");
  assert.equal(parseArgs(["claude", "--pr", "42"]).options.pr, "42");
  assert.equal(parseArgs(["--pr=42"]).options.pr, "42");
  const url = "https://github.com/owner/repo/pull/42";
  assert.equal(parseArgs(["--pr", url]).options.pr, url);
  assert.equal(parseArgs([`--pr=${url}`]).options.pr, url);
  assert.equal(parseArgs([]).options.pr, false);
  assert.equal(parseArgs([]).options.yes, false);
});

test("supports output formats and keeps --json as an alias with last option winning", () => {
  assert.equal(parseArgs([]).options.format, "text");
  assert.equal(parseArgs(["--format=markdown"]).options.format, "markdown");
  assert.equal(parseArgs(["--format", "json"]).options.json, true);
  assert.equal(parseArgs(["--json"]).options.format, "json");
  assert.equal(parseArgs(["--json", "--format", "text"]).options.json, false);
  assert.equal(parseArgs(["--format", "markdown", "--json"]).options.format, "json");
});

test("rejects invalid formats and PR values", () => {
  for (const value of ["html", "JSON"]) {
    assert.throws(() => parseArgs(["--format", value]), /--format must be/);
  }
  assert.throws(() => parseArgs(["--format"]), /requires a value/);
  assert.throws(() => parseArgs(["--pr="]), /requires a value/);
  for (const value of ["0", "feature", "https://gitlab.com/o/r/pull/1", "https://github.com/o/r/issues/1"]) {
    assert.throws(() => parseArgs(["--pr", value]), /--pr must be/);
  }
});

test("visibility flags are exclusive and default to unset", () => {
  assert.equal(parseArgs(["codex", "one"], {}).options.visibility, undefined);
  assert.equal(parseArgs(["codex", "one", "--public"], {}).options.visibility, "public");
  assert.equal(parseArgs(["codex", "one", "--private"], {}).options.visibility, "private");
  assert.throws(() => parseArgs(["codex", "one", "--public", "--private"], {}), /cannot be used together/);
});
