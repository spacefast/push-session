import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { apiOrigin } from "./args.js";

export function configPath(env = process.env) {
  if (env.PUSH_SESSION_CONFIG) return path.resolve(env.PUSH_SESSION_CONFIG);
  const root = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(root, "push-session", "config.json");
}

export function loadConfig(env = process.env) {
  const filePath = configPath(env);
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) throw new Error(`Refusing to read symlinked config: ${filePath}`);
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return normalizeConfig(parsed);
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 1 };
    if (error instanceof SyntaxError) throw new Error(`Invalid push-session config at ${filePath}.`);
    throw error;
  }
}

export function saveConfig(config, env = process.env) {
  const filePath = configPath(env);
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      throw new Error(`Refusing to replace symlinked config: ${filePath}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const tempPath = path.join(directory, `.config-${process.pid}-${randomUUID()}.tmp`);
  const normalized = normalizeConfig(config);
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(tempPath, filePath);
    fs.chmodSync(filePath, 0o600);
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return normalized;
}

export function selectPublishState(config, options, env = process.env) {
  const apiUrl = options.apiUrl || config.apiUrl || "https://api.spacefast.com";
  const sameApi = apiUrl === (config.apiUrl || "https://api.spacefast.com");
  const savedSpace = sameApi ? config.space : null;
  const spaceId = options.newSpace ? null : options.space || savedSpace?.id || null;
  const savedAccessToken = spaceId === savedSpace?.id ? savedSpace?.accessToken : null;
  const claimToken = spaceId === savedSpace?.id ? savedSpace?.claimToken : null;
  const accessToken = env.SPACEFAST_TOKEN || savedAccessToken || null;
  if (options.space && !accessToken && !claimToken) {
    throw new Error("Publishing to --space requires SPACEFAST_TOKEN unless it is the saved anonymous space.");
  }
  return {
    apiUrl,
    spaceId,
    claimToken,
    accessToken,
    savedAccessToken,
    reusingGlobalSpace: Boolean(!options.newSpace && !options.space && savedSpace?.id),
    remember: Boolean(options.newSpace || (sameApi && (!options.space || options.space === savedSpace?.id))),
  };
}

export function rememberPublishResult(config, state, result, env = process.env) {
  if (!state.remember) return;
  const continuingSavedAccess = result.space.id === config.space?.id ? state.savedAccessToken : null;
  const persistedAccessToken = result.credential?.accessToken || continuingSavedAccess || undefined;
  saveConfig({
    version: 1,
    apiUrl: state.apiUrl === "https://api.spacefast.com" ? undefined : state.apiUrl,
    space: {
      id: result.space.id,
      liveUrl: result.space.liveUrl,
      accessToken: persistedAccessToken,
      claimToken: persistedAccessToken ? undefined : result.space.claimToken,
      claimUrl: result.space.claimUrl,
      expiresAt: result.space.expiresAt,
    },
  }, env);
}

function normalizeConfig(input) {
  const config = { version: 1 };
  if (typeof input?.apiUrl === "string") config.apiUrl = apiOrigin(input.apiUrl);
  if (input?.space && typeof input.space.id === "string") {
    config.space = {
      id: input.space.id,
      ...(stringField(input.space.liveUrl) && { liveUrl: input.space.liveUrl }),
      ...(stringField(input.space.accessToken) && { accessToken: input.space.accessToken }),
      ...(stringField(input.space.claimToken) && { claimToken: input.space.claimToken }),
      ...(stringField(input.space.claimUrl) && { claimUrl: input.space.claimUrl }),
      ...(stringField(input.space.expiresAt) && { expiresAt: input.space.expiresAt }),
    };
  }
  return config;
}

function stringField(value) {
  return typeof value === "string" && value.length > 0;
}
