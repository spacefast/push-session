import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  byRecent,
  cleanTitle,
  contentText,
  exists,
  fileStats,
  isBootstrapMessage,
  readJsonLines,
  safeJson,
  timestamp,
} from "./common.js";

const TEXT_TYPES = new Set(["text"]);

export function createPiAdapter(options = {}) {
  const agentDir = options.home || process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  const configuredSessionDir =
    options.sessionDir ||
    (!options.home ? process.env.PI_CODING_AGENT_SESSION_DIR : null) ||
    (!options.home ? readConfiguredSessionDir(path.join(process.cwd(), ".pi", "settings.json")) : null) ||
    readConfiguredSessionDir(path.join(agentDir, "settings.json"));
  const sessionsDir = resolveConfiguredPath(configuredSessionDir) || path.join(agentDir, "sessions");
  const customSessionDir = Boolean(configuredSessionDir);

  return {
    id: "pi",
    aliases: ["pi-agent", "pi-coding-agent"],
    label: "Pi",
    description: "Pi coding agent",
    installed: () => exists(sessionsDir),
    discover(discoverOptions = {}) {
      const sessions = listPiSessionFiles(sessionsDir, customSessionDir)
        .map((filePath) => inspectPiSession(filePath))
        .filter(Boolean);
      const query = discoverOptions.query?.toLowerCase();
      const matches = query
        ? sessions.filter(
            (session) =>
              session.id.toLowerCase().includes(query) || path.basename(session.filePath).toLowerCase().includes(query),
          )
        : sessions;
      return matches.sort(byRecent).slice(0, discoverOptions.limit || 500);
    },
    load(session) {
      return parsePiMessages(session.filePath);
    },
  };
}

function readConfiguredSessionDir(filePath) {
  try {
    const settings = safeJson(fs.readFileSync(filePath, "utf8"));
    return typeof settings?.sessionDir === "string" && settings.sessionDir.trim() ? settings.sessionDir : null;
  } catch {
    return null;
  }
}

function resolveConfiguredPath(value) {
  if (!value) return null;
  const expanded = value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
  return path.resolve(expanded);
}

function listPiSessionFiles(root, flat) {
  if (!exists(root)) return [];
  if (flat) return readJsonlFiles(root);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .flatMap((entry) => readJsonlFiles(path.join(root, entry.name)));
}

function readJsonlFiles(directory) {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => path.join(directory, entry.name));
  } catch {
    return [];
  }
}

function inspectPiSession(filePath) {
  const entries = readJsonLines(filePath);
  const header = entries[0];
  if (header?.type !== "session") return null;

  let name;
  let firstMessage;
  let messageCount = 0;
  let lastActivity;
  for (const entry of entries.slice(1)) {
    if (entry.type === "session_info") name = cleanTitle(entry.name) || undefined;
    if (entry.type !== "message") continue;
    messageCount += 1;
    const message = entry.message;
    if (message?.role !== "user" && message?.role !== "assistant") continue;
    const text = contentText(message.content, TEXT_TYPES);
    if (!firstMessage && message.role === "user" && text && !isBootstrapMessage(text)) firstMessage = cleanTitle(text);
    const activity = timestamp(message.timestamp ?? entry.timestamp);
    if (activity !== null) lastActivity = Math.max(lastActivity || 0, activity);
  }

  const stats = fileStats(filePath);
  return {
    agent: "pi",
    agentLabel: "Pi",
    id: String(header.id || path.basename(filePath, ".jsonl")),
    title: name || firstMessage || "Untitled Pi session",
    project: typeof header.cwd === "string" && header.cwd ? header.cwd : null,
    createdAt: timestamp(header.timestamp) || stats.createdAt,
    updatedAt: lastActivity || timestamp(header.timestamp) || stats.updatedAt,
    messageCount,
    filePath,
  };
}

function parsePiMessages(filePath) {
  const entries = activePiBranch(readJsonLines(filePath));
  const messages = [];
  const tools = new Map();

  for (const entry of entries) {
    if (entry.type === "custom_message" && entry.display !== false) {
      const output = contentText(entry.content, TEXT_TYPES);
      if (output) messages.push({ role: "tool", name: entry.customType || "custom", output, status: "completed", createdAt: entry.timestamp });
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;
    const message = entry.message;
    const createdAt = timestamp(message.timestamp ?? entry.timestamp) || entry.timestamp;

    if (message.role === "user") {
      const content = contentText(message.content, TEXT_TYPES);
      if (content && !isBootstrapMessage(content)) messages.push({ role: "user", content, createdAt });
      continue;
    }
    if (message.role === "assistant") {
      appendAssistantContent(messages, tools, message, createdAt);
      continue;
    }
    if (message.role === "toolResult") {
      const output = contentText(message.content, TEXT_TYPES);
      const existing = tools.get(message.toolCallId);
      if (existing) {
        existing.output = output;
        existing.status = message.isError ? "failed" : "completed";
        existing.isError = Boolean(message.isError);
      } else {
        messages.push({
          role: "tool",
          name: message.toolName || "tool",
          output,
          status: message.isError ? "failed" : "completed",
          isError: Boolean(message.isError),
          createdAt,
        });
      }
    }
  }
  return coalesce(messages);
}

function activePiBranch(entries) {
  const branchEntries = entries.filter((entry) => entry?.type !== "session" && entry?.id);
  if (branchEntries.length === 0) return [];
  const byId = new Map(branchEntries.map((entry) => [entry.id, entry]));
  const branch = [];
  const seen = new Set();
  let current = branchEntries.at(-1);
  while (current && !seen.has(current.id)) {
    branch.push(current);
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : null;
  }
  return branch.reverse();
}

function appendAssistantContent(messages, tools, message, createdAt) {
  const parts = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];
  let textParts = [];
  const flushText = () => {
    const content = textParts.map((part) => part.text).filter(Boolean).join("\n").trim();
    if (content) messages.push({ role: "assistant", content, model: message.model, createdAt });
    textParts = [];
  };

  for (const part of parts) {
    if (part?.type === "text") {
      textParts.push(part);
      continue;
    }
    if (part?.type !== "toolCall") continue;
    flushText();
    const tool = {
      role: "tool",
      name: part.name || "tool",
      input: part.arguments,
      summary: summarizeTool(part.name, part.arguments),
      status: "completed",
      createdAt,
    };
    messages.push(tool);
    if (part.id) tools.set(part.id, tool);
  }
  flushText();
}

function summarizeTool(name, input) {
  if (!input || typeof input !== "object") return cleanTitle(input, 160);
  return cleanTitle(input.path || input.file_path || input.cmd || input.command || input.query, 160) || cleanTitle(name, 160);
}

function coalesce(messages) {
  const result = [];
  for (const message of messages) {
    const previous = result.at(-1);
    if (previous && message.role !== "tool" && previous.role === message.role && previous.model === message.model) {
      previous.content += `\n\n${message.content}`;
    } else {
      result.push(message);
    }
  }
  return result;
}
