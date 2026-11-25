import { createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { DEFAULT_API_URL } from "./auth.js";
import { packageVersion } from "./version.js";

const MAX_PUBLISH_ATTEMPTS = 10;
const MAX_TRANSIENT_RETRIES = 3;
const MAX_TRANSIENT_WAIT_MS = 30_000;
const MAX_FOLLOW_STEPS = 80;
const DEFAULT_INLINE_LIMIT = 100 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 6;

export async function publishSession(input) {
  const fetchImpl = input.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("push-session requires a Node.js runtime with fetch support.");

  const apiUrl = (input.apiUrl || DEFAULT_API_URL).replace(/\/$/, "");
  const files = prepareFiles(input);
  const entryPath = input.entryPath ? normalizeFilePath(input.entryPath) : files[0]?.path;
  if (!entryPath) throw new Error("No session entry file was provided.");
  const basePath = normalizeFilePath(input.basePath || path.posix.dirname(entryPath));
  if (!entryPath.startsWith(`${basePath}/`) || !files.some((file) => file.path === entryPath)) {
    throw new Error("The session entry file must be inside the shared directory.");
  }
  if (files.some((file) => !file.path.startsWith(`${basePath}/`))) {
    throw new Error("Every published file must be inside the shared directory.");
  }
  // The Space's own index pages live outside the session folder and are never covered by its share link.
  files.push(...prepareFiles({ files: input.indexFiles || [] }));
  const visibility = input.visibility || "private";
  const rootIndex = input.rootIndex !== false;
  if (visibility === "public" && !input.accessToken) {
    throw new Error("Public sessions need you signed in. Run `sf login` or set SPACEFAST_TOKEN.");
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
    ...(!requestedSpace && { space: { title: input.spaceTitle || "Shared AI sessions" } }),
    ...(!requestedSpace && input.teamId && { teamId: input.teamId }),
    ...(!requestedSpace && input.access && { access: input.access }),
  };
  const inline = totalFileBytes(files) <= (input.inlineLimitBytes ?? DEFAULT_INLINE_LIMIT);
  let priorAccess = requestedSpace && bearerToken
    ? await restrictAccess({ api: { apiUrl, accessToken: bearerToken, fetchImpl, spaceId: requestedSpace }, basePath, visibility, publicIndex: input.publicIndex, rootIndex, tolerant: !input.accessToken })
    : NO_ACCESS;
  let initial;
  // Every attempt reuses the idempotency key, so retrying a publish cannot create a second one.
  let transientFailures = 0;

  for (let attempt = 1; attempt <= MAX_PUBLISH_ATTEMPTS; attempt += 1) {
    const request = inline
      ? inlinePublishRequest(publishPayload, files)
      : manifestPublishRequest(publishPayload, files);
    let response;
    try {
      response = await fetchImpl(`${apiUrl}/v1/publish?wait=1`, {
        method: "POST",
        headers: {
          ...requestHeaders({ bearerToken, idempotencyKey, idempotencyPrincipal }),
          ...request.headers,
        },
        body: request.body,
      });
      initial = await responseJson(response);
    } catch (error) {
      // fetch rejects with a TypeError when the network fails; a gateway's HTML error page is unreadable JSON.
      const transient = response ? isTransientStatus(error.status) : error instanceof TypeError;
      const wait = transient ? transientDelayMs(response, transientFailures) : null;
      if (wait === null || transientFailures >= MAX_TRANSIENT_RETRIES) throw error;
      transientFailures += 1;
      await delay(wait);
      continue;
    }
    if (response.ok) break;
    if (isTransientStatus(response.status) && initial?.code !== "space_capacity_warming" && transientFailures < MAX_TRANSIENT_RETRIES) {
      const wait = transientDelayMs(response, transientFailures);
      if (wait !== null) {
        transientFailures += 1;
        await delay(wait);
        continue;
      }
    }
    if (initial?.code === "space_claimed_credential_available" && input.claimToken && !input.accessToken && !exchangedAccessToken) {
      exchangedAccessToken = await exchangeClaimCredential({ apiUrl, claimToken: input.claimToken, fetchImpl });
      bearerToken = exchangedAccessToken;
      // The claim key is spent and the credential is given once: the caller keeps it whatever happens next.
      input.onCredential?.(exchangedAccessToken);
      // The Space now belongs to an account, which may have opened it up: check again before the upload
      // goes through. A Space that is public, or that the credential cannot manage, is no longer usable
      // as the signed-out session Space, which is what the stage tells the caller, so it can start a
      // new one. Any other failure is a failed publish to the same Space.
      try {
        priorAccess = requestedSpace
          ? await restrictAccess({ api: { apiUrl, accessToken: bearerToken, fetchImpl, spaceId: requestedSpace }, basePath, visibility, publicIndex: input.publicIndex, rootIndex, tolerant: false })
          : NO_ACCESS;
      } catch (error) {
        if (error.code === "space_public" || [401, 403, 404].includes(error.status)) error.stage = "claim_exchange";
        throw error;
      }
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

  const liveUrl = space.liveUrl || initialData?.space?.liveUrl || null;
  const landingUrl = liveUrl ? new URL(entryPath, ensureTrailingSlash(liveUrl)).href : null;
  const shareLink = await grantAccess({
    api: { apiUrl, accessToken: bearerToken, fetchImpl, spaceId: space.id },
    basePath,
    visibility,
    publicIndex: input.publicIndex,
    rootIndex,
    access: priorAccess,
    title: input.session?.title,
    shareName: input.shareName,
  });
  const claim = data?.claim || initialData?.claim;
  const version = data?.version || initialData?.version;
  const access = data?.access || initialData?.access;

  return {
    receipt,
    route: entryPath,
    basePath,
    // Public and private sessions have no link of their own: their address is the session folder.
    shareUrl: shareLink?.url || (liveUrl ? new URL(`${basePath}/`, ensureTrailingSlash(liveUrl)).href : null),
    landingUrl,
    visibility,
    publicSpace: priorAccess.publicSpace,
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

const NO_ACCESS = { links: [], publicGrants: [], indexGrants: [], publicSpace: false };

// The sessions page is public while any session is. Its root copy is left out for a Space whose
// home page is something else.
function indexResources(rootIndex) {
  return [...(rootIndex ? ["/", "/index.html"] : []), "/sessions", "/sessions/index.html", "/sessions/public.json"];
}

/**
 * Before anything is uploaded: reads the Space's access and takes away what the session's new
 * visibility does not allow, so new content never goes live under access that is about to end.
 * "private": the team plus anyone with the share link. "public": anyone.
 */
async function restrictAccess({ api, basePath, visibility, publicIndex, rootIndex, tolerant }) {
  const resources = sessionResources(basePath);
  let entries;
  try {
    entries = await listSpaceAccess(api);
  } catch (error) {
    // Only a signed-out publish goes on without the listing: its Space has no public grants to
    // leave behind, and a fresh link is always correct. Signed in, an unread listing could hide one.
    if (!tolerant) throw error;
    return NO_ACCESS;
  }
  const scoped = (entry, include) => entry.target?.kind === "live"
    && String(entry.capabilities) === "page.view"
    && String(entry.resources?.include) === String(include)
    && !entry.resources.exclude?.length;
  const isPublic = (entry) => entry.subject?.audience === "public";
  let publicGrants = entries.filter((entry) => isPublic(entry) && scoped(entry, resources));
  const links = entries.filter((entry) => entry.subject?.audience === "link" && entry.subject.landingPath === resources[0] && scoped(entry, resources));
  const wanted = indexResources(rootIndex);
  const allIndexGrants = entries.filter((entry) => isPublic(entry) && [true, false].some((root) => scoped(entry, indexResources(root))));
  // A wider public grant, such as a public Space, opens the session whatever is set here.
  const publicSpace = entries.some((entry) => isPublic(entry) && !publicGrants.includes(entry)
    && (entry.resources?.include || []).some((pattern) => covers(pattern, resources[0]))
    && !(entry.resources.exclude || []).some((pattern) => covers(pattern, resources[0])));
  if (publicSpace && visibility === "private") {
    const error = new Error("This Space is public, so a session in it is open to anyone. Publish with --public, or to a private Space (--pick-space or --space <id>).");
    error.code = "space_public";
    throw error;
  }
  if (visibility !== "public") {
    for (const entry of publicGrants) await revokeSpaceAccess(api, entry.id);
    publicGrants = [];
  }
  // An index grant is kept only if it is still wanted and covers exactly the pages this publish writes.
  const indexGrants = [];
  for (const entry of allIndexGrants) {
    if (publicIndex === undefined || (publicIndex && scoped(entry, wanted))) indexGrants.push(entry);
    else await revokeSpaceAccess(api, entry.id);
  }
  return { links, publicGrants, indexGrants, publicSpace };
}

/** After the upload: opens what the visibility asks for and returns the session's share link, if it has one. */
async function grantAccess({ api, basePath, visibility, publicIndex, rootIndex, access, title, shareName }) {
  if (!api.accessToken) throw new Error("Spacefast published the session but did not return authority to create its private share link.");
  const grantPublic = (name, include) => createSpaceAccess(api, { audience: "public", name, capabilities: ["page.view"], resources: { include }, target: { kind: "live" } });
  if (visibility === "public" && access.publicGrants.length === 0) await grantPublic(`Public session: ${title || basePath}`.slice(0, 120), sessionResources(basePath));
  if (publicIndex === true && access.indexGrants.length === 0) await grantPublic("Public sessions index", indexResources(rootIndex));
  if (visibility !== "private") return null;
  // Republishing keeps the link: a live link scoped to the session folder already serves the new files.
  const reusable = access.links.find((entry) => entry.subject.url && !entry.constraints?.expiresAt && !entry.constraints?.maxUses);
  if (reusable) return { id: reusable.subject.linkId, url: reusable.subject.url, reused: true };
  return createScopedShareLink({ apiUrl: api.apiUrl, bearerToken: api.accessToken, fetchImpl: api.fetchImpl, spaceId: api.spaceId, basePath, title, shareName });
}

/**
 * Changes who can open a session that is already published. As in a publish, what the new
 * visibility does not allow ends first, `write` then saves the Space's session list, and what the
 * visibility asks for opens last. Returns the session's share link when it is private.
 */
export async function changeVisibility({ apiUrl = DEFAULT_API_URL, accessToken, fetchImpl = globalThis.fetch, spaceId, basePath, visibility, publicIndex, rootIndex = true, title }, write) {
  const api = { apiUrl: apiUrl.replace(/\/$/, ""), accessToken, fetchImpl, spaceId };
  const access = await restrictAccess({ api, basePath, visibility, publicIndex, rootIndex, tolerant: false });
  await write();
  return grantAccess({ api, basePath, visibility, publicIndex, rootIndex, access, title });
}

function sessionResources(basePath) {
  return [`/${basePath}`, `/${basePath}/**`];
}

// Whether an access pattern such as "/**" or "/sessions/**" takes in a path.
function covers(pattern, target) {
  return pattern === target || (pattern.endsWith("/**") && `${target}/`.startsWith(pattern.slice(0, -2)));
}

/** Every way into a Space: people, links, public grants. */
export async function listSpaceAccess({ apiUrl = DEFAULT_API_URL, accessToken, fetchImpl = globalThis.fetch, spaceId }) {
  const response = await fetchImpl(`${apiUrl}/v1/spaces/${encodeURIComponent(spaceId)}/access`, { headers: requestHeaders({ bearerToken: accessToken }) });
  const body = await responseJson(response);
  if (!response.ok) throw apiError(response, body);
  return Array.isArray(body?.data) ? body.data : [];
}

async function createSpaceAccess({ apiUrl, accessToken, fetchImpl, spaceId }, entry) {
  const response = await fetchImpl(`${apiUrl}/v1/spaces/${encodeURIComponent(spaceId)}/access`, {
    method: "POST",
    headers: { ...requestHeaders({ bearerToken: accessToken }), "content-type": "application/json" },
    body: JSON.stringify(entry),
  });
  const body = await responseJson(response);
  if (!response.ok) throw apiError(response, body);
  return body?.data;
}

async function revokeSpaceAccess({ apiUrl, accessToken, fetchImpl, spaceId }, grantId) {
  const response = await fetchImpl(`${apiUrl}/v1/spaces/${encodeURIComponent(spaceId)}/access/${encodeURIComponent(grantId)}`, {
    method: "DELETE",
    headers: requestHeaders({ bearerToken: accessToken }),
  });
  if (!response.ok && response.status !== 404) throw apiError(response, await responseJson(response));
}

/**
 * Reads text files from a Space's live version. `select` picks from the paths the Space holds;
 * the result carries every path and the contents of the selected ones.
 */
export async function readSpaceFiles({ apiUrl = DEFAULT_API_URL, accessToken, fetchImpl = globalThis.fetch, spaceId, select }) {
  const headers = requestHeaders({ bearerToken: accessToken });
  const space = `${apiUrl}/v1/spaces/${encodeURIComponent(spaceId)}`;
  const listing = await fetchImpl(`${space}/files`, { headers });
  const listed = await responseJson(listing);
  if (!listing.ok) throw apiError(listing, listed);
  const paths = (listed?.data?.files || []).map((file) => file.path);
  const wanted = select(paths).slice(0, 200);
  const contents = new Map();
  if (wanted.length === 0) return { paths, contents };

  // File bytes never travel through the API: it mints one short-lived read URL per path.
  const query = wanted.map((file) => `path=${encodeURIComponent(file)}`).join("&");
  const minted = await fetchImpl(`${space}/versions/${encodeURIComponent(listed.data.versionId)}/files/links?${query}`, { headers });
  const links = await responseJson(minted);
  if (!minted.ok) throw apiError(minted, links);
  await Promise.all(wanted.map(async (file) => {
    const url = links?.data?.links?.[file]?.url;
    if (!url) throw new Error(`Spacefast returned no read link for ${file}.`);
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`Could not read ${file} from the Space (${response.status}).`);
    contents.set(file, await response.text());
  }));
  return { paths, contents };
}

async function createScopedShareLink({ apiUrl, bearerToken, fetchImpl, spaceId, basePath, title, shareName }) {
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

/** A Space's own details: its title and the address it is served at. */
export async function readSpace({ apiUrl = DEFAULT_API_URL, accessToken, fetchImpl = globalThis.fetch, spaceId }) {
  const response = await fetchImpl(`${apiUrl.replace(/\/$/, "")}/v1/spaces/${encodeURIComponent(spaceId)}`, { headers: requestHeaders({ bearerToken: accessToken }) });
  const body = await responseJson(response);
  if (!response.ok) throw apiError(response, body);
  return body?.data || {};
}

/** Whether anyone at all can open a session: through its own public grant or a wider one, such as a public Space. */
export function openToEveryone(entries, basePath) {
  const root = `/${basePath}`;
  return entries.some((entry) => entry.subject?.audience === "public"
    && (entry.resources?.include || []).some((pattern) => covers(pattern, root))
    && !(entry.resources?.exclude || []).some((pattern) => covers(pattern, root)));
}

/** A session's own ways in: the share links and public grants that cover nothing outside its folder. */
export function sessionAccess(entries, basePath) {
  const root = `/${basePath}`;
  const within = (entry) => entry.resources?.include?.length > 0
    && entry.resources.include.every((value) => value === root || value.startsWith(`${root}/`));
  return {
    links: entries.filter((entry) => entry.subject?.audience === "link" && entry.subject.linkId && within(entry))
      .map((entry) => ({ id: entry.subject.linkId, url: entry.subject.url || null })),
    publicGrants: entries.filter((entry) => entry.subject?.audience === "public" && within(entry)),
  };
}

/** Ends a session's share links and public access. `done` collects what was ended, as it is ended. */
export async function revokeSessionAccess({ apiUrl = DEFAULT_API_URL, accessToken, fetchImpl = globalThis.fetch, spaceId }, { links, publicGrants }, done = { linkIds: [], publicGrants: 0 }) {
  const api = { apiUrl: apiUrl.replace(/\/$/, ""), accessToken, fetchImpl, spaceId };
  for (const link of links) {
    const response = await fetchImpl(`${api.apiUrl}/v1/spaces/${encodeURIComponent(spaceId)}/share-links/${encodeURIComponent(link.id)}`, {
      method: "DELETE",
      headers: requestHeaders({ bearerToken: accessToken }),
    });
    if (!response.ok && response.status !== 404) throw apiError(response, await responseJson(response));
    done.linkIds.push(link.id);
  }
  for (const grant of publicGrants) {
    await revokeSpaceAccess(api, grant.id);
    done.publicGrants += 1;
  }
  return done;
}

/** Closes the sessions page to the public again, once no public session is left for it to list. */
export async function revokeIndexAccess({ apiUrl = DEFAULT_API_URL, accessToken, fetchImpl = globalThis.fetch, spaceId }, entries) {
  const api = { apiUrl: apiUrl.replace(/\/$/, ""), accessToken, fetchImpl, spaceId };
  const isIndex = (entry) => entry.subject?.audience === "public"
    && [true, false].some((root) => String(entry.resources?.include) === String(indexResources(root)));
  for (const entry of entries.filter(isIndex)) await revokeSpaceAccess(api, entry.id);
}

/**
 * Writes files to a Space's live version and removes others, in one publish. There is always
 * something to write here (the session list), so the publish settles like any other.
 */
export async function updateSpaceFiles({ apiUrl = DEFAULT_API_URL, accessToken, fetchImpl = globalThis.fetch, spaceId, deletePaths = [], files }) {
  const origin = apiUrl.replace(/\/$/, "");
  const prepared = prepareFiles({ files });
  if (prepared.length === 0) throw new Error("No files were given to write to the Space.");
  const removed = deletePaths.map(normalizeFilePath);
  const request = inlinePublishRequest({ spaceId, publishMode: "additive", ...(removed.length > 0 && { deletePaths: removed }) }, prepared);
  const response = await fetchImpl(`${origin}/v1/publish?wait=1`, {
    method: "POST",
    headers: {
      ...requestHeaders({ bearerToken: accessToken, idempotencyKey: `push-session-${randomUUID()}`, idempotencyPrincipal: randomBytes(32).toString("hex") }),
      ...request.headers,
    },
    body: request.body,
  });
  const initial = await responseJson(response);
  if (!response.ok) throw apiError(response, initial);
  await settlePublish({ initial, files: prepared, apiUrl: origin, bearerToken: accessToken, fetchImpl });
  return { deletedPaths: removed };
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
    const error = new Error(`Spacefast returned an unreadable response (${response.status}).`);
    error.status = response.status;
    throw error;
  }
}

function isTransientStatus(status) {
  return status === 429 || status >= 500;
}

// Backs off 1s, 2s, 4s unless the server names a wait. Null means the wait is too long to sit through.
function transientDelayMs(response, failures) {
  const seconds = Number.parseInt(response?.headers?.get("retry-after") || "", 10);
  const wait = Number.isFinite(seconds) ? seconds * 1_000 : 1_000 * 2 ** failures;
  return wait <= MAX_TRANSIENT_WAIT_MS ? wait : null;
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
