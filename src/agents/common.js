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
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
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
    text.startsWith("<system-reminder>")
  );
}

export function fileStats(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return { createdAt: stat.birthtimeMs, updatedAt: stat.mtimeMs, size: stat.size };
  } catch {
    return { createdAt: null, updatedAt: null, size: 0 };
  }
}
