import { createClaudeAdapter } from "./claude.js";
import { createCodexAdapter } from "./codex.js";
import { createCursorAdapter } from "./cursor.js";
import { createGeminiAdapter } from "./gemini.js";

export const adapters = [
  createCodexAdapter(),
  createClaudeAdapter(),
  createGeminiAdapter(),
  createCursorAdapter(),
];

export function findAdapter(name, available = adapters) {
  if (!name) return null;
  const normalized = name.toLowerCase();
  return available.find((adapter) => adapter.id === normalized || adapter.aliases.includes(normalized)) || null;
}

export function scanAgents(available = adapters, options = {}) {
  return available
    .filter((adapter) => adapter.installed())
    .map((adapter) => ({ adapter, sessions: adapter.discover(options) }))
    .filter((entry) => entry.sessions.length > 0);
}
