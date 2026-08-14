import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { byRecent, cleanTitle, contentText, exists, fileStats, isTitleMessage, readJsonLines, timestamp } from "./common.js";

export function createGeminiAdapter(options = {}) {
  const home = options.home || path.join(os.homedir(), ".gemini");
  const projectsDir = path.join(home, "tmp");

  return {
    id: "gemini",
    aliases: ["gemini-cli"],
    label: "Gemini CLI",
    description: "Google Gemini CLI",
    installed: () => exists(projectsDir),
    discover(options = {}) {
      const projectMap = loadProjectMap(path.join(home, "projects.json"));
      const sessions = new Map();
      for (const projectName of directories(projectsDir)) {
        const chatsDir = path.join(projectsDir, projectName, "chats");
        for (const file of files(chatsDir).filter((name) => name.startsWith("session-") && /\.jsonl?$/.test(name))) {
          const filePath = path.join(chatsDir, file);
          const record = readRecord(filePath);
          if (!record || record.kind === "subagent" || !Array.isArray(record.messages)) continue;
          if (options.query && !file.includes(options.query) && !String(record.sessionId || "").startsWith(options.query)) continue;
          const conversationMessages = record.messages.filter((message) => message.type === "user" || message.type === "gemini");
          if (conversationMessages.length === 0) continue;
          const firstUser = record.messages.find((message) => message.type === "user" && isTitleMessage(extractGeminiText(message.content)))
            || record.messages.find((message) => message.type === "user");
          const stats = fileStats(filePath);
          const title = [record.summary, record.displayName, record.firstUserMessage, extractGeminiText(firstUser?.content)].find(isTitleMessage);
          const session = {
            agent: "gemini",
            agentLabel: "Gemini CLI",
            id: record.sessionId || file.replace(/\.jsonl?$/, ""),
            title: cleanTitle(title) || "Untitled Gemini session",
            project: projectMap.get(projectName) || null,
            createdAt: timestamp(record.startTime) || stats.createdAt,
            updatedAt: timestamp(record.lastUpdated) || stats.updatedAt,
            messageCount: record.messageCount ?? conversationMessages.length,
            filePath,
          };
          const existing = sessions.get(session.id);
          if (!existing || byRecent(session, existing) < 0) sessions.set(session.id, session);
        }
      }
      return [...sessions.values()].sort(byRecent).slice(0, options.limit || 500);
    },
    load(session) {
      const record = readRecord(session.filePath);
      if (!record || !Array.isArray(record.messages)) return [];
      const messages = [];
      for (const message of record.messages) {
        if (message.type === "user") {
          const content = extractGeminiText(message.content);
          if (content) messages.push({ role: "user", content, createdAt: message.timestamp });
        } else if (message.type === "gemini") {
          const content = extractGeminiText(message.content || message.displayContent);
          if (content) messages.push({ role: "assistant", content, model: message.model, createdAt: message.timestamp });
          for (const tool of message.toolCalls || []) {
            messages.push({
              role: "tool",
              name: tool.name || "tool",
              input: tool.args,
              output: tool.resultDisplay || tool.result || tool.output || "",
              status: tool.status === "error" ? "failed" : "completed",
              isError: tool.status === "error",
              createdAt: tool.timestamp || message.timestamp,
            });
          }
        }
      }
      return messages;
    },
  };
}

function extractGeminiText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return contentText(content.filter((part) => !part?.type || part.type === "text"));
}

function loadProjectMap(filePath) {
  const map = new Map();
  const data = readJson(filePath);
  for (const [folder, name] of Object.entries(data?.projects || {})) map.set(name, folder);
  return map;
}

function readRecord(filePath) {
  if (!filePath.endsWith(".jsonl")) return readJson(filePath);
  const entries = readJsonLines(filePath);
  if (entries.length === 0) return null;
  const record = { ...entries[0], messages: Array.isArray(entries[0].messages) ? [...entries[0].messages] : [] };
  for (const entry of entries.slice(1)) {
    if (entry.$set && typeof entry.$set === "object") Object.assign(record, entry.$set);
    else if (entry.type) record.messages.push(entry);
  }
  return record;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function directories(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function files(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return [];
  }
}
