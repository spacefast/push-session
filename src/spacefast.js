import { createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const MAX_PUBLISH_ATTEMPTS = 10;
const MAX_FOLLOW_STEPS = 80;
const DEFAULT_INLINE_LIMIT = 100 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 6;

export async function publishSession(input) {
  const fetchImpl = input.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("push-session requires a Node.js runtime with fetch support.");

  const apiUrl = (input.apiUrl || "https://api.spacefast.com").replace(/\/$/, "");
  const files = prepareFiles(input);
  const entryPath = input.entryPath || files[0]?.path;
  if (!entryPath) throw new Error("No session entry file was provided.");
  const basePath = input.basePath || path.posix.dirname(entryPath);
  const requestedSpace = input.spaceId || null;
  let bearerToken = input.accessToken || input.claimToken || null;
  const idempotencyKey = `push-session-${randomUUID()}`;
  const idempotencyPrincipal = randomBytes(32).toString("hex");
  const publishPayload = {
    ...(requestedSpace && { spaceId: requestedSpace }),
    publishMode: "additive",
    ...(!requestedSpace && { space: { title: "Shared AI sessions" } }),
  };
  const inline = totalFileBytes(files) <= (input.inlineLimitBytes ?? DEFAULT_INLINE_LIMIT);
  let initial;

  for (let attempt = 1; attempt <= MAX_PUBLISH_ATTEMPTS; attempt += 1) {
    const request = inline
      ? inlinePublishRequest(publishPayload, files)
      : manifestPublishRequest(publishPayload, files);
    const response = await fetchImpl(`${apiUrl}/v1/publish?wait=1`, {
      method: "POST",
      headers: {
        ...requestHeaders({ bearerToken, idempotencyKey, idempotencyPrincipal }),
        ...request.headers,
      },
      body: request.body,
    });
    initial = await responseJson(response);
    if (response.ok) break;
    if (initial?.code !== "space_capacity_warming" || attempt === MAX_PUBLISH_ATTEMPTS) {
      throw apiError(response, initial);
    }
    await delay(retryAfterMs(response));
  }

  bearerToken ||= initial?.data?.claim?.key || null;
  const receipt = await settlePublish({
    initial,
    files,
    apiUrl,
    bearerToken,
    fetchImpl,
  });
  const data = receipt?.data;
  const initialData = initial?.data;
  const space = data?.space || initialData?.space;
  if (!space?.id) throw new Error("Spacefast returned a publish receipt without a space ID.");

  const shareLink = await createScopedShareLink({
    apiUrl,
    bearerToken,
    fetchImpl,
    spaceId: space.id,
    entryPath,
    basePath,
    title: input.session?.title,
  });
  const liveUrl = space.liveUrl || initialData?.space?.liveUrl || null;
  const landingUrl = liveUrl ? new URL(entryPath, ensureTrailingSlash(liveUrl)).href : null;
  const claim = data?.claim || initialData?.claim;
  const version = data?.version || initialData?.version;
  const access = data?.access || initialData?.access;

  return {
    receipt,
    route: entryPath,
    basePath,
    shareUrl: shareLink.url,
    landingUrl,
    link: shareLink,
    space: {
      id: space.id,
      liveUrl,
      claimToken: claim?.key || input.claimToken || null,
      claimUrl: claim?.claimUrl || null,
      expiresAt: claim?.expiresAt || null,
    },
    versionUrl: version?.immutableUrl || null,
    accessUrl: access?.url || claim?.url || null,
  };
}

async function settlePublish({ initial, files, apiUrl, bearerToken, fetchImpl }) {
  let receipt = initial;
  for (let step = 0; step < MAX_FOLLOW_STEPS; step += 1) {
    const next = receipt?.data?.next;
    if (!next || next.action === "done") return receipt;
    if (next.action === "upload") {
      const targets = receipt?.data?.upload?.targets;
      if (!Array.isArray(targets) || targets.length === 0) {
        throw new Error("Spacefast requested uploads without providing upload targets.");
      }
      await uploadTargets({ targets, files, apiUrl, fetchImpl });
    }
    const nextUrl = next.url || (next.action === "upload" ? receipt?.data?.upload?.links?.resume : null);
    if (!nextUrl) throw new Error(`Spacefast returned an incomplete ${next.action} step.`);
    if (next.action === "poll") await delay(Math.max(250, (next.retryAfter || 1) * 1_000));
    const response = await fetchImpl(new URL(nextUrl, apiUrl), {
      method: next.action === "poll" ? "GET" : "POST",
      headers: requestHeaders({ bearerToken }),
    });
    receipt = await responseJson(response);
    if (!response.ok) throw apiError(response, receipt);
  }
  throw new Error("Spacefast publish did not settle before the polling limit.");
}

async function uploadTargets({ targets, files, apiUrl, fetchImpl }) {
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  for (let index = 0; index < targets.length; index += UPLOAD_CONCURRENCY) {
    const batch = targets.slice(index, index + UPLOAD_CONCURRENCY);
    await Promise.all(batch.map(async (target) => {
      const file = filesByPath.get(target.path);
      if (!file && target.body?.kind !== "url") throw new Error(`Spacefast requested an unknown file: ${target.path}`);
      const body = target.body?.kind === "url"
        ? JSON.stringify({ url: target.body.url })
        : file.buffer;
      const response = await fetchImpl(new URL(target.url, apiUrl), {
        method: target.method || "PUT",
        headers: {
          ...(target.headers || {}),
          ...(target.body?.kind === "url" && { "content-type": "application/json" }),
        },
        body,
      });
      if (!response.ok) throw new Error(`Spacefast upload failed for ${target.path} (${response.status}).`);
    }));
  }
}

async function createScopedShareLink({ apiUrl, bearerToken, fetchImpl, spaceId, entryPath, basePath, title }) {
  if (!bearerToken) throw new Error("Spacefast published the session but did not return authority to create its private share link.");
  const response = await fetchImpl(`${apiUrl}/v1/spaces/${encodeURIComponent(spaceId)}/share-links`, {
    method: "POST",
    headers: {
      ...requestHeaders({ bearerToken }),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: `Session: ${String(title || "Shared AI session").slice(0, 180)}`,
      landingPath: `/${basePath}`,
      resources: { include: [`/${basePath}`, `/${basePath}/**`] },
      capabilities: ["page.view"],
      target: { kind: "live" },
    }),
  });
  const body = await responseJson(response);
  if (!response.ok) throw apiError(response, body);
  if (!body?.data?.url) throw new Error("Spacefast created a share link without returning its URL.");
  return body.data;
}

function prepareFiles(input) {
  const source = input.files || (input.html !== undefined
    ? [{ path: sessionRoute(input.session), content: input.html, contentType: "text/html; charset=utf-8" }]
    : []);
  return source.map((file) => {
    const buffer = Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content ?? ""));
    return {
      path: normalizeFilePath(file.path),
      contentType: file.contentType || "application/octet-stream",
      buffer,
      size: buffer.byteLength,
      sha256: createHash("sha256").update(buffer).digest("hex"),
    };
  });
}

function inlinePublishRequest(payload, files) {
  const form = new FormData();
  form.append("payload", JSON.stringify(payload));
  for (const file of files) {
    form.append("files", new Blob([file.buffer], { type: file.contentType }), file.path);
  }
  return { body: form, headers: {} };
}

function manifestPublishRequest(payload, files) {
  return {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...payload,
      files: files.map(({ path: filePath, size, contentType, sha256 }) => ({
        path: filePath,
        size,
        contentType,
        sha256,
      })),
    }),
  };
}

function totalFileBytes(files) {
  return files.reduce((total, file) => total + file.size, 0);
}

export function sessionRoute(session) {
  return `sessions/${safeSegment(session?.agent)}/${safeSegment(session?.id)}/index.html`;
}

function normalizeFilePath(value) {
  const normalized = String(value || "").replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((segment) => segment === "..")) {
    throw new Error(`Invalid publish path: ${value}`);
  }
  return normalized;
}

function safeSegment(value) {
  const segment = String(value || "session")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return segment || "session";
}

function requestHeaders({ bearerToken, idempotencyKey, idempotencyPrincipal }) {
  return {
    accept: "application/json",
    "x-spacefast-client": "push-session/0.1.0",
    ...(bearerToken && { authorization: `Bearer ${bearerToken}` }),
    ...(idempotencyKey && { "idempotency-key": idempotencyKey }),
    ...(idempotencyPrincipal && { "x-spacefast-idempotency-principal": idempotencyPrincipal }),
  };
}

async function responseJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Spacefast returned an unreadable response (${response.status}).`);
  }
}

function apiError(response, body) {
  const message = body?.message || body?.detail || body?.title || `Spacefast request failed (${response.status}).`;
  const suggestions = Array.isArray(body?.suggestions) ? ` ${body.suggestions.join(" ")}` : "";
  const error = new Error(`${message}${suggestions}`.trim());
  error.code = body?.code;
  error.status = response.status;
  return error;
}

function retryAfterMs(response) {
  const seconds = Number.parseInt(response.headers.get("retry-after") || "", 10);
  return (Number.isFinite(seconds) ? seconds : 20) * 1_000;
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}
