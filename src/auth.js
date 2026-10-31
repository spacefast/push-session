import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_API_URL = "https://api.spacefast.com";

// Matches the `sf` CLI's credential store (packages/cli/src/credential-store.ts):
// the OS keyring wins when usable; ~/.spacefast/auth.json is the fallback.
const KEYRING_SERVICE = "Spacefast CLI";
const KEYRING_ACCOUNT = "default";
const MACOS_VALUE_PREFIX = "spacefast-keyring-v1:";

/**
 * Resolves the credential for owned publishing. SPACEFAST_TOKEN wins; otherwise
 * the `sf login` credential is reused read-only. It is never copied into
 * push-session's own config.
 */
export async function resolveAuth({ env = process.env, apiUrl = DEFAULT_API_URL, keyring, platform = process.platform, now = Date.now() } = {}) {
  if (env.SPACEFAST_TOKEN?.trim()) return { accessToken: env.SPACEFAST_TOKEN.trim(), source: "env", account: null };
  let stored;
  try {
    stored = await readSfLogin({ env, keyring, platform });
  } catch {
    return null;
  }
  if (!stored?.accessToken) return null;
  if (stored.expiresAt && !(Date.parse(stored.expiresAt) > now)) return null;
  if (originOf(stored.apiUrl || DEFAULT_API_URL) !== originOf(apiUrl)) return null;
  return { accessToken: stored.accessToken, source: "sf", account: stored.account || null };
}

export async function readSfLogin({ env = process.env, keyring, platform = process.platform } = {}) {
  const store = keyring === undefined ? (useKeyring(env) ? platformKeyring(env, platform) : null) : keyring;
  if (store) {
    let raw = null;
    let keyringFailed = false;
    try {
      raw = await store.read();
    } catch {
      keyringFailed = true;
    }
    if (raw) return parseStoredAuth(raw);
    if (!keyringFailed) {
      const fallback = readPlaintext(env);
      return fallback === null ? null : parseStoredAuth(fallback);
    }
  }
  const fallback = readPlaintext(env);
  return fallback === null ? null : parseStoredAuth(fallback);
}

export function sfStateDir(env = process.env) {
  if (env.SPACEFAST_HOME) return env.SPACEFAST_HOME;
  return path.join(env.SPACEFAST_CLI_HOME || os.homedir(), ".spacefast");
}

function useKeyring(env) {
  const preference = env.SPACEFAST_CREDENTIAL_STORE?.trim().toLowerCase();
  if (preference === "keyring") return true;
  if (preference === "plaintext") return false;
  return !env.SPACEFAST_HOME && !env.SPACEFAST_CLI_HOME && !env.CI;
}

function readPlaintext(env) {
  const authPath = path.join(sfStateDir(env), "auth.json");
  let stat;
  try {
    stat = fs.lstatSync(authPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Refusing to read ${authPath}: not a regular file.`);
  return fs.readFileSync(authPath, "utf8");
}

function parseStoredAuth(raw) {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.accessToken === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function platformKeyring(env, platform) {
  if (platform === "darwin") {
    return {
      async read() {
        const result = await runCommand("/usr/bin/security", ["find-generic-password", "-s", KEYRING_SERVICE, "-a", KEYRING_ACCOUNT, "-w"]);
        if (result.code === 44) return null;
        if (result.code !== 0) throw new Error("macOS Keychain read failed.");
        const value = result.stdout.trim();
        if (!value) return null;
        return value.startsWith(MACOS_VALUE_PREFIX)
          ? Buffer.from(value.slice(MACOS_VALUE_PREFIX.length), "base64url").toString("utf8")
          : value;
      },
    };
  }
  if (platform === "linux") {
    const executable = executableOnPath("secret-tool", env);
    if (!executable) return null;
    return {
      async read() {
        const result = await runCommand(executable, ["lookup", "service", "spacefast-cli", "account", KEYRING_ACCOUNT]);
        if (result.code === 1) return null;
        if (result.code !== 0) throw new Error("Secret Service read failed.");
        return result.stdout.trim() || null;
      },
    };
  }
  return null;
}

function executableOnPath(name, env) {
  for (const directory of (env.PATH || "").split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function runCommand(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Credential keyring command timed out."));
    }, 5_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout });
    });
  });
}

function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
