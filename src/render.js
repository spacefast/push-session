import { randomUUID } from "node:crypto";

import { viewerScript, viewerStyles } from "./viewer-assets.js";

const DEFAULT_PAGE_BYTES = 256 * 1024;
const DEFAULT_PAGE_ITEMS = 100;

export function renderSessionBundle(session, messages, options = {}) {
  const basePath = options.basePath || createSharePath();
  const maxBytes = options.pageBytes || DEFAULT_PAGE_BYTES;
  const sourceItems = messages.map((message, index) => toT3WireItem(message, index, {
    provider: session.agent,
    threadId: session.id,
  }));
  const items = sourceItems.flatMap((item) => splitWireItem(item, Math.max(1_024, maxBytes - 512)));
  const itemPages = partitionItems(items, {
    maxBytes,
    maxItems: options.pageItems || DEFAULT_PAGE_ITEMS,
  });
  const pageNames = itemPages.map((_, index) => `pages/${String(index + 1).padStart(4, "0")}.json`);
  const stats = {
    items: sourceItems.length,
    messages: sourceItems.filter((item) => item.payload.itemType === "user_message" || item.payload.itemType === "assistant_message").length,
    tools: sourceItems.filter((item) => isToolItemType(item.payload.itemType)).length,
    pages: itemPages.length,
  };
  const shell = {
    protocol: "t3code.provider-runtime/v2",
    session: {
      provider: session.agent,
      providerLabel: session.agentLabel,
      threadId: session.id,
      title: session.title,
      project: session.project,
      createdAt: toIso(session.createdAt),
      updatedAt: toIso(session.updatedAt),
    },
    pages: pageNames,
    stats,
    publishedAt: options.publishedAt || new Date().toISOString(),
  };
  const entryPath = `${basePath}/index.html`;
  const files = [
    {
      path: entryPath,
      content: renderShellHtml(session, shell),
      contentType: "text/html; charset=utf-8",
    },
    ...itemPages.map((pageItems, index) => ({
      path: `${basePath}/${pageNames[index]}`,
      content: JSON.stringify({
        protocol: "t3code.provider-runtime/v2",
        page: index + 1,
        events: pageItems,
      }),
      contentType: "application/json; charset=utf-8",
    })),
  ];

  return {
    basePath,
    entryPath,
    files,
    pageCount: itemPages.length,
    totalBytes: files.reduce((total, file) => total + Buffer.byteLength(file.content), 0),
    stats,
  };
}

// Kept as a small compatibility helper for API consumers that only need the shell.
export function renderSession(session, messages, options = {}) {
  return renderSessionBundle(session, messages, options).files[0].content;
}

export function createSharePath() {
  return `sessions/${randomUUID()}/${randomUUID()}`;
}

export function toT3WireItem(message, index, context = {}) {
  const itemType = message.role === "user"
    ? "user_message"
    : message.role === "assistant"
      ? "assistant_message"
      : toolItemType(message.name);
  const status = message.isError || message.status === "failed" ? "failed" : normalizeStatus(message.status);
  const detail = message.role === "tool"
    ? toolDetail(message)
    : String(message.content || "");
  const title = message.role === "tool" ? String(message.name || "Tool call") : undefined;
  const data = compactObject({
    name: message.name,
    model: message.model,
    command: message.command,
    summary: message.summary,
    isError: message.isError || undefined,
  });

  const itemId = message.id || `${itemType}-${index + 1}`;
  return {
    eventId: `push-session:event:${itemId}`,
    provider: context.provider || "unknown",
    threadId: context.threadId || "push-session-thread",
    itemId,
    type: "item.completed",
    createdAt: toIso(message.createdAt) || "1970-01-01T00:00:00.000Z",
    payload: compactObject({
      itemType,
      status,
      title,
      detail: detail || undefined,
      data: Object.keys(data).length > 0 ? data : undefined,
    }),
  };
}

function splitWireItem(item, maxBytes) {
  if (Buffer.byteLength(JSON.stringify(item)) <= maxBytes || !item.payload.detail) return [item];
  const base = { ...item, payload: { ...item.payload, detail: "" } };
  const overhead = Buffer.byteLength(JSON.stringify({
    ...base,
    payload: {
      ...base.payload,
      data: { ...(base.payload.data || {}), wireFragment: { sourceItemId: item.itemId, index: 999999, total: 999999 } },
    },
  }));
  const budget = Math.max(4_096, maxBytes - overhead - 128);
  const pending = splitUtf8(item.payload.detail, budget);
  const chunks = [];
  while (pending.length > 0) {
    const chunk = pending.shift();
    const probe = {
      ...base,
      payload: {
        ...base.payload,
        detail: chunk,
        data: { ...(base.payload.data || {}), wireFragment: { sourceItemId: item.itemId, index: 999999, total: 999999 } },
      },
    };
    const bytes = Buffer.byteLength(JSON.stringify(probe));
    if (bytes <= maxBytes || chunk.length <= 1) {
      chunks.push(chunk);
      continue;
    }
    const splitAt = Math.max(1, Math.floor(chunk.length * (maxBytes / bytes) * 0.9));
    pending.unshift(chunk.slice(0, splitAt), chunk.slice(splitAt));
  }
  return chunks.map((detail, index) => ({
    ...base,
    eventId: `${item.eventId}:fragment:${index + 1}`,
    itemId: `${item.itemId}:fragment:${index + 1}`,
    payload: {
      ...base.payload,
      detail,
      data: {
        ...(base.payload.data || {}),
        wireFragment: { sourceItemId: item.itemId, index: index + 1, total: chunks.length },
      },
    },
  }));
}

function splitUtf8(value, maxBytes) {
  const buffer = Buffer.from(value);
  const chunks = [];
  let start = 0;
  while (start < buffer.length) {
    let end = Math.min(start + maxBytes, buffer.length);
    while (end > start && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end -= 1;
    if (end === start) end = Math.min(start + maxBytes, buffer.length);
    chunks.push(buffer.subarray(start, end).toString("utf8"));
    start = end;
  }
  return chunks;
}

function toolDetail(message) {
  const blocks = [];
  if (message.input !== undefined && message.input !== "") blocks.push(`Input\n${stringValue(message.input)}`);
  const output = message.output ?? message.content;
  if (output !== undefined && output !== "") blocks.push(`Output\n${stringValue(output)}`);
  return blocks.join("\n\n");
}

function renderShellHtml(session, payload) {
  const title = escapeHtml(session.title || `${session.agentLabel} session`);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <meta name="color-scheme" content="light dark">
  <title>${title} · push-session</title>
  <style>${safeStyle(viewerStyles)}</style>
</head>
<body>
  <div id="root"></div>
  <script id="push-session-data" type="application/json">${safeJson(payload)}</script>
  <script>${safeScript(viewerScript)}</script>
</body>
</html>`;
}

function partitionItems(items, { maxBytes, maxItems }) {
  if (items.length === 0) return [[]];
  const pages = [];
  let current = [];
  let currentBytes = 2;
  for (const item of items) {
    const bytes = Buffer.byteLength(JSON.stringify(item)) + (current.length > 0 ? 1 : 0);
    if (current.length > 0 && (current.length >= maxItems || currentBytes + bytes > maxBytes)) {
      pages.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(item);
    currentBytes += bytes;
  }
  if (current.length > 0) pages.push(current);
  return pages;
}

function toolItemType(name) {
  const value = String(name || "").toLowerCase();
  if (/exec|shell|bash|command|terminal/.test(value)) return "command_execution";
  if (/patch|write|edit|file_change/.test(value)) return "file_change";
  if (/web|search_query|image_query/.test(value)) return "web_search";
  if (/view_image|image_view/.test(value)) return "image_view";
  if (/collab|spawn_agent|send_message|wait_agent/.test(value)) return "collab_agent_tool_call";
  if (/^mcp|mcp_/.test(value)) return "mcp_tool_call";
  return "dynamic_tool_call";
}

function isToolItemType(value) {
  return !["user_message", "assistant_message", "reasoning", "plan", "error", "unknown"].includes(value);
}

function normalizeStatus(value) {
  if (value === "in_progress" || value === "running" || value === "inProgress") return "inProgress";
  if (value === "declined") return "declined";
  return "completed";
}

function stringValue(value) {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null));
}

function toIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeJson(value) {
  return JSON.stringify(value)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function safeScript(value) {
  return value.replace(/<\/script/gi, "<\\/script");
}

function safeStyle(value) {
  return value.replace(/<\/style/gi, "<\\/style");
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
