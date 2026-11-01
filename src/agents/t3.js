import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

import { byRecent, cleanTitle, exists, safeJson, timestamp } from "./common.js";

const require = createRequire(import.meta.url);

// Keep older supported Node releases usable through the system SQLite CLI.
function query(filePath, sql) {
  let DatabaseSync;
  try { ({ DatabaseSync } = require("node:sqlite")); } catch {}
  if (!DatabaseSync) {
    try {
      return JSON.parse(execFileSync("sqlite3", ["-readonly", "-json", filePath, sql], {
        encoding: "utf8", maxBuffer: 128 * 1024 * 1024,
      }) || "[]");
    } catch (error) {
      throw new Error(`Cannot read T3 Code sessions. Use Node 22.13+ or install sqlite3. ${error.message}`, { cause: error });
    }
  }
  const db = new DatabaseSync(filePath, { readOnly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
}

function literal(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function createT3Adapter(options = {}) {
  const home = options.home || process.env.T3CODE_HOME || path.join(os.homedir(), ".t3");
  const filePath = path.join(home, "userdata", "state.sqlite");
  return {
    id: "t3",
    aliases: ["t3code", "t3-code"],
    label: "T3 Code",
    description: "T3 Code threads",
    installed: () => exists(filePath),
    discover(options = {}) {
      if (!exists(filePath)) return [];
      const rows = query(filePath, `
        SELECT t.*, p.workspace_root,
          (SELECT count(*) FROM projection_thread_messages m WHERE m.thread_id = t.thread_id AND m.role IN ('user', 'assistant')) AS message_count
        FROM projection_threads t
        LEFT JOIN projection_projects p ON p.project_id = t.project_id
        WHERE t.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM projection_thread_messages m WHERE m.thread_id = t.thread_id AND m.role = 'user')
        ORDER BY t.updated_at DESC`);
      return rows.filter((row) => !options.query || row.thread_id.startsWith(options.query)).map((row) => ({
        agent: "t3", agentLabel: "T3 Code", id: row.thread_id,
        title: cleanTitle(row.title) || "Untitled T3 Code session",
        project: row.worktree_path || row.workspace_root || null,
        model: safeJson(row.model_selection_json || "null")?.model || row.model,
        createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at),
        messageCount: row.message_count, filePath,
      })).sort(byRecent).slice(0, options.limit || 500);
    },
    load(session) {
      const thread = literal(session.id);
      const messages = query(session.filePath, `SELECT * FROM projection_thread_messages WHERE thread_id = ${thread} ORDER BY created_at, rowid`)
        .filter((row) => ["user", "assistant"].includes(row.role) && row.text?.trim())
        .map((row) => ({ role: row.role, content: row.text, createdAt: row.created_at,
          ...(row.role === "assistant" && session.model && { model: session.model }) }));
      // Completed activities contain the final input and output; updates duplicate them.
      const activities = query(session.filePath, `SELECT * FROM projection_thread_activities WHERE thread_id = ${thread} AND kind = 'tool.completed' ORDER BY created_at, rowid`);
      for (const row of activities) {
        const payload = safeJson(row.payload_json) || {};
        const data = payload.data || {};
        const result = data.result;
        const isError = result?.is_error === true || payload.status === "failed" || result?.exit_code > 0;
        messages.push({ role: "tool", id: row.activity_id, name: data.toolName || payload.itemType || "tool",
          summary: row.summary || payload.detail, input: data.input,
          output: result?.content ?? result ?? payload.detail,
          status: isError ? "failed" : "completed", isError, createdAt: row.created_at });
      }
      return messages.sort((a, b) => timestamp(a.createdAt) - timestamp(b.createdAt));
    },
  };
}
