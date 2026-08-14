import os from "node:os";
import path from "node:path";

import {
  byRecent,
  cleanTitle,
  contentText,
  exists,
  fileStats,
  isBootstrapMessage,
  isTitleMessage,
  latestJsonLineTimestamp,
  readJsonLines,
  readPrefix,
  safeJson,
  timestamp,
  walkFiles,
} from "./common.js";

const USER_TYPES = new Set(["input_text", "text"]);
const ASSISTANT_TYPES = new Set(["output_text", "text"]);

export function createCodexAdapter(options = {}) {
  const home = options.home || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const roots = [path.join(home, "sessions"), path.join(home, "archived_sessions")];

  return {
    id: "codex",
    aliases: ["openai-codex"],
    label: "Codex",
    description: "OpenAI Codex CLI",
    installed: () => roots.some(exists),
    discover(options = {}) {
      const seen = new Set();
      const sessions = [];
      const candidates = [];
      for (const root of roots) {
        for (const filePath of walkFiles(root, (_file, name) => name.endsWith(".jsonl"))) {
          if (options.query && !path.basename(filePath).includes(options.query)) continue;
          candidates.push({ filePath, stats: fileStats(filePath) });
        }
      }
      candidates.sort((left, right) => right.stats.updatedAt - left.stats.updatedAt);
      const limit = options.limit || 500;
      for (const candidate of candidates) {
        const session = inspectCodexSession(candidate.filePath, candidate.stats);
        if (!session || seen.has(session.id)) continue;
        seen.add(session.id);
        sessions.push(session);
        if (sessions.length >= limit) break;
      }
      return sessions.sort(byRecent);
    },
    load(session) {
      return parseCodexMessages(session.filePath);
    },
  };
}

function inspectCodexSession(filePath, knownStats) {
  const lines = readPrefix(filePath, 2 * 1024 * 1024).split(/\r?\n/).filter(Boolean);
  let metadata;
  let title;
  let messageCount = 0;
  for (const line of lines) {
    const entry = safeJson(line);
    if (!entry) continue;
    if (!metadata && entry.type === "session_meta") metadata = entry.payload || {};
    if (entry.type !== "response_item" || entry.payload?.type !== "message") continue;
    const role = entry.payload.role;
    if (role === "user" || role === "assistant") messageCount += 1;
    if (!title && role === "user") {
      const value = contentText(entry.payload.content, USER_TYPES);
      if (isTitleMessage(value)) title = cleanTitle(value);
    }
  }
  if (!metadata) return null;
  const stats = knownStats || fileStats(filePath);
  return {
    agent: "codex",
    agentLabel: "Codex",
    id: metadata.id || path.basename(filePath, ".jsonl").replace(/^rollout-[^-]+-/, ""),
    title: cleanTitle(metadata.name || metadata.title) || title || "Untitled Codex session",
    project: metadata.cwd || null,
    createdAt: timestamp(metadata.timestamp) || stats.createdAt,
    updatedAt: latestJsonLineTimestamp(filePath) || stats.updatedAt,
    messageCount,
    filePath,
  };
}

function parseCodexMessages(filePath) {
  const messages = [];
  const tools = new Map();
  for (const entry of readJsonLines(filePath)) {
    if (entry.type !== "response_item" || !entry.payload) continue;
    const payload = entry.payload;
    if (payload.type === "message") {
      if (payload.role === "user") {
        const content = contentText(payload.content, USER_TYPES);
        if (content && !isBootstrapMessage(content)) messages.push({ role: "user", content, createdAt: entry.timestamp });
      } else if (payload.role === "assistant") {
        const content = contentText(payload.content, ASSISTANT_TYPES);
        if (content) messages.push({ role: "assistant", content, createdAt: entry.timestamp });
      }
      continue;
    }
    if (["function_call", "custom_tool_call", "web_search_call"].includes(payload.type)) {
      const name = payload.name || (payload.type === "web_search_call" ? "web_search" : "tool");
      const args = payload.arguments ?? payload.input ?? payload.query;
      const input = args ? parseMaybeJson(args) : undefined;
      const tool = {
        role: "tool",
        name,
        input,
        summary: toolSummary(name, input),
        status: "completed",
        createdAt: entry.timestamp,
      };
      messages.push(tool);
      if (payload.call_id) tools.set(payload.call_id, tool);
      continue;
    }
    if (["function_call_output", "custom_tool_call_output"].includes(payload.type)) {
      const parsed = parseMaybeJson(payload.output);
      const existing = tools.get(payload.call_id);
      if (existing) {
        existing.output = extractOutput(parsed);
        existing.status = toolFailed(parsed) ? "failed" : "completed";
        existing.isError = existing.status === "failed";
      } else {
        messages.push({
          role: "tool",
          name: payload.name || "tool",
          output: extractOutput(parsed),
          status: toolFailed(parsed) ? "failed" : "completed",
          createdAt: entry.timestamp,
        });
      }
    }
  }
  return coalesce(messages);
}

function extractOutput(value) {
  return value && typeof value === "object" && "output" in value ? value.output : value;
}

function toolFailed(value) {
  if (!value || typeof value !== "object") return false;
  const code = value.exit_code ?? value.exitCode;
  return value.is_error === true || value.isError === true || (typeof code === "number" && code !== 0);
}

function toolSummary(name, input) {
  if (!input || typeof input !== "object") return typeof input === "string" ? cleanTitle(input, 160) : null;
  if (name === "exec_command") return cleanTitle(input.cmd, 160);
  if (name === "view_image") return cleanTitle(input.path, 160);
  if (name === "web_search") return cleanTitle(input.query || input.q, 160);
  return null;
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  return safeJson(value) ?? value;
}

function coalesce(messages) {
  const result = [];
  for (const message of messages) {
    const previous = result.at(-1);
    if (previous && message.role !== "tool" && previous.role === message.role) {
      previous.content += `\n\n${message.content}`;
    } else {
      result.push(message);
    }
  }
  return result;
}
