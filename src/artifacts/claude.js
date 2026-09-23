import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { execFileSync } from "node:child_process";

import { exists, safeJson, walkFiles } from "../agents/common.js";

const ARTIFACT_URL = /https:\/\/claude\.ai\/code\/artifact\/([a-zA-Z0-9-]+)/;
const SOURCE_EXTENSIONS = new Set([".html", ".htm", ".md"]);

export async function discoverClaudeArtifacts(options = {}) {
  const home = options.home || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const projectsDir = path.join(home, "projects");
  if (!options.transcriptFiles && !exists(projectsDir)) return [];

  const transcriptFiles = options.transcriptFiles || walkFiles(projectsDir, (_filePath, name) => name.endsWith(".jsonl"));
  const versions = [];
  for (const filePath of [...new Set(transcriptFiles)].sort()) {
    versions.push(...await parseClaudeArtifactTranscript(filePath, { ...options, home }));
  }
  return groupArtifactVersions(versions, options.query);
}

export async function discoverClaudeSessionArtifacts(session, options = {}) {
  if (session?.agent !== "claude" || !session.filePath) return [];
  const transcriptFiles = [session.filePath];
  const subagentsDir = path.join(path.dirname(session.filePath), session.id, "subagents");
  if (exists(subagentsDir)) {
    transcriptFiles.push(...walkFiles(subagentsDir, (_filePath, name) => name.endsWith(".jsonl")));
  }
  const artifacts = await discoverClaudeArtifacts({ ...options, transcriptFiles });
  return artifacts.filter((artifact) => artifact.sessionIds.includes(session.id));
}

export async function parseClaudeArtifactTranscript(filePath, options = {}) {
  const home = options.home || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const gitBlobReader = options.gitBlobReader || readGitBlob;
  const sourceStates = new Map();
  const pendingMutations = new Map();
  const pendingPublishes = new Map();
  const pendingSourceCopies = new Map();
  const durableCopies = [];
  const versions = [];
  const events = [];
  const relevantToolIds = new Set();
  let project = null;
  let sessionId = null;
  let sequence = 0;

  const input = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    const entry = safeJson(line);
    if (!entry) continue;
    project ||= typeof entry.cwd === "string" ? entry.cwd : null;
    sessionId ||= entry.sessionId || entry.session_id || null;

    if (entry.type === "file-history-delta") {
      events.push({ kind: "file-history", entry, sequence: sequence += 1 });
      continue;
    }

    if (entry.type === "frame-link" && isArtifactUrl(entry.frameUrl)) {
      sessionId ||= entry.sessionId || null;
      events.push({ kind: "frame-link", entry, sequence: sequence += 1 });
      continue;
    }

    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === "tool_use") {
        const toolName = String(part.name || "").toLowerCase();
        if (toolName === "write" || toolName === "edit") {
          relevantToolIds.add(part.id);
          events.push({ kind: "mutation", entry, part, sequence: sequence += 1 });
        } else if (toolName === "artifact") {
          relevantToolIds.add(part.id);
          events.push({ kind: "artifact", entry, part, sequence: sequence += 1 });
        } else if (toolName === "bash") {
          const sourceCopy = sourceCopyFromTool(part, entry, project);
          if (sourceCopy) {
            relevantToolIds.add(part.id);
            events.push({ kind: "source-copy", entry, part, sourceCopy, sequence: sequence += 1 });
          }
        }
        continue;
      }
      if (part?.type === "tool_result" && relevantToolIds.has(part.tool_use_id)) {
        events.push({ kind: "tool-result", entry, part, sequence: sequence += 1 });
      }
    }
  }

  events.sort(compareTranscriptEvents);
  for (const event of events) {
    const { entry, part } = event;
    if (event.kind === "file-history") {
      seedFromFileHistory({ entry, home, project, sessionId, sourceStates });
      continue;
    }
    if (event.kind === "frame-link") {
      attachFrameLink(versions, entry, { filePath, project, sessionId, sourceStates, pendingPublishes });
      continue;
    }
    if (event.kind === "mutation") {
      pendingMutations.set(part.id, mutationFromTool(part, entry.timestamp, entry.cwd || project));
      continue;
    }
    if (event.kind === "artifact") {
      const publication = publicationFromTool(part, entry, {
        filePath,
        project,
        sessionId,
        sourceStates,
      });
      pendingPublishes.set(part.id, publication);
      continue;
    }
    if (event.kind === "source-copy") {
      pendingSourceCopies.set(part.id, event.sourceCopy);
      continue;
    }
    if (event.kind === "tool-result") {
      const mutation = pendingMutations.get(part.tool_use_id);
      if (mutation) {
        pendingMutations.delete(part.tool_use_id);
        if (!part.is_error) applyMutation(sourceStates, mutation);
      }
      const sourceCopy = pendingSourceCopies.get(part.tool_use_id);
      if (sourceCopy) {
        pendingSourceCopies.delete(part.tool_use_id);
        const durable = recoverGitSnapshot(sourceCopy, textContent(part.content), gitBlobReader);
        if (durable) durableCopies.push(durable);
      }
      const publication = pendingPublishes.get(part.tool_use_id);
      if (!publication) continue;
      pendingPublishes.delete(part.tool_use_id);
      if (part.is_error) continue;
      const output = textContent(part.content);
      const match = ARTIFACT_URL.exec(output);
      if (match) {
        publication.url = match[0];
        publication.artifactId = match[1];
      }
      publication.result = output;
      versions.push(publication);
    }
  }

  for (const publication of pendingPublishes.values()) {
    if (publication.url) versions.push(publication);
  }
  const latestByPath = new Map(versions.filter((version) => version.sourcePath).map((version) => [version.sourcePath, version]));
  for (const version of versions) {
    if (version.source) continue;
    const durable = nearestDurableCopy(version, durableCopies, versions);
    if (durable) version.source = durable.source;
    else if (latestByPath.get(version.sourcePath) === version) version.source = recoverLiveSource(version.sourcePath);
  }
  return dedupeVersions(versions);
}

function compareTranscriptEvents(left, right) {
  const leftTime = Date.parse(left.entry.timestamp || "");
  const rightTime = Date.parse(right.entry.timestamp || "");
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
  if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) return Number.isFinite(leftTime) ? -1 : 1;
  const priority = { mutation: 0, artifact: 0, "source-copy": 0, "file-history": 1, "frame-link": 2, "tool-result": 3 };
  return (priority[left.kind] - priority[right.kind]) || left.sequence - right.sequence;
}

function sourceCopyFromTool(part, entry, project) {
  const command = part.input?.command;
  if (typeof command !== "string" || !/\bgit\b/.test(command) || !/\bcp\s/.test(command)) return null;
  const copyPattern = /\bcp\s+(?:"([^"]+\.(?:html?|md))"|'([^']+\.(?:html?|md))'|([^\s;&|]+\.(?:html?|md)))\s+(?:"?\$WT\/)?"?(internal-docs\/[^\s"';&|]+)/ig;
  const copies = [];
  for (const match of command.matchAll(copyPattern)) {
    const sourcePath = match[1] || match[2] || match[3];
    let gitPath = match[4];
    if (!sourcePath || sourcePath.includes("$") || !gitPath) continue;
    if (gitPath.endsWith("/")) gitPath = `${gitPath}${path.basename(sourcePath)}`;
    copies.push({ sourcePath: normalizeSourcePath(sourcePath, entry.cwd || project), gitPath });
  }
  const copy = copies.find((candidate) => candidate.sourcePath?.includes("/tmp/claude-")) || copies[0];
  if (!copy || !project) return null;
  return {
    ...copy,
    project,
    timestamp: entry.timestamp || null,
  };
}

function recoverGitSnapshot(copy, output, gitBlobReader) {
  const commit = String(output || "").match(/(?:^|\n)([0-9a-f]{7,40})\b/)?.[1];
  if (!commit) return null;
  try {
    const content = gitBlobReader(copy.project, commit, copy.gitPath);
    return {
      sourcePath: copy.sourcePath,
      timestamp: copy.timestamp,
      source: snapshotSource(sourceState(content, "git-snapshot", copy.timestamp), copy.sourcePath),
    };
  } catch {
    return null;
  }
}

function readGitBlob(project, commit, gitPath) {
  return execFileSync("git", ["-C", project, "cat-file", "blob", `${commit}:${gitPath}`], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function nearestDurableCopy(version, copies, versions) {
  const publishedAt = Date.parse(version.publishedAt || "");
  return copies
    .filter((copy) => copy.sourcePath === version.sourcePath)
    .map((copy) => ({ copy, delta: Date.parse(copy.timestamp || "") - publishedAt }))
    .filter(({ delta }) => Number.isFinite(delta) && delta >= 0 && delta < 5 * 60_000)
    .filter(({ delta }) => !versions.some((other) => {
      if (other === version || other.sourcePath !== version.sourcePath) return false;
      const otherDelta = Date.parse(other.publishedAt || "") - publishedAt;
      return Number.isFinite(otherDelta) && otherDelta > 0 && otherDelta <= delta;
    }))
    .sort((left, right) => left.delta - right.delta)[0]?.copy || null;
}

function publicationFromTool(part, entry, context) {
  const sourcePath = normalizeSourcePath(part.input?.file_path || part.input?.path, entry.cwd || context.project);
  const state = sourcePath ? context.sourceStates.get(sourcePath) : null;
  const inputUrl = typeof part.input?.url === "string" ? part.input.url : null;
  const match = inputUrl ? ARTIFACT_URL.exec(inputUrl) : null;
  return {
    artifactId: match?.[1] || null,
    url: match?.[0] || null,
    toolUseId: part.id || null,
    sessionId: context.sessionId || entry.sessionId || entry.session_id || sessionFromTranscriptPath(context.filePath),
    transcriptPath: context.filePath,
    project: context.project,
    sourcePath,
    title: cleanValue(part.input?.title),
    description: cleanValue(part.input?.description),
    favicon: cleanValue(part.input?.favicon),
    label: cleanValue(part.input?.label),
    publishedAt: entry.timestamp || null,
    source: snapshotSource(state, sourcePath),
  };
}

function attachFrameLink(versions, entry, context) {
  const sourcePath = normalizeSourcePath(entry.path, entry.cwd || context.project);
  const timestamp = Date.parse(entry.timestamp || "");
  let version = [...context.pendingPublishes.values()].reverse().find((candidate) => {
    if (candidate.sourcePath !== sourcePath || candidate.frameLinked) return false;
    const candidateTimestamp = Date.parse(candidate.publishedAt || "");
    return !Number.isFinite(timestamp) || !Number.isFinite(candidateTimestamp) || Math.abs(timestamp - candidateTimestamp) < 60_000;
  });
  version ||= [...versions].reverse().find((candidate) => {
    if (candidate.sourcePath !== sourcePath || candidate.frameLinked) return false;
    const candidateTimestamp = Date.parse(candidate.publishedAt || "");
    return !Number.isFinite(timestamp) || !Number.isFinite(candidateTimestamp) || Math.abs(timestamp - candidateTimestamp) < 60_000;
  });
  if (!version) {
    const state = sourcePath ? context.sourceStates.get(sourcePath) : null;
    version = {
      artifactId: null,
      url: null,
      toolUseId: null,
      sessionId: entry.sessionId || context.sessionId || sessionFromTranscriptPath(context.filePath),
      transcriptPath: context.filePath,
      project: context.project,
      sourcePath,
      title: null,
      description: null,
      favicon: null,
      label: null,
      publishedAt: entry.timestamp || null,
      source: snapshotSource(state, sourcePath),
    };
    versions.push(version);
  }
  const match = ARTIFACT_URL.exec(entry.frameUrl);
  version.url = match?.[0] || entry.frameUrl;
  version.artifactId = match?.[1] || version.artifactId;
  version.title = cleanValue(entry.title) || version.title;
  version.publishedAt ||= entry.timestamp || null;
  version.frameLinked = true;
}

function mutationFromTool(part, timestamp, project) {
  return {
    id: part.id,
    kind: String(part.name || "").toLowerCase(),
    path: normalizeSourcePath(part.input?.file_path || part.input?.path, project),
    content: part.input?.content,
    oldString: part.input?.old_string,
    newString: part.input?.new_string,
    replaceAll: part.input?.replace_all === true,
    timestamp,
  };
}

function applyMutation(states, mutation) {
  if (!mutation.path || !SOURCE_EXTENSIONS.has(path.extname(mutation.path).toLowerCase())) return;
  if (mutation.kind === "write" && typeof mutation.content === "string") {
    states.set(mutation.path, sourceState(mutation.content, "transcript-write", mutation.timestamp));
    return;
  }
  if (mutation.kind !== "edit") return;
  const current = states.get(mutation.path);
  if (!current || typeof mutation.oldString !== "string" || typeof mutation.newString !== "string" || mutation.oldString === "") {
    states.delete(mutation.path);
    return;
  }
  const first = current.content.indexOf(mutation.oldString);
  if (first < 0) {
    states.delete(mutation.path);
    return;
  }
  const content = mutation.replaceAll
    ? current.content.split(mutation.oldString).join(mutation.newString)
    : `${current.content.slice(0, first)}${mutation.newString}${current.content.slice(first + mutation.oldString.length)}`;
  states.set(mutation.path, sourceState(content, `${current.recoveredFrom}+transcript-edit`, mutation.timestamp));
}

function seedFromFileHistory({ entry, home, project, sessionId, sourceStates }) {
  const sourcePath = normalizeSourcePath(entry.trackingPath, entry.cwd || project);
  const backupName = entry.backup?.backupFileName;
  if (!sourcePath || !backupName || sourceStates.has(sourcePath) || !sessionId) return;
  const backupPath = path.join(home, "file-history", sessionId, backupName);
  try {
    const content = fs.readFileSync(backupPath, "utf8");
    sourceStates.set(sourcePath, sourceState(content, "file-history", entry.timestamp));
  } catch {}
}

function recoverLiveSource(sourcePath) {
  if (!sourcePath || !SOURCE_EXTENSIONS.has(path.extname(sourcePath).toLowerCase())) return null;
  try {
    return sourceState(fs.readFileSync(sourcePath, "utf8"), "live-file", fs.statSync(sourcePath).mtime.toISOString());
  } catch {
    return null;
  }
}

function sourceState(content, recoveredFrom, recoveredAt) {
  return {
    content,
    recoveredFrom,
    recoveredAt: recoveredAt || null,
    bytes: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function snapshotSource(state, sourcePath) {
  if (!state) return null;
  return {
    ...state,
    extension: path.extname(sourcePath || "").toLowerCase() || ".html",
  };
}

function groupArtifactVersions(versions, query) {
  const groups = new Map();
  for (const version of versions) {
    const key = version.artifactId || `${version.sessionId}:${version.sourcePath}`;
    const group = groups.get(key) || {
      id: version.artifactId || stableId(key),
      url: version.url || null,
      sessionId: version.sessionId,
      title: version.title || path.basename(version.sourcePath || "Claude artifact"),
      description: version.description,
      favicon: version.favicon,
      project: version.project,
      sourcePath: version.sourcePath,
      sessionIds: [],
      versions: [],
    };
    group.url ||= version.url;
    group.title = version.title || group.title;
    group.description = version.description || group.description;
    group.favicon = version.favicon || group.favicon;
    if (version.sessionId && !group.sessionIds.includes(version.sessionId)) group.sessionIds.push(version.sessionId);
    group.versions.push(version);
    groups.set(key, group);
  }
  let artifacts = [...groups.values()].map((artifact) => {
    artifact.versions = coalesceCrossTranscriptVersions(artifact.versions);
    artifact.versions.sort((left, right) => Date.parse(left.publishedAt || "") - Date.parse(right.publishedAt || ""));
    artifact.versions.forEach((version, index) => { version.version = index + 1; });
    artifact.recoverableVersions = artifact.versions.filter((version) => version.source).length;
    artifact.latest = artifact.versions.at(-1) || null;
    artifact.updatedAt = artifact.latest?.publishedAt || null;
    return artifact;
  });
  if (query) artifacts = artifacts.filter((artifact) => matchesArtifact(artifact, query));
  return artifacts.sort((left, right) => Date.parse(right.updatedAt || "") - Date.parse(left.updatedAt || ""));
}

function coalesceCrossTranscriptVersions(versions) {
  const merged = [];
  for (const version of [...versions].sort((left, right) => Date.parse(left.publishedAt || "") - Date.parse(right.publishedAt || ""))) {
    const timestamp = Date.parse(version.publishedAt || "");
    const duplicateIndex = merged.findIndex((candidate) => {
      if (candidate.sourcePath !== version.sourcePath || candidate.url !== version.url) return false;
      if (candidate.toolUseId && version.toolUseId) return candidate.toolUseId === version.toolUseId;
      const candidateTimestamp = Date.parse(candidate.publishedAt || "");
      return Number.isFinite(timestamp) && Number.isFinite(candidateTimestamp) && Math.abs(timestamp - candidateTimestamp) < 15_000;
    });
    if (duplicateIndex < 0) {
      merged.push(version);
      continue;
    }
    const candidate = merged[duplicateIndex];
    merged[duplicateIndex] = {
      ...candidate,
      ...version,
      artifactId: version.artifactId || candidate.artifactId,
      url: version.url || candidate.url,
      toolUseId: version.toolUseId || candidate.toolUseId,
      title: version.title || candidate.title,
      description: version.description || candidate.description,
      favicon: version.favicon || candidate.favicon,
      label: version.label || candidate.label,
      publishedAt: laterTimestamp(candidate.publishedAt, version.publishedAt),
      source: version.source || candidate.source,
      frameLinked: Boolean(version.frameLinked || candidate.frameLinked),
    };
  }
  return merged;
}

function laterTimestamp(left, right) {
  const leftTime = Date.parse(left || "");
  const rightTime = Date.parse(right || "");
  if (!Number.isFinite(leftTime)) return right || left;
  if (!Number.isFinite(rightTime)) return left;
  return rightTime > leftTime ? right : left;
}

export function matchesArtifact(artifact, query) {
  const needle = String(query || "").toLowerCase();
  return [artifact.id, artifact.url, artifact.sessionId, artifact.title, artifact.sourcePath]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle));
}

function dedupeVersions(versions) {
  const seen = new Set();
  return versions.filter((version) => {
    const key = version.toolUseId || `${version.url}:${version.publishedAt}:${version.sourcePath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stableId(value) {
  return `local-${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function sessionFromTranscriptPath(filePath) {
  const basename = path.basename(filePath, ".jsonl");
  return basename.startsWith("agent-") ? basename.slice(6) : basename;
}

function normalizeSourcePath(value, project) {
  return typeof value === "string" && value ? path.resolve(project || process.cwd(), value) : null;
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content || "");
  return content.map((part) => typeof part === "string" ? part : part?.text || part?.content || "").join("\n");
}

function cleanValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isArtifactUrl(value) {
  return typeof value === "string" && ARTIFACT_URL.test(value);
}
