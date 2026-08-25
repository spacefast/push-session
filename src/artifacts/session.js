import { createSharePath, renderSessionBundle } from "../render.js";
import { artifactRouteSegment, artifactVersionSegment, renderClaudeArtifactBundle } from "./render.js";

const ARTIFACT_URL = /https:\/\/claude\.ai\/code\/artifact\/([a-zA-Z0-9-]+)/g;

export function renderSessionWithArtifacts(session, messages, artifacts = [], options = {}) {
  const basePath = options.basePath || createSharePath(session.id);
  const recoverable = artifacts.filter((artifact) => artifact.recoverableVersions > 0);
  const descriptors = recoverable.map(sessionArtifactDescriptor);
  const linkedMessages = linkSessionArtifactMessages(messages, recoverable);
  const sessionBundle = renderSessionBundle(session, linkedMessages, {
    ...options,
    basePath,
    artifacts: descriptors,
  });
  if (recoverable.length === 0) return { ...sessionBundle, artifactCount: 0, artifactVersions: 0 };

  const artifactBundle = renderClaudeArtifactBundle(recoverable, {
    allVersions: true,
    artifactDirectory: "",
    basePath: `${basePath}/artifacts`,
    exportedAt: options.publishedAt,
  });
  const files = [...sessionBundle.files, ...artifactBundle.files];
  return {
    ...sessionBundle,
    files,
    totalBytes: files.reduce((total, file) => total + Buffer.byteLength(file.content), 0),
    artifactCount: recoverable.length,
    artifactVersions: recoverable.reduce((total, artifact) => total + artifact.recoverableVersions, 0),
  };
}

export function linkSessionArtifactMessages(messages, artifacts) {
  const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const versionsByToolId = new Map();
  for (const artifact of artifacts) {
    for (const version of artifact.versions) {
      if (version.source && version.toolUseId) versionsByToolId.set(version.toolUseId, { artifact, version });
    }
  }

  return messages.map((message) => {
    const referencedIds = new Set([
      ...artifactIds(message.content),
      ...artifactIds(message.output),
    ]);
    const exact = versionsByToolId.get(message.id);
    const referenced = exact?.artifact || [...referencedIds].map((id) => artifactsById.get(id)).find(Boolean);
    if (!referenced) return message;
    return {
      ...message,
      content: localizeArtifactUrls(message.content, artifactsById),
      output: localizeArtifactUrls(message.output, artifactsById),
      artifact: messageArtifactDescriptor(referenced, exact?.version),
    };
  });
}

export function sessionArtifactDescriptor(artifact) {
  const segment = artifactRouteSegment(artifact.id);
  return {
    id: artifact.id,
    title: artifact.title,
    description: artifact.description,
    favicon: artifact.favicon,
    href: `artifacts/${segment}/index.html`,
    originalUrl: artifact.url,
    publishes: artifact.versions.length,
    recoveredVersions: artifact.recoverableVersions,
  };
}

function messageArtifactDescriptor(artifact, version) {
  const descriptor = sessionArtifactDescriptor(artifact);
  if (!version) return descriptor;
  return {
    ...descriptor,
    href: `artifacts/${artifactRouteSegment(artifact.id)}/versions/${artifactVersionSegment(version)}/index.html`,
    version: version.version,
    label: version.label,
  };
}

function localizeArtifactUrls(value, artifactsById) {
  if (typeof value !== "string") return value;
  return value.replace(ARTIFACT_URL, (url, id) => artifactsById.has(id)
    ? `artifacts/${artifactRouteSegment(id)}/index.html`
    : url);
}

function artifactIds(value) {
  if (typeof value !== "string") return [];
  return [...value.matchAll(ARTIFACT_URL)].map((match) => match[1]);
}
