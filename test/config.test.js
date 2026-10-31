import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveAuth } from "../src/auth.js";
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

  fs.writeFileSync(configPath(env), JSON.stringify({ apiUrl: "file:///tmp/other", space: { id: "spc_global" } }));
  assert.throws(() => loadConfig(env), /HTTPS origin or an HTTP loopback origin/);
  fs.writeFileSync(configPath(env), JSON.stringify({ apiUrl: "http://external.example" }));
  assert.throws(() => loadConfig(env), /HTTPS origin or an HTTP loopback origin/);
  fs.writeFileSync(configPath(env), JSON.stringify({ apiUrl: "http://127.0.0.1:3000" }));
  assert.equal(loadConfig(env).apiUrl, "http://127.0.0.1:3000");
});

test("reuses a live sf login read-only, preferring the keyring and ignoring expired or foreign logins", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "push-session-sf-auth-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { SPACEFAST_HOME: root };
  const login = (overrides) => JSON.stringify({
    accessToken: "sf-token",
    apiUrl: "https://api.spacefast.com",
    expiresAt: "2030-01-01T00:00:00Z",
    account: { email: "me@example.com" },
    ...overrides,
  });
  const authPath = path.join(root, "auth.json");
  const before = Date.parse("2029-01-01T00:00:00Z");

  fs.writeFileSync(authPath, login({ accessToken: "plaintext-token" }));
  assert.equal((await resolveAuth({ env, now: before, keyring: { read: async () => login() } })).accessToken, "sf-token");
  assert.equal((await resolveAuth({ env, now: before, keyring: { read: async () => null } })).accessToken, "plaintext-token");
  assert.equal((await resolveAuth({ env, now: before, keyring: { read: async () => { throw new Error("locked"); } } })).accessToken, "plaintext-token");
  assert.equal(await resolveAuth({ env, now: Date.parse("2031-01-01T00:00:00Z"), keyring: null }), null);
  assert.equal(await resolveAuth({ env, now: before, keyring: null, apiUrl: "https://api.staging.example" }), null);
  assert.equal((await resolveAuth({ env: { ...env, SPACEFAST_TOKEN: "env-token" }, now: before, keyring: null })).source, "env");
  assert.equal(fs.readFileSync(authPath, "utf8"), login({ accessToken: "plaintext-token" }));

  fs.rmSync(authPath);
  fs.symlinkSync(path.join(root, "elsewhere.json"), authPath);
  assert.equal(await resolveAuth({ env, now: before, keyring: null }), null);
});
