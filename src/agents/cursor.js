import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { byRecent, cleanTitle, contentText, exists, fileStats, isBootstrapMessage, isTitleMessage, readJsonLines, timestamp } from "./common.js";

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
        const projectDir = path.join(projectsDir, project);
        const transcriptDir = path.join(projectDir, "agent-transcripts");
        const projectPath = detectProject(projectDir, project);
        for (const transcript of findTranscripts(transcriptDir)) {
          if (options.query && !transcript.id.includes(options.query)) continue;
          const entries = readJsonLines(transcript.filePath);
          const firstUser = entries.find((entry) => entry.role === "user" && isTitleMessage(cleanCursorText(extractCursorText(entry.message?.content))))
            || entries.find((entry) => entry.role === "user");
          const stats = fileStats(transcript.filePath);
          const entryTimestamps = entries.map((entry) => timestamp(entry.timestamp)).filter(Boolean);
          sessions.push({
            agent: "cursor",
            agentLabel: "Cursor Agent",
            id: transcript.id,
            title: cleanTitle(cleanCursorText(extractCursorText(firstUser?.message?.content))) || "Untitled Cursor session",
            project: projectPath,
            createdAt: entryTimestamps.length > 0 ? Math.min(...entryTimestamps) : stats.createdAt,
            updatedAt: entryTimestamps.length > 0 ? Math.max(...entryTimestamps) : stats.updatedAt,
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
        if (content && !isBootstrapMessage(content)) messages.push({ role: entry.role, content, createdAt: entry.timestamp });
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

function detectProject(projectDir, name) {
  for (const metadataFile of [".workspace-trusted", "repo.json"]) {
    try {
      const metadata = JSON.parse(fs.readFileSync(path.join(projectDir, metadataFile), "utf8"));
      const exact = metadata.workspacePath || metadata.projectPath || metadata.rootPath || metadata.path;
      if (typeof exact === "string" && exact) return exact;
    } catch {}
  }
  if (name === "empty-window" || /^\d+$/.test(name)) return null;
  const value = `/${name.replace(/-/g, "/")}`;
  return exists(value) ? value : name;
}
