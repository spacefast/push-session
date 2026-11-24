import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { pickPublished } from "../src/published-picker.js";

function terminal() {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 30 });
  let screen = "";
  output.on("data", (chunk) => { screen += chunk; });
  const plain = () => screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  // What was drawn since the last call: the prompt redraws only the lines that changed.
  let seen = 0;
  const drawn = () => { const all = plain(); const fresh = all.slice(seen); seen = all.length; return fresh; };
  const press = async (keys) => { input.write(keys); await new Promise((resolve) => setTimeout(resolve, 20)); };
  return { input, output, drawn, press };
}

const options = [
  { value: "sessions/one", name: "Draft the post", lines: ["✻  Draft the post  Private  2d ago", "https://example.test/__/one"], actions: [{ key: "enter", label: "open" }, { key: "c", label: "make public" }, { key: "u", label: "update" }, { key: "d", label: "delete" }] },
  { value: "sessions/two", name: "Fix the router", lines: ["❋  Fix the router  Public   3d ago", "https://example.test/sessions/two/"], actions: [{ key: "d", label: "delete" }] },
];
const list = (terminalParts, more = {}) => pickPublished({ title: "AI sessions · 2 sessions", options, closed: "the list as it was", ...terminalParts, ...more });

test("the list shows every session with its address, and the keys the one under the cursor takes", async () => {
  const { input, output, drawn, press } = terminal();
  const picked = list({ input, output });
  await press("");
  const first = drawn();
  assert.match(first, /AI sessions · 2 sessions[\s\S]*│❯ ✻  Draft the post[\s\S]*https:\/\/example\.test\/__\/one[\s\S]*│  ❋  Fix the router[\s\S]*https:\/\/example\.test\/sessions\/two\//);
  assert.match(first, /↑\/↓ select • Enter: open • c: make public • u: update • d: delete • Esc: done/);

  await press("\x1b[B");
  const moved = drawn();
  assert.match(moved, /│❯ ❋  Fix the router/);
  assert.match(moved, /↑\/↓ select • d: delete • Esc: done/);

  // A key the session under the cursor does not take does nothing.
  await press("u");
  assert.doesNotMatch(drawn(), /update: /);
  await press("d");
  assert.deepEqual(await picked, { action: "d", value: "sessions/two" });
  assert.match(drawn(), /delete: Fix the router/);
});

test("Enter does a session's Enter action, says so when it has none, and Escape leaves the list as it was", async () => {
  const opening = terminal();
  const opened = list(opening);
  await opening.press("\r");
  assert.deepEqual(await opened, { action: "enter", value: "sessions/one" });
  assert.match(opening.drawn(), /open: Draft the post/);

  // The list opens on the session it is given.
  const { input, output, drawn, press } = terminal();
  const picked = list({ input, output }, { initialValue: "sessions/two" });
  await press("");
  assert.match(drawn(), /│❯ ❋  Fix the router/);
  await press("\r");
  assert.match(drawn(), /Nothing to open: this session has no link\./);
  await press("\x1b");
  assert.equal(await picked, null);
  assert.match(drawn(), /the list as it was/);
});
