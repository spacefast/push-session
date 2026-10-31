import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  byRecent,
  cleanTitle,
  contentText,
  deriveTitle,
  exists,
  fileStats,
  isBootstrapMessage,
  isSyntheticUserText,
  readJsonLines,
  readPrefix,
  readTail,
  safeJson,
  timestamp,
} from "./common.js";

const PREFIX_BYTES = 2 * 1024 * 1024;
// Claude appends ai-title and custom-title records as the session goes, so the newest sit near the end.
const TAIL_BYTES = 512 * 1024;
const SYNTHETIC_MODEL = "<synthetic>";

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
      const candidates = [];
      for (const directory of safeDirectories(projectsDir)) {
        const projectDir = path.join(projectsDir, directory);
        // Subagent transcripts live in nested directories, so only top-level files are sessions.
        for (const file of safeFiles(projectDir).filter((name) => name.endsWith(".jsonl") && (!options.query || name.includes(options.query)))) {
          const filePath = path.join(projectDir, file);
          const stats = fileStats(filePath);
          candidates.push({ filePath, id: file.slice(0, -6), stats, fallbackProject: decodeProject(directory) });
        }
      }
      candidates.sort((left, right) => right.stats.updatedAt - left.stats.updatedAt);
      const sessions = [];
      const limit = options.limit || 500;
      for (const candidate of candidates) {
        const session = inspectClaudeSession(candidate);
        if (!session) continue;
        sessions.push(session);
        if (sessions.length >= limit) break;
      }
      return sessions.sort(byRecent);
    },
    load(session) {
      return parseClaudeMessages(session.filePath);
    },
  };
}

function inspectClaudeSession({ filePath, id, stats, fallbackProject }) {
  const prefix = readPrefix(filePath, PREFIX_BYTES).split(/\r?\n/);
  if (stats.size > PREFIX_BYTES) prefix.pop();
  const tail = stats.size > PREFIX_BYTES
    ? readTail(filePath, Math.min(TAIL_BYTES, stats.size - PREFIX_BYTES)).split(/\r?\n/)
    : [];

  let fields = { customTitle: null, aiTitle: null, model: null };
  let project;
  let createdAt;
  let derivedTitle;
  let hasUserMessage = false;
  let messageCount = 0;
  let updatedAt = null;
  for (const line of [...prefix, ...tail]) {
    if (!line) continue;
    const entry = safeJson(line);
    if (!entry) continue;
    updatedAt = timestamp(entry.timestamp) ?? updatedAt;
    if (isHiddenClaudeRecord(entry)) continue;
    fields = foldClaudeFields(fields, entry);
    if (!project && entry.cwd) project = entry.cwd;
    if (!createdAt && entry.timestamp) createdAt = timestamp(entry.timestamp);
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    messageCount += 1;
    if (entry.type !== "user") continue;
    const text = extractClaudeText(entry.message?.content);
    if (isSyntheticUserText(text)) continue;
    hasUserMessage = true;
    derivedTitle ||= deriveTitle(text);
  }
  if (!hasUserMessage) return null;

  return {
    agent: "claude",
    agentLabel: "Claude Code",
    id,
    title: cleanTitle(fields.customTitle) || cleanTitle(fields.aiTitle) || derivedTitle || "Untitled Claude session",
    project: project || fallbackProject,
    createdAt: createdAt || stats.createdAt,
    updatedAt: updatedAt || stats.updatedAt,
    messageCount,
    ...(fields.model && { model: fields.model }),
    filePath,
  };
}

function isHiddenClaudeRecord(entry) {
  return entry.isSidechain === true || entry.isMeta === true || entry.isCompactSummary === true;
}

function foldClaudeFields(fields, entry) {
  const model = entry.message?.model?.trim();
  return {
    // A rename beats the generated title; an empty rename clears it.
    customTitle: typeof entry.customTitle === "string" ? entry.customTitle.trim() || null : fields.customTitle,
    aiTitle: (typeof entry.aiTitle === "string" && entry.aiTitle.trim()) || fields.aiTitle,
    // Claude stamps local error responses with this sentinel instead of a model ID.
    model: model && model !== SYNTHETIC_MODEL ? model : fields.model,
  };
}

function parseClaudeMessages(filePath) {
  const messages = [];
  const tools = new Map();
  for (const entry of readJsonLines(filePath)) {
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    if (isHiddenClaudeRecord(entry)) continue;
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
    const model = entry.message?.model === SYNTHETIC_MODEL ? undefined : entry.message?.model;
    if (text) messages.push({ role, content: text, model, createdAt: entry.timestamp });
    for (const part of Array.isArray(content) ? content : []) {
      if (part?.type === "tool_use") {
        const tool = { role: "tool", id: part.id, name: part.name || "tool", input: part.input, status: "completed", createdAt: entry.timestamp };
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
  if (!directory.startsWith("-")) return directory;
  const decoded = directory.replace(/-/g, "/");
  return exists(decoded) ? decoded : directory;
}
