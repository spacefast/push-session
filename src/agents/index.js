import { createClaudeAdapter } from "./claude.js";
import { createCodexAdapter } from "./codex.js";
import { createCursorAdapter } from "./cursor.js";
import { createGeminiAdapter } from "./gemini.js";
import { createPiAdapter } from "./pi.js";
import { createT3Adapter } from "./t3.js";

export const adapters = [
  createT3Adapter(),
  createCodexAdapter(),
  createClaudeAdapter(),
  createGeminiAdapter(),
  createCursorAdapter(),
  createPiAdapter(),
];

export function findAdapter(name, available = adapters) {
  if (!name) return null;
  const normalized = name.toLowerCase();
  return available.find((adapter) => adapter.id === normalized || adapter.aliases.includes(normalized)) || null;
}

export function scanAgents(available = adapters, options = {}) {
  return available
    .filter((adapter) => adapter.installed())
    .map((adapter) => {
      try {
        return { adapter, sessions: adapter.discover(options) };
      } catch (error) {
        options.onError?.(adapter, error);
        return { adapter, sessions: [] };
      }
    })
    .filter((entry) => entry.sessions.length > 0);
}
