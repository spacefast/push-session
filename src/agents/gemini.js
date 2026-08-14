import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { cleanTitle, contentText, exists, fileStats, timestamp } from "./common.js";

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
      const sessions = [];
      for (const projectName of directories(projectsDir)) {
        const chatsDir = path.join(projectsDir, projectName, "chats");
        for (const file of files(chatsDir).filter((name) => name.startsWith("session-") && name.endsWith(".json") && (!options.query || name.includes(options.query)))) {
          const filePath = path.join(chatsDir, file);
          const record = readJson(filePath);
          if (!record || !Array.isArray(record.messages)) continue;
          const firstUser = record.messages.find((message) => message.type === "user");
          const stats = fileStats(filePath);
          sessions.push({
            agent: "gemini",
            agentLabel: "Gemini CLI",
            id: record.sessionId || file.slice(0, -5),
            title: cleanTitle(extractGeminiText(firstUser?.content)) || "Untitled Gemini session",
            project: projectMap.get(projectName) || null,
            createdAt: timestamp(record.startTime) || stats.createdAt,
            updatedAt: timestamp(record.lastUpdated) || stats.updatedAt,
            messageCount: record.messages.length,
            filePath,
          });
        }
      }
      return sessions.sort(byRecent).slice(0, options.limit || 500);
    },
    load(session) {
      const record = readJson(session.filePath);
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
  return contentText(content, new Set(["text"]));
}

function loadProjectMap(filePath) {
  const map = new Map();
  const data = readJson(filePath);
  for (const [folder, name] of Object.entries(data?.projects || {})) map.set(name, folder);
  return map;
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

function byRecent(a, b) {
  return (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0);
}
