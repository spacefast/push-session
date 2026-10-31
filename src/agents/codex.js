import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  byRecent,
  cleanTitle,
  CODEX_TITLE_PREAMBLE,
  contentText,
  deriveTitle,
  exists,
  fileStats,
  isBootstrapMessage,
  isSyntheticUserText,
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
      const renames = readSessionIndex(path.join(home, "session_index.jsonl"));
      const sessions = new Map();
      const candidates = [];
      for (const root of roots) {
        for (const filePath of walkFiles(root, (_file, name) => name.endsWith(".jsonl"))) {
          candidates.push({ filePath, stats: fileStats(filePath) });
        }
      }
      candidates.sort((left, right) => right.stats.updatedAt - left.stats.updatedAt);
      const limit = options.limit || 500;
      for (const candidate of candidates) {
        if (options.query) {
          const id = peekCodexId(candidate.filePath);
          if (id && !id.startsWith(options.query)) continue;
        }
        const session = inspectCodexSession(candidate.filePath, candidate.stats, renames);
        if (!session || (options.query && !session.id.startsWith(options.query))) continue;
        const existing = sessions.get(session.id);
        if (!existing || byRecent(session, existing) < 0) sessions.set(session.id, session);
        if (!options.query && sessions.size >= limit) break;
      }
      return [...sessions.values()].sort(byRecent).slice(0, limit);
    },
    load(session) {
      return parseCodexMessages(session.filePath);
    },
  };
}

function peekCodexId(filePath) {
  const prefix = readPrefix(filePath, 1_024);
  if (!/"type"\s*:\s*"session_meta"/.test(prefix)) return null;
  const match = prefix.match(/"payload"\s*:\s*\{\s*(?:"session_id"\s*:\s*"(?:[^"\\]|\\.)*"\s*,\s*)?"id"\s*:\s*("(?:[^"\\]|\\.)*")/);
  return match ? safeJson(match[1]) : null;
}

// Codex writes native renames to session_index.jsonl; the newest entry per thread wins.
function readSessionIndex(filePath) {
  const renames = new Map();
  let contents;
  try {
    contents = fs.readFileSync(filePath, "utf8");
  } catch {
    return renames;
  }
  for (const line of contents.split(/\r?\n/)) {
    const entry = line ? safeJson(line) : null;
    if (typeof entry?.id !== "string" || typeof entry.thread_name !== "string") continue;
    const updatedAt = timestamp(entry.updated_at) || 0;
    const existing = renames.get(entry.id);
    if (!existing || updatedAt >= existing.updatedAt) renames.set(entry.id, { name: entry.thread_name.trim(), updatedAt });
  }
  return renames;
}

function isSubagentSource(source) {
  return Boolean(source) && typeof source === "object" && !Array.isArray(source) && (Object.hasOwn(source, "subagent") || Object.hasOwn(source, "subAgent"));
}

function codexTitle(text) {
  return deriveTitle(String(text || "").replace(CODEX_TITLE_PREAMBLE, ""));
}

function inspectCodexSession(filePath, knownStats, renames = new Map()) {
  const lines = readPrefix(filePath, 2 * 1024 * 1024).split(/\r?\n/).filter(Boolean);
  let metadata;
  let title;
  let model;
  let hasUserMessage = false;
  let messageCount = 0;
  for (const line of lines) {
    const entry = safeJson(line);
    if (!entry) continue;
    if (!metadata && entry.type === "session_meta") {
      metadata = entry.payload || {};
      if (isSubagentSource(metadata.source)) return null;
      continue;
    }
    if (entry.type === "turn_context" && entry.payload?.model?.trim()) {
      model = entry.payload.model.trim();
      continue;
    }
    let text;
    if (entry.type === "event_msg" && entry.payload?.type === "user_message") {
      text = entry.payload.message;
    } else if (entry.type === "response_item" && entry.payload?.type === "message") {
      const role = entry.payload.role;
      if (role === "user" || role === "assistant") messageCount += 1;
      if (role !== "user") continue;
      text = contentText(entry.payload.content, USER_TYPES);
    } else {
      continue;
    }
    const request = String(text || "").replace(CODEX_TITLE_PREAMBLE, "");
    if (isSyntheticUserText(request)) continue;
    hasUserMessage = true;
    title ||= codexTitle(text);
  }
  if (!metadata || !hasUserMessage) return null;
  const stats = knownStats || fileStats(filePath);
  const id = metadata.id || metadata.session_id || path.basename(filePath, ".jsonl").replace(/^rollout-[^-]+-/, "");
  return {
    agent: "codex",
    agentLabel: "Codex",
    id,
    title: cleanTitle(renames.get(id)?.name) || cleanTitle(metadata.name || metadata.title) || title || "Untitled Codex session",
    project: metadata.cwd || null,
    createdAt: timestamp(metadata.timestamp) || stats.createdAt,
    updatedAt: latestJsonLineTimestamp(filePath) || stats.updatedAt,
    messageCount,
    ...(model && { model }),
    filePath,
  };
}

function parseCodexMessages(filePath) {
  const entries = readJsonLines(filePath);
  const canonicalResponseUsers = canonicalResponseUserIndices(entries);
  const messages = [];
  const tools = new Map();
  let model;
  entries.forEach((entry, index) => {
    const payload = entry.payload;
    if (!payload) return;
    if (entry.type === "turn_context" && payload.model) {
      model = payload.model;
      return;
    }
    if (entry.type === "event_msg" && payload.type === "user_message") {
      const content = String(payload.message || "").trim();
      if (!content) return;
      // Codex can log one prompt as both an event and a response item; keep the event text.
      removeMatchingResponseUser(messages, content);
      if (!isBootstrapMessage(content)) messages.push({ role: "user", content, createdAt: entry.timestamp });
      return;
    }
    if (entry.type !== "response_item") return;
    if (payload.type === "message") {
      if (payload.role === "user") {
        const content = contentText(payload.content, USER_TYPES);
        if (!content || canonicalResponseUsers.has(index) || hasMatchingEventUser(messages, content)) return;
        if (!isBootstrapMessage(content)) messages.push({ role: "user", content, createdAt: entry.timestamp, responseUser: true });
      } else if (payload.role === "assistant") {
        const content = contentText(payload.content, ASSISTANT_TYPES);
        if (content) messages.push({ role: "assistant", content, model, createdAt: entry.timestamp });
      }
      return;
    }
    if (["function_call", "custom_tool_call", "web_search_call"].includes(payload.type)) {
      const name = payload.name || (payload.type === "web_search_call" ? "web_search" : "tool");
      const args = payload.arguments ?? payload.input ?? payload.query;
      const input = args ? parseMaybeJson(args) : undefined;
      const tool = {
        role: "tool",
        id: payload.call_id,
        name,
        input,
        summary: toolSummary(name, input),
        status: "completed",
        createdAt: entry.timestamp,
      };
      messages.push(tool);
      if (payload.call_id) tools.set(payload.call_id, tool);
      return;
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
  });
  return coalesce(messages.map(({ responseUser: _responseUser, ...message }) => message));
}

// A turn whose response-item user text matches its event prompt is an expansion of that prompt:
// every response-item user message sharing that turn ID duplicates the event (T3 Code's rule).
function canonicalResponseUserIndices(entries) {
  const canonical = new Set();
  let eventTexts = new Set();
  let responseUsers = [];
  const finishTurn = () => {
    const turnIds = new Set(responseUsers.filter((user) => eventTexts.has(user.text)).map((user) => user.turnId));
    for (const user of responseUsers) if (turnIds.has(user.turnId)) canonical.add(user.index);
    eventTexts = new Set();
    responseUsers = [];
  };
  entries.forEach((entry, index) => {
    const payload = entry.payload;
    if (entry.type === "response_item" && payload?.type === "message" && payload.role === "assistant") {
      finishTurn();
    } else if (entry.type === "event_msg" && payload?.type === "user_message") {
      const text = String(payload.message || "").trim();
      if (text) eventTexts.add(text);
    } else if (entry.type === "response_item" && payload?.type === "message" && payload.role === "user") {
      const turnId = payload.internal_chat_message_metadata_passthrough?.turn_id;
      const text = contentText(payload.content, USER_TYPES);
      if (typeof turnId === "string" && turnId.trim() && text) responseUsers.push({ index, turnId, text });
    }
  });
  finishTurn();
  return canonical;
}

function removeMatchingResponseUser(messages, text) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant") return;
    if (message.responseUser && message.content.trim() === text) {
      messages.splice(index, 1);
      return;
    }
  }
}

function hasMatchingEventUser(messages, text) {
  const comparison = text.trim();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant") return false;
    if (message.role === "user" && !message.responseUser && message.content.trim() === comparison) return true;
  }
  return false;
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
