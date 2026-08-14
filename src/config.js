import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

function normalizeConfig(input) {
  const config = { version: 1 };
  if (typeof input?.apiUrl === "string") config.apiUrl = input.apiUrl;
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
