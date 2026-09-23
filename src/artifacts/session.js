import { createSharePath, renderSessionBundle } from "../render.js";
import { artifactRouteSegment, artifactVersionSegment, renderClaudeArtifactBundle } from "./render.js";
import { renderChatGptSitesBundle, siteRouteSegment, siteVersionSegment } from "./sites-render.js";

const ARTIFACT_URL = /https:\/\/claude\.ai\/code\/artifact\/([a-zA-Z0-9-]+)/g;

export function renderSessionWithArtifacts(session, messages, artifacts = [], options = {}) {
  const basePath = options.basePath || createSharePath(session.id);
  const sites = Array.isArray(options.sites) ? options.sites : [];
  const recoverable = artifacts.filter((artifact) => artifact.recoverableVersions > 0);
  const descriptors = [
    ...recoverable.map(sessionArtifactDescriptor),
    ...sites.map(sessionSiteDescriptor),
  ];
  const linkedMessages = linkSessionSiteMessages(linkSessionArtifactMessages(messages, recoverable), sites);
  const sessionBundle = renderSessionBundle(session, linkedMessages, {
    ...options,
    basePath,
    artifacts: descriptors,
  });
  const artifactFiles = recoverable.length > 0
    ? renderClaudeArtifactBundle(recoverable, {
      allVersions: true,
      artifactDirectory: "",
      basePath: `${basePath}/artifacts`,
      exportedAt: options.publishedAt,
    }).files
    : [];
  const siteFiles = sites.length > 0
    ? renderChatGptSitesBundle(sites, {
      basePath: `${basePath}/sites`,
      exportedAt: options.publishedAt,
    }).files
    : [];
  const files = [...sessionBundle.files, ...artifactFiles, ...siteFiles];
  return {
    ...sessionBundle,
    files,
    totalBytes: files.reduce((total, file) => total + Buffer.byteLength(file.content), 0),
    artifactCount: recoverable.length,
    artifactVersions: recoverable.reduce((total, artifact) => total + artifact.recoverableVersions, 0),
    siteCount: sites.length,
    siteVersions: sites.reduce((total, site) => total + site.versions.length, 0),
    recoveredSiteVersions: sites.reduce((total, site) => total + site.recoverableVersions, 0),
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
    kind: "claude-artifact",
  };
}

export function sessionSiteDescriptor(site) {
  return {
    id: site.id,
    title: site.title,
    description: site.slug ? `ChatGPT Site · ${site.slug}` : "ChatGPT Site",
    favicon: "◈",
    href: `sites/${siteRouteSegment(site.id)}/index.html`,
    originalUrl: site.url,
    publishes: site.versions.length,
    recoveredVersions: site.recoverableVersions,
    kind: "chatgpt-site",
  };
}

export function linkSessionSiteMessages(messages, sites) {
  const byCallId = new Map();
  const byUrl = new Map();
  for (const site of sites) {
    for (const callId of site.callIds || []) byCallId.set(callId, { site, version: null });
    if (site.url) byUrl.set(site.url, site);
    for (const version of site.versions) {
      for (const callId of version.callIds || []) byCallId.set(callId, { site, version });
      if (version.liveUrl) byUrl.set(version.liveUrl, site);
    }
  }
  return messages.map((message) => {
    const exact = byCallId.get(message.id);
    const referenced = exact?.site || [...byUrl].find(([url]) => [message.content, message.output].some((value) => typeof value === "string" && value.includes(url)))?.[1];
    if (!referenced) return message;
    const descriptor = sessionSiteDescriptor(referenced);
    const version = exact?.version;
    return {
      ...message,
      artifact: version?.source ? {
        ...descriptor,
        href: `sites/${siteRouteSegment(referenced.id)}/versions/${siteVersionSegment(version)}/index.html`,
        version: version.number,
      } : descriptor,
    };
  });
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
