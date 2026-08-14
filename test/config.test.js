import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { configPath, loadConfig, saveConfig } from "../src/config.js";

test("stores reusable session-space credentials in one user-global config", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "push-session-config-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { XDG_CONFIG_HOME: root };

  assert.equal(configPath(env), path.join(root, "push-session", "config.json"));
  saveConfig({
    version: 1,
    space: { id: "spc_global", accessToken: "continued-access" },
  }, env);

  assert.deepEqual(loadConfig(env).space, {
    id: "spc_global",
    accessToken: "continued-access",
  });
  assert.equal(fs.statSync(configPath(env)).mode & 0o777, 0o600);
});
