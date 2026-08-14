import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { cleanTitle, contentText, exists, fileStats, readJsonLines } from "./common.js";

export function createCursorAdapter(options = {}) {
  const home = options.home || path.join(os.homedir(), ".cursor");
  const projectsDir = path.join(home, "projects");

  return {
    id: "cursor",
    aliases: ["cursor-agent"],
    label: "Cursor Agent",
    description: "Cursor Agent transcripts",
    installed: () => exists(projectsDir),
    discover(options = {}) {
      const sessions = [];
      for (const project of directories(projectsDir)) {
        const transcriptDir = path.join(projectsDir, project, "agent-transcripts");
        for (const transcript of findTranscripts(transcriptDir)) {
          if (options.query && !transcript.id.includes(options.query)) continue;
          const entries = readJsonLines(transcript.filePath);
          const firstUser = entries.find((entry) => entry.role === "user");
          const stats = fileStats(transcript.filePath);
          sessions.push({
            agent: "cursor",
            agentLabel: "Cursor Agent",
            id: transcript.id,
            title: cleanTitle(extractCursorText(firstUser?.message?.content)) || "Untitled Cursor session",
            project: decodeProject(project),
            createdAt: stats.createdAt,
            updatedAt: stats.updatedAt,
            messageCount: entries.filter((entry) => entry.role === "user" || entry.role === "assistant").length,
            filePath: transcript.filePath,
          });
        }
      }
      return sessions.sort(byRecent).slice(0, options.limit || 500);
    },
    load(session) {
      const messages = [];
      for (const entry of readJsonLines(session.filePath)) {
        if (entry.role !== "user" && entry.role !== "assistant") continue;
        const content = cleanCursorText(extractCursorText(entry.message?.content));
        if (content) messages.push({ role: entry.role, content, createdAt: entry.timestamp });
      }
      return messages;
    },
  };
}

function findTranscripts(root) {
  const result = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      result.push({ id: entry.name.slice(0, -6), filePath: path.join(root, entry.name) });
    } else if (entry.isDirectory()) {
      const nested = path.join(root, entry.name, `${entry.name}.jsonl`);
      if (exists(nested)) result.push({ id: entry.name, filePath: nested });
    }
  }
  return result;
}

function extractCursorText(content) {
  return contentText(content, new Set(["text"]));
}

function cleanCursorText(value) {
  return String(value || "")
    .replace(/<\/?user_query>/g, "")
    .replace(/<attached_files>[\s\S]*?<\/attached_files>/g, "")
    .replace(/<image_files>[\s\S]*?<\/image_files>/g, "[image]")
    .trim();
}

function directories(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function decodeProject(name) {
  const value = `/${name.replace(/-/g, "/")}`;
  return exists(value) ? value : name;
}

function byRecent(a, b) {
  return (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0);
}
