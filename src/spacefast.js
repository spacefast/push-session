import { createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { DEFAULT_API_URL } from "./auth.js";
import { packageVersion } from "./version.js";

const MAX_PUBLISH_ATTEMPTS = 10;
const MAX_FOLLOW_STEPS = 80;
const DEFAULT_INLINE_LIMIT = 100 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 6;
export const MANAGE_SIGN_IN_MESSAGE = "Sign in with `sf login` to manage shared sessions.";

export async function publishSession(input) {
  const fetchImpl = input.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("push-session requires a Node.js runtime with fetch support.");

  const apiUrl = (input.apiUrl || DEFAULT_API_URL).replace(/\/$/, "");
  const files = prepareFiles(input);
  const deletePaths = (input.deletePaths || []).map(normalizeFilePath);
  const deleting = files.length === 0 && deletePaths.length > 0;
  if (deletePaths.length && !input.spaceId) throw new Error("Deleting files requires an existing Space.");
  const entryPath = input.entryPath ? normalizeFilePath(input.entryPath) : files[0]?.path;
  if (!entryPath && !deleting) throw new Error("No session entry file was provided.");
  const basePath = deleting ? null : normalizeFilePath(input.basePath || path.posix.dirname(entryPath));
  if (!deleting && (!entryPath.startsWith(`${basePath}/`) || !files.some((file) => file.path === entryPath))) {
    throw new Error("The session entry file must be inside the shared directory.");
  }
  if (files.some((file) => !file.path.startsWith(`${basePath}/`))) {
    throw new Error("Every published file must be inside the shared directory.");
  }
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new Error("The session contains duplicate publish paths.");
  }
  const requestedSpace = input.spaceId || null;
  let bearerToken = input.accessToken || input.claimToken || null;
  let exchangedAccessToken = null;
  const idempotencyKey = `push-session-${randomUUID()}`;
  const idempotencyPrincipal = randomBytes(32).toString("hex");
  const publishPayload = {
    ...(requestedSpace && { spaceId: requestedSpace }),
    publishMode: "additive",
    ...(deletePaths.length && { deletePaths }),
    ...(!requestedSpace && { space: { title: input.spaceTitle || "Shared AI sessions" } }),
    ...(!requestedSpace && input.teamId && { teamId: input.teamId }),
    ...(!requestedSpace && input.access && { access: input.access }),
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
    if (initial?.code === "space_claimed_credential_available" && input.claimToken && !input.accessToken && !exchangedAccessToken) {
      exchangedAccessToken = await exchangeClaimCredential({ apiUrl, claimToken: input.claimToken, fetchImpl });
      bearerToken = exchangedAccessToken;
      continue;
    }
    if (initial?.code !== "space_capacity_warming" || attempt === MAX_PUBLISH_ATTEMPTS) {
      const error = apiError(response, initial);
      error.stage = "initial_publish";
      throw error;
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
  if (deleting) {
    // A deletion-only version uploads nothing, so Spacefast never finalizes it
    // on its own; it would sit at "uploaded" and the files would stay live.
    const version = data?.version || (data?.id?.startsWith?.("ver_") ? data : null) || initialData?.version;
    if (version?.status === "ready") return { receipt, space, deletedPaths: deletePaths };
    if (!version?.id) throw new Error("Spacefast returned no version to finalize for the file removal.");
    const finalized = await spaceRequest(
      { apiUrl, spaceId: space.id, accessToken: bearerToken, fetchImpl },
      `versions/${encodeURIComponent(version.id)}/finalize`,
      { method: "POST", body: { channel: "live" } },
    );
    if (finalized?.data?.status !== "ready") {
      throw new Error(`Spacefast did not activate the file removal (version status: ${finalized?.data?.status || "unknown"}).`);
    }
    return { receipt: finalized, space, deletedPaths: deletePaths };
  }

  const linkOptions = {
    apiUrl,
    bearerToken,
    fetchImpl,
    spaceId: space.id,
    entryPath,
    basePath,
    title: input.session?.title,
    shareName: input.shareName,
  };
  let shareLink;
  if (requestedSpace && basePath.startsWith("sessions/")) {
    try {
      const links = await listShareLinks({ apiUrl, accessToken: bearerToken, fetchImpl, spaceId: space.id });
      shareLink = links.find((link) => reusableShareLink(link, basePath));
    } catch (error) {
      if (!(input.claimToken && !input.accessToken && !exchangedAccessToken && [401, 403].includes(error.status))) throw error;
      (input.warn || console.error)(`${MANAGE_SIGN_IN_MESSAGE} Could not check existing links; creating a new share link.`);
    }
  }
  shareLink ||= await createScopedShareLink(linkOptions);
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
    credential: exchangedAccessToken ? { accessToken: exchangedAccessToken } : null,
    space: {
      id: space.id,
      title: space.title || null,
      liveUrl,
      claimToken: claim?.key || input.claimToken || null,
      claimUrl: claim?.claimUrl || null,
      expiresAt: claim?.expiresAt || null,
    },
    versionUrl: version?.immutableUrl || null,
    accessUrl: access?.url || claim?.url || null,
  };
}

async function exchangeClaimCredential({ apiUrl, claimToken, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(`${apiUrl}/v1/claim/exchange`, {
      method: "POST",
      headers: requestHeaders({ bearerToken: claimToken }),
    });
  } catch (error) {
    error.stage = "claim_exchange";
    throw error;
  }
  let body;
  try {
    body = await responseJson(response);
  } catch (error) {
    error.stage = "claim_exchange";
    throw error;
  }
  if (!response.ok) {
    const error = apiError(response, body);
    error.stage = "claim_exchange";
    throw error;
  }
  const accessToken = body?.data?.credential?.accessToken;
  if (!accessToken) {
    const error = new Error("Spacefast exchanged the claimed space key without returning a continuation credential.");
    error.stage = "claim_exchange";
    throw error;
  }
  return accessToken;
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

async function createScopedShareLink({ apiUrl, bearerToken, fetchImpl, spaceId, entryPath, basePath, title, shareName }) {
  if (!bearerToken) throw new Error("Spacefast published the session but did not return authority to create its private share link.");
  const response = await fetchImpl(`${apiUrl}/v1/spaces/${encodeURIComponent(spaceId)}/share-links`, {
    method: "POST",
    headers: {
      ...requestHeaders({ bearerToken }),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: String(shareName || `Session: ${title || "Shared AI session"}`).slice(0, 180),
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

/** Lists the Spaces a credential can publish into, newest first. */
export async function listSpaces({ apiUrl = DEFAULT_API_URL, accessToken, query, limit = 100, fetchImpl = globalThis.fetch }) {
  const url = new URL("/v1/spaces", apiUrl);
  url.searchParams.set("limit", String(limit));
  if (query) url.searchParams.set("query", query);
  const response = await fetchImpl(url, { headers: requestHeaders({ bearerToken: accessToken }) });
  const body = await responseJson(response);
  if (!response.ok) throw apiError(response, body);
  return (Array.isArray(body?.data) ? body.data : []).filter((space) => space && !space.anonymous);
}

export async function listShareLinks(options) {
  const body = await spaceRequest(options, "share-links");
  if (!Array.isArray(body?.data)) throw new Error("Spacefast returned an unreadable share-link list.");
  return body.data;
}

export async function revokeShareLink({ linkId, ...options }) {
  return spaceRequest(options, `share-links/${encodeURIComponent(linkId)}`, { method: "DELETE" });
}

export async function listFiles({ prefix = "", ...options }) {
  const query = new URLSearchParams();
  if (prefix) query.set("q", prefix);
  const body = await spaceRequest(options, `files${query.size ? `?${query}` : ""}`);
  if (!Array.isArray(body?.data?.files)) throw new Error("Spacefast returned an unreadable file list.");
  // The API's q filter is a substring search, not a directory-prefix filter.
  return { ...body.data, files: body.data.files.filter((file) => file.path.startsWith(prefix)) };
}

export async function readSessionMetadata({ versionId, route, ...options }) {
  if (!versionId) return null;
  const query = new URLSearchParams({ path: route });
  const body = await spaceRequest(options, `versions/${encodeURIComponent(versionId)}/files/links?${query}`);
  const url = body?.data?.links?.[route]?.url;
  if (!url) throw new Error("Spacefast returned no read link for the session.");
  // Signed file URLs carry their own authority; never forward the API token.
  const response = await (options.fetchImpl || globalThis.fetch)(url);
  if (!response.ok) throw apiError(response, await responseJson(response));
  const html = await response.text();
  const data = html.match(/<script id="push-session-data" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
  if (!data) return null;
  try { return JSON.parse(data).session || null; } catch { return null; }
}

async function spaceRequest({ apiUrl = DEFAULT_API_URL, spaceId, accessToken, claimToken, fetchImpl = globalThis.fetch }, resource, { method = "GET", body: requestBody } = {}) {
  const response = await fetchImpl(`${apiUrl.replace(/\/$/, "")}/v1/spaces/${encodeURIComponent(spaceId)}/${resource}`, {
    method,
    headers: {
      ...requestHeaders({ bearerToken: accessToken || claimToken }),
      ...(requestBody && { "content-type": "application/json" }),
    },
    ...(requestBody && { body: JSON.stringify(requestBody) }),
  });
  const body = await responseJson(response);
  if (!response.ok) throw apiError(response, body);
  return body;
}

export function isSessionShareLink(link, basePath) {
  const root = `/${basePath}`;
  const includes = link.resources?.include;
  return Boolean(includes?.length
    && includes.every((value) => value === root || value.startsWith(`${root}/`)));
}

function reusableShareLink(link, basePath) {
  const root = `/${basePath}`;
  const landing = link.landingPath?.replace(/\/$/, "");
  const constraints = link.constraints || {};
  return link.url && link.active && !link.revokedAt
    && (!constraints.expiresAt || Date.parse(constraints.expiresAt) > Date.now())
    && (!constraints.notBefore || Date.parse(constraints.notBefore) <= Date.now())
    && (!constraints.maxUses || link.openCount < constraints.maxUses)
    && link.target?.kind === "live"
    && (landing === root || landing === `${root}/index.html`)
    && isSessionShareLink(link, basePath)
    && link.resources.include.includes(root) && link.resources.include.includes(`${root}/**`)
    && !link.resources.exclude?.length
    && link.capabilities?.length === 1 && link.capabilities[0] === "page.view";
}

export function sessionRoute(session) {
  return `sessions/${safeSegment(session?.id)}/index.html`;
}

function normalizeFilePath(value) {
  const normalized = String(value || "").replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
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
  return segment && segment !== "." && segment !== ".." ? segment : "session";
}

function requestHeaders({ bearerToken, idempotencyKey, idempotencyPrincipal }) {
  return {
    accept: "application/json",
    "x-spacefast-client": `push-session/${packageVersion}`,
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
  const message = body?.detail || body?.message || body?.title || `Spacefast request failed (${response.status}).`;
  const suggestions = Array.isArray(body?.suggestions) ? ` ${body.suggestions.join(" ")}` : "";
  const error = new Error(`${message}${suggestions}`.trim());
  error.code = body?.code;
  error.status = response.status;
  error.details = body?.details;
  return error;
}

function retryAfterMs(response) {
  const seconds = Number.parseInt(response.headers.get("retry-after") || "", 10);
  return (Number.isFinite(seconds) ? seconds : 20) * 1_000;
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}
