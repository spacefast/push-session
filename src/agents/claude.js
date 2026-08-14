import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  cleanTitle,
  contentText,
  exists,
  fileStats,
  isBootstrapMessage,
  readJsonLines,
  readPrefix,
  safeJson,
  timestamp,
} from "./common.js";

export function createClaudeAdapter(options = {}) {
  const home = options.home || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const projectsDir = path.join(home, "projects");

  return {
    id: "claude",
    aliases: ["claude-code"],
    label: "Claude Code",
    description: "Anthropic Claude Code",
    installed: () => exists(projectsDir),
    discover(options = {}) {
      if (!exists(projectsDir)) return [];
      const sessions = [];
      for (const directory of safeDirectories(projectsDir)) {
        const projectDir = path.join(projectsDir, directory);
        const index = readSessionIndex(path.join(projectDir, "sessions-index.json"));
        for (const file of safeFiles(projectDir).filter((name) => name.endsWith(".jsonl") && (!options.query || name.includes(options.query)))) {
          const filePath = path.join(projectDir, file);
          const id = file.slice(0, -6);
          sessions.push(inspectClaudeSession(filePath, id, index.get(id), directory));
        }
      }
      return sessions.filter(Boolean).sort(byRecent).slice(0, options.limit || 500);
    },
    load(session) {
      return parseClaudeMessages(session.filePath);
    },
  };
}

function readSessionIndex(filePath) {
  const map = new Map();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    for (const entry of parsed.entries || []) map.set(entry.sessionId, entry);
  } catch {}
  return map;
}

function inspectClaudeSession(filePath, id, indexed, directory) {
  const stats = fileStats(filePath);
  const peek = peekClaude(filePath);
  const title = cleanTitle(indexed?.firstPrompt || peek.title) || "Untitled Claude session";
  return {
    agent: "claude",
    agentLabel: "Claude Code",
    id,
    title,
    project: indexed?.projectPath || peek.project || decodeProject(directory),
    createdAt: timestamp(indexed?.created) || peek.createdAt || stats.createdAt,
    updatedAt: timestamp(indexed?.modified) || stats.updatedAt,
    messageCount: indexed?.messageCount || peek.messageCount,
    filePath,
  };
}

function peekClaude(filePath) {
  let title;
  let project;
  let createdAt;
  let messageCount = 0;
  for (const line of readPrefix(filePath).split(/\r?\n/).filter(Boolean)) {
    const entry = safeJson(line);
    if (!entry) continue;
    if (!project && entry.cwd) project = entry.cwd;
    if (!createdAt && entry.timestamp) createdAt = timestamp(entry.timestamp);
    if (entry.type === "user" || entry.type === "assistant") messageCount += 1;
    if (!title && entry.type === "user") {
      const value = extractClaudeText(entry.message?.content);
      if (value && !isBootstrapMessage(value)) title = value;
    }
  }
  return { title, project, createdAt, messageCount };
}

function parseClaudeMessages(filePath) {
  const messages = [];
  const tools = new Map();
  for (const entry of readJsonLines(filePath)) {
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    const role = entry.type;
    const content = entry.message?.content;
    if (role === "user") {
      const text = extractClaudeText(content);
      if (text && !isBootstrapMessage(text)) messages.push({ role, content: text, createdAt: entry.timestamp });
      for (const part of Array.isArray(content) ? content : []) {
        if (part?.type === "tool_result") {
          const result = extractClaudeText(part.content);
          const tool = tools.get(part.tool_use_id);
          if (tool) {
            tool.output = result || part.content;
            tool.status = part.is_error ? "failed" : "completed";
            tool.isError = Boolean(part.is_error);
          } else if (result) {
            messages.push({ role: "tool", name: "result", output: result, status: part.is_error ? "failed" : "completed", createdAt: entry.timestamp });
          }
        }
      }
      continue;
    }
    const text = extractClaudeText(content);
    if (text) messages.push({ role, content: text, model: entry.message?.model, createdAt: entry.timestamp });
    for (const part of Array.isArray(content) ? content : []) {
      if (part?.type === "tool_use") {
        const tool = { role: "tool", name: part.name || "tool", input: part.input, status: "completed", createdAt: entry.timestamp };
        messages.push(tool);
        if (part.id) tools.set(part.id, tool);
      }
    }
  }
  return messages;
}

function extractClaudeText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return contentText(
    content.filter((part) => part?.type === "text"),
    new Set(["text"]),
  );
}

function safeDirectories(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function safeFiles(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function decodeProject(directory) {
  return directory.startsWith("-") ? directory.replace(/-/g, "/") : directory;
}

function byRecent(a, b) {
  return (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0);
}
