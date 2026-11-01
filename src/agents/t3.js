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
  const stateDir = options.stateDir || process.env.T3CODE_STATE_DIR || path.join(home, "userdata");
  const databasePath = () => ["statev2.sqlite", "state.sqlite"].map((name) => path.join(stateDir, name)).find(exists);
  return {
    id: "t3",
    aliases: ["t3code", "t3-code"],
    label: "T3 Code",
    description: "T3 Code threads",
    installed: () => Boolean(databasePath()),
    discover(options = {}) {
      const filePath = databasePath();
      if (!filePath) return [];
      if (hasV2Schema(filePath)) return discoverV2(filePath, options);
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
      if (hasV2Schema(session.filePath)) return loadV2(session);
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

function hasV2Schema(filePath) {
  return query(filePath, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orchestration_v2_projection_threads'").length > 0;
}

function discoverV2(filePath, options) {
  const rows = query(filePath, `
    SELECT t.*, p.workspace_root,
      (SELECT count(*) FROM orchestration_v2_projection_messages m WHERE m.thread_id = t.thread_id AND m.role IN ('user', 'assistant')) AS message_count
    FROM orchestration_v2_projection_threads t
    LEFT JOIN projection_projects p ON p.project_id = t.project_id
    WHERE t.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM orchestration_v2_projection_messages m WHERE m.thread_id = t.thread_id AND m.role = 'user')
    ORDER BY t.updated_at DESC`);
  return rows.filter((row) => !options.query || row.thread_id.startsWith(options.query)).flatMap((row) => {
    const thread = safeJson(row.payload_json) || {};
    if (thread.lineage?.relationshipToParent === "subagent" || thread.lineage?.sideChat === true) return [];
    return [{
      agent: "t3", agentLabel: "T3 Code", id: row.thread_id,
      title: cleanTitle(row.title) || "Untitled T3 Code session",
      project: thread.worktreePath || row.workspace_root || null,
      model: thread.modelSelection?.model,
      createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at),
      messageCount: row.message_count, filePath,
    }];
  }).sort(byRecent).slice(0, options.limit || 500);
}

function loadV2(session) {
  const thread = literal(session.id);
  const messages = query(session.filePath, `SELECT * FROM orchestration_v2_projection_messages WHERE thread_id = ${thread} ORDER BY created_at, rowid`)
    .flatMap((row) => {
      const message = safeJson(row.payload_json);
      if (!["user", "assistant"].includes(row.role) || !message?.text?.trim()) return [];
      return [{ role: row.role, content: message.text, createdAt: row.created_at,
        ...(row.role === "assistant" && session.model && { model: session.model }) }];
    });
  const tools = query(session.filePath, `SELECT * FROM orchestration_v2_projection_turn_items WHERE thread_id = ${thread} AND type IN ('command_execution', 'dynamic_tool', 'file_change', 'file_search', 'web_search') ORDER BY ordinal`);
  for (const row of tools) {
    const item = safeJson(row.payload_json) || {};
    const name = item.toolName || { command_execution: "exec_command", file_change: "apply_patch", file_search: "file_search", web_search: "web_search" }[row.type] || "tool";
    const isError = row.status === "failed" || item.outputIndicatesFailure === true || (typeof item.exitCode === "number" && item.exitCode !== 0);
    messages.push({ role: "tool", id: row.turn_item_id, name, summary: item.title,
      input: row.type === "command_execution" ? { cmd: item.input } : item.input,
      output: item.output ?? item.diffStr ?? item.changes ?? item.results,
      status: isError ? "failed" : row.status, isError,
      createdAt: item.startedAt || row.updated_at });
  }
  return messages.sort((a, b) => timestamp(a.createdAt) - timestamp(b.createdAt));
}
