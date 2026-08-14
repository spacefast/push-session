import fs from "node:fs";
import path from "node:path";

export function exists(value) {
  try {
    fs.accessSync(value);
    return true;
  } catch {
    return false;
  }
}

export function walkFiles(root, predicate) {
  if (!exists(root)) return [];
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile() && predicate(fullPath, entry.name)) files.push(fullPath);
    }
  }
  return files;
}

export function readPrefix(filePath, maxBytes = 256 * 1024) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, "r");
    const buffer = Buffer.allocUnsafe(maxBytes);
    const bytesRead = fs.readSync(descriptor, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function readTail(filePath, maxBytes = 256 * 1024) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, "r");
    const size = fs.fstatSync(descriptor).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.allocUnsafe(size - start);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, start);
    let value = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) value = value.slice(Math.max(0, value.indexOf("\n") + 1));
    return value;
  } catch {
    return "";
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function readJsonLines(filePath) {
  try {
    return fs
      .readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map(safeJson)
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function cleanTitle(value, max = 100) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

export function timestamp(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const absolute = Math.abs(value);
    if (absolute > 0 && absolute < 100_000_000_000) return value * 1_000;
    if (absolute > 100_000_000_000_000) return value / 1_000;
    return value;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function latestJsonLineTimestamp(filePath, maxBytes = 256 * 1024) {
  const lines = readTail(filePath, maxBytes).split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const entry = safeJson(lines[index]);
    const value = timestamp(entry?.timestamp ?? entry?.createdAt ?? entry?.updatedAt);
    if (value) return value;
  }
  return null;
}

export function latestTimestamp(...values) {
  const valid = values.map(timestamp).filter((value) => value !== null);
  return valid.length > 0 ? Math.max(...valid) : null;
}

export function contentText(content, acceptedTypes) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && (!acceptedTypes || acceptedTypes.has(part.type)))
    .map((part) => part.text || part.content || "")
    .filter((part) => typeof part === "string" && part.trim())
    .join("\n")
    .trim();
}

export function isBootstrapMessage(value) {
  const text = String(value || "").trimStart();
  return (
    text.startsWith("<environment_context>") ||
    text.startsWith("<user_instructions>") ||
    text.startsWith("<system-reminder>") ||
    text.startsWith("<INSTRUCTIONS>") ||
    text.startsWith("# AGENTS.md instructions")
  );
}

export function isTitleMessage(value) {
  const text = String(value || "").trim();
  return Boolean(text) && !isBootstrapMessage(text) && !text.startsWith("/") && !text.startsWith("?");
}

export function byRecent(a, b) {
  const recency = (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0);
  if (recency !== 0) return recency;
  const creation = (b.createdAt || 0) - (a.createdAt || 0);
  if (creation !== 0) return creation;
  return String(a.id).localeCompare(String(b.id));
}

export function fileStats(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return { createdAt: stat.birthtimeMs, updatedAt: stat.mtimeMs, size: stat.size };
  } catch {
    return { createdAt: null, updatedAt: null, size: 0 };
  }
}
