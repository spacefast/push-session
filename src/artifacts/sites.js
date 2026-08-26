import { createHash } from "node:crypto";
import { execFileSync as execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { readJsonLines } from "../agents/common.js";

const SITE_TOOL_PREFIX = "mcp__codex_apps__sites_";
const SITE_NAMESPACE = "mcp__codex_apps__sites";
const SITE_OUTPUT_TOOLS = new Set([
  "create_site",
  "save_site_version",
  "deploy_site_version",
  "deploy_private_site_version",
  "get_deployment_status",
]);
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;

export function discoverCodexSessionSites(session, options = {}) {
  const calls = new Map();
  const sites = new Map();

  for (const entry of readJsonLines(session.filePath)) {
    if (entry.type !== "response_item" || !entry.payload) continue;
    const payload = entry.payload;
    if (["function_call", "custom_tool_call"].includes(payload.type)) {
      for (const call of siteCalls(payload, entry.timestamp)) {
        calls.set(call.callId, call);
        applySiteCall(sites, call, null);
      }
      continue;
    }
    if (!["function_call_output", "custom_tool_call_output"].includes(payload.type)) continue;
    const call = calls.get(payload.call_id);
    if (call) applySiteCall(sites, call, unpackOutput(payload.output));
  }

  const recovered = [...sites.values()].map((site) => finalizeSite(site, session, options));
  return recovered.sort((left, right) => String(left.title).localeCompare(String(right.title)));
}

export function parseCodexSitesTranscript(filePath) {
  return discoverCodexSessionSites({ filePath, project: null }, { recoverSource: false });
}

function siteCalls(payload, timestamp) {
  const direct = normalizeToolName(payload.namespace, payload.name);
  if (direct) {
    return [{
      callId: payload.call_id || `${direct}:${timestamp || "unknown"}`,
      tool: direct,
      args: parseArguments(payload.arguments ?? payload.input),
      timestamp,
    }];
  }
  if (payload.type !== "custom_tool_call" || payload.name !== "exec" || typeof payload.input !== "string") return [];
  return nestedSiteCalls(payload.input, payload.call_id, timestamp);
}

function normalizeToolName(namespace, name) {
  const value = String(name || "");
  if (namespace === SITE_NAMESPACE) return value.replace(/^_/, "");
  if (value.startsWith(SITE_TOOL_PREFIX)) return value.slice(SITE_TOOL_PREFIX.length).replace(/^_/, "");
  return null;
}

function nestedSiteCalls(input, outerCallId, timestamp) {
  const calls = [];
  const matcher = /tools\.(mcp__codex_apps__sites_[a-zA-Z0-9_]+)\s*\(/g;
  for (const match of input.matchAll(matcher)) {
    const tool = normalizeToolName(null, match[1]);
    const argumentStart = (match.index || 0) + match[0].length;
    const raw = balancedArgument(input, argumentStart);
    calls.push({
      callId: calls.length === 0 ? outerCallId : `${outerCallId}:${calls.length + 1}`,
      tool,
      args: parseArguments(raw),
      timestamp,
    });
  }
  return calls;
}

function balancedArgument(input, start) {
  let depth = 1;
  let quote = null;
  let escaped = false;
  for (let index = start; index < input.length; index += 1) {
    const character = input[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (["\"", "'", "`"].includes(character)) quote = character;
    else if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return input.slice(start, index).trim();
    }
  }
  return input.slice(start).trim();
}

function parseArguments(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return {};
  const parsed = parseJson(value);
  if (parsed && typeof parsed === "object") return parsed;
  const fields = {};
  const matcher = /["']?(project_id|version_id|deployment_id|archive|commit_sha|slug|title)["']?\s*:\s*(["'])(.*?)\2/gs;
  for (const match of value.matchAll(matcher)) fields[match[1]] = decodeQuoted(match[3], match[2]);
  return fields;
}

function decodeQuoted(value, quote) {
  if (quote === "\"") {
    try { return JSON.parse(`"${value}"`); } catch { /* use the source text */ }
  }
  return value.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
}

function applySiteCall(sites, call, output) {
  if (!SITE_OUTPUT_TOOLS.has(call.tool)) return;
  const projectId = stringField(call.args, "project_id") || deepField(output, "project_id") || deepField(output, "id");
  if (!projectId || !isSiteProjectId(projectId)) return;
  const site = getSite(sites, projectId);
  site.callIds.add(call.callId);
  site.title ||= stringField(call.args, "title") || deepField(output, "title");
  site.slug ||= stringField(call.args, "slug") || deepField(output, "slug");
  site.updatedAt = call.timestamp || site.updatedAt;

  const versionId = stringField(call.args, "version_id") || deepField(output, "version_id");
  let version = call.tool === "save_site_version"
    ? site.versions.find((candidate) => candidate.callIds.includes(call.callId))
    : null;
  if (call.tool === "save_site_version" && !version) {
    version = {
      id: null,
      number: null,
      commitSha: null,
      archivePath: null,
      savedAt: call.timestamp || null,
      callIds: [call.callId],
      deploymentIds: [],
      liveUrl: null,
      status: null,
    };
    site.versions.push(version);
  }
  version ||= versionId
    ? site.versions.find((candidate) => candidate.id === versionId)
    : site.versions.at(-1);
  if (!version && versionId) {
    version = {
      id: versionId,
      number: null,
      commitSha: null,
      archivePath: null,
      savedAt: null,
      callIds: [],
      deploymentIds: [],
      liveUrl: null,
      status: null,
    };
    site.versions.push(version);
  }
  if (version && call.tool !== "save_site_version" && !version.callIds.includes(call.callId)) version.callIds.push(call.callId);
  if (version) {
    version.id ||= versionId || null;
    version.number ||= numberField(output, "version_number");
    version.commitSha ||= stringField(call.args, "commit_sha") || deepField(call.args, "commit_sha") || deepField(output, "commit_sha");
    version.archivePath ||= stringField(call.args, "archive") || null;
    version.status = deepField(output, "status") || version.status;
    const deploymentId = stringField(call.args, "deployment_id") || deepField(output, "deployment_id");
    if (deploymentId && !version.deploymentIds.includes(deploymentId)) version.deploymentIds.push(deploymentId);
    const url = siteUrl(output);
    if (url) {
      version.liveUrl = url;
      site.liveUrl = url;
    }
  }
}

function getSite(sites, projectId) {
  if (!sites.has(projectId)) {
    sites.set(projectId, {
      projectId,
      title: null,
      slug: null,
      liveUrl: null,
      updatedAt: null,
      callIds: new Set(),
      versions: [],
    });
  }
  return sites.get(projectId);
}

function finalizeSite(site, session, options) {
  const versions = coalesceVersions(site.versions).map((version, index) => ({
    ...version,
    number: version.number || index + 1,
    source: options.recoverSource === false ? null : recoverVersionSource(site, version, session, options),
  }));
  const recoverableVersions = versions.filter((version) => version.source).length;
  return {
    id: site.projectId,
    projectId: site.projectId,
    title: site.title || site.slug || "ChatGPT Site",
    slug: site.slug,
    url: site.liveUrl || versions.findLast((version) => version.liveUrl)?.liveUrl || null,
    updatedAt: site.updatedAt,
    callIds: [...site.callIds],
    versions,
    recoverableVersions,
    latest: versions.at(-1) || null,
  };
}

function coalesceVersions(versions) {
  const grouped = new Map();
  for (const version of versions) {
    const key = version.id || version.commitSha || `save:${grouped.size + 1}`;
    const previous = grouped.get(key);
    if (!previous) grouped.set(key, { ...version, callIds: [...version.callIds], deploymentIds: [...version.deploymentIds] });
    else {
      previous.number ||= version.number;
      previous.commitSha ||= version.commitSha;
      previous.archivePath ||= version.archivePath;
      previous.liveUrl ||= version.liveUrl;
      previous.status ||= version.status;
      previous.callIds.push(...version.callIds.filter((id) => !previous.callIds.includes(id)));
      previous.deploymentIds.push(...version.deploymentIds.filter((id) => !previous.deploymentIds.includes(id)));
    }
  }
  return [...grouped.values()];
}

function recoverVersionSource(site, version, session, options) {
  const archive = recoverArchive(version.archivePath, options);
  const commit = version.commitSha ? recoverGitCommit(site, version.commitSha, session, options) : null;
  if (!archive && !commit) return null;
  return {
    recoveredFrom: [commit && "git-commit", archive && "deployment-archive"].filter(Boolean).join("+"),
    commitSha: version.commitSha || null,
    files: commit?.files || [],
    omittedFiles: commit?.omittedFiles || [],
    totalBytes: (commit?.totalBytes || 0) + (archive?.bytes || 0),
    archive,
  };
}

function recoverArchive(archivePath, options) {
  if (!archivePath || !fs.existsSync(archivePath)) return null;
  const stats = fs.statSync(archivePath);
  const maxBytes = options.maxArchiveBytes || MAX_ARCHIVE_BYTES;
  if (!stats.isFile() || stats.size > maxBytes) return null;
  const content = fs.readFileSync(archivePath);
  if (content[0] !== 0x1f || content[1] !== 0x8b) return null;
  let entries;
  try {
    entries = tarEntryNames(gunzipSync(content, { maxOutputLength: Math.max(maxBytes * 4, 256 * 1024 * 1024) }));
  } catch {
    return null;
  }
  if (!entries.has("dist/server/index.js") || !entries.has("dist/.openai/hosting.json")) return null;
  return {
    name: "deployment.tar.gz",
    bytes: stats.size,
    content,
  };
}

function tarEntryNames(buffer) {
  const names = new Set();
  for (let offset = 0; offset + 512 <= buffer.length;) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = nullTerminated(header.subarray(0, 100));
    const prefix = nullTerminated(header.subarray(345, 500));
    const size = Number.parseInt(nullTerminated(header.subarray(124, 136)).trim() || "0", 8);
    if (!Number.isFinite(size) || size < 0) throw new Error("Invalid tar entry size");
    names.add(prefix ? `${prefix}/${name}` : name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

function nullTerminated(buffer) {
  const end = buffer.indexOf(0);
  return buffer.subarray(0, end < 0 ? buffer.length : end).toString("utf8");
}

function recoverGitCommit(site, commitSha, session, options) {
  const runGit = options.execFileSync || execFile;
  const project = options.project || session.project;
  if (!project || !fs.existsSync(project)) return null;
  let repoRoot;
  try {
    repoRoot = runGit("git", ["-C", project, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    runGit("git", ["-C", repoRoot, "cat-file", "-e", `${commitSha}^{commit}`]);
  } catch {
    return null;
  }

  const names = gitText(runGit, repoRoot, ["ls-tree", "-r", "--name-only", "-z", commitSha]).split("\0").filter(Boolean);
  const hostingPath = names.find((name) => name.endsWith(".openai/hosting.json") && hostingMatches(runGit, repoRoot, commitSha, name, site.projectId));
  if (!hostingPath) return null;
  const siteRoot = path.posix.dirname(path.posix.dirname(hostingPath));
  const treeArgs = ["ls-tree", "-r", "-l", "-z", commitSha];
  if (siteRoot !== ".") treeArgs.push("--", siteRoot);
  const entries = parseTree(gitText(runGit, repoRoot, treeArgs));
  const files = [];
  const omittedFiles = [];
  let totalBytes = 0;
  const maxFileBytes = options.maxFileBytes || MAX_FILE_BYTES;
  const maxSourceBytes = options.maxSourceBytes || MAX_SOURCE_BYTES;

  for (const entry of entries) {
    const relativePath = siteRoot === "." ? entry.path : entry.path.slice(siteRoot.length + 1);
    if (!safeSourcePath(relativePath) || isSensitivePath(relativePath)) {
      omittedFiles.push(relativePath);
      continue;
    }
    if (entry.size > maxFileBytes || totalBytes + entry.size > maxSourceBytes) {
      omittedFiles.push(relativePath);
      continue;
    }
    let content;
    try {
      content = runGit("git", ["-C", repoRoot, "show", `${commitSha}:${entry.path}`], { encoding: "buffer", maxBuffer: maxFileBytes + 1024 });
    } catch {
      omittedFiles.push(relativePath);
      continue;
    }
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
    totalBytes += buffer.byteLength;
    files.push({
      path: relativePath,
      content: buffer,
      bytes: buffer.byteLength,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      contentType: contentType(relativePath, buffer),
    });
  }
  return { files, omittedFiles, totalBytes };
}

function hostingMatches(runGit, repoRoot, commitSha, filePath, projectId) {
  try {
    const content = gitText(runGit, repoRoot, ["show", `${commitSha}:${filePath}`]);
    return JSON.parse(content).project_id === projectId;
  } catch {
    return false;
  }
}

function parseTree(value) {
  return value.split("\0").filter(Boolean).flatMap((line) => {
    const match = line.match(/^\d+\s+blob\s+[a-f0-9]+\s+(\d+|-?)\t([\s\S]+)$/);
    return match ? [{ size: Number(match[1]) || 0, path: match[2] }] : [];
  });
}

function gitText(runGit, repoRoot, args) {
  const value = runGit("git", ["-C", repoRoot, ...args], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  return Buffer.isBuffer(value) ? value.toString("utf8") : value;
}

function safeSourcePath(value) {
  const normalized = String(value || "").replaceAll("\\", "/");
  return Boolean(normalized) && !normalized.startsWith("/") && !normalized.split("/").includes("..");
}

function isSensitivePath(value) {
  const lower = String(value).toLowerCase();
  const basename = path.posix.basename(lower);
  if (basename === ".env.example" || basename === ".env.sample") return false;
  return basename === ".env" || basename.startsWith(".env.") ||
    ["credentials", "credentials.json", "id_rsa", "id_ed25519", ".npmrc", ".pypirc"].includes(basename) ||
    /(^|[._-])(secret|secrets|credential|credentials)([._-]|$)/.test(basename) ||
    /\.(pem|key|p12|pfx|keystore)$/.test(basename);
}

function contentType(filePath, buffer) {
  const extension = path.extname(filePath).toLowerCase();
  const known = {
    ".css": "text/css; charset=utf-8", ".gif": "image/gif", ".html": "text/plain; charset=utf-8",
    ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".png": "image/png", ".svg": "text/plain; charset=utf-8", ".tsx": "text/plain; charset=utf-8",
    ".ts": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".webp": "image/webp",
  };
  if (known[extension]) return known[extension];
  return buffer.subarray(0, 8_192).includes(0) ? "application/octet-stream" : "text/plain; charset=utf-8";
}

function unpackOutput(value) {
  if (value && typeof value === "object") return value;
  return parseJson(value) || value;
}

function parseJson(value) {
  if (typeof value !== "string") return null;
  try { return JSON.parse(value); } catch { /* try a JSON payload embedded in tool text */ }
  const start = Math.min(...[value.indexOf("{"), value.indexOf("[")].filter((index) => index >= 0));
  if (!Number.isFinite(start)) return null;
  for (let end = value.length; end > start; end -= 1) {
    const tail = value[end - 1];
    if (tail !== "}" && tail !== "]") continue;
    try { return JSON.parse(value.slice(start, end)); } catch { /* keep looking */ }
  }
  return null;
}

function deepField(value, field, seen = new Set()) {
  if (value === null || value === undefined || seen.has(value)) return null;
  if (typeof value === "string") {
    const parsed = parseJson(value);
    return parsed ? deepField(parsed, field, seen) : null;
  }
  if (typeof value !== "object") return null;
  seen.add(value);
  if (value[field] !== undefined && value[field] !== null) return value[field];
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = deepField(child, field, seen);
    if (found !== null && found !== undefined) return found;
  }
  return null;
}

function stringField(value, field) {
  const found = value?.[field];
  return typeof found === "string" && found ? found : null;
}

function numberField(value, field) {
  const found = deepField(value, field);
  const number = Number(found);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function siteUrl(value) {
  const url = deepField(value, "url");
  return typeof url === "string" && /^https:\/\//.test(url) ? url : null;
}

function isSiteProjectId(value) {
  return typeof value === "string" && (/^appgprj_[a-zA-Z0-9]+$/.test(value) || /^site[_-]/.test(value));
}
