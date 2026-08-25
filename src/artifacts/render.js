import path from "node:path";

import { artifactViewerScript, artifactViewerStyles } from "../artifact-viewer-assets.js";

export function renderClaudeArtifactBundle(artifacts, options = {}) {
  const basePath = normalizePublishPath(options.basePath || "artifacts/claude");
  const artifactDirectory = options.artifactDirectory === ""
    ? ""
    : normalizePublishPath(options.artifactDirectory || "artifacts");
  const files = [];
  const entries = [];

  for (const artifact of artifacts) {
    const recovered = artifact.versions.filter((version) => version.source);
    const latest = recovered.at(-1);
    const artifactSegment = artifactRouteSegment(artifact.id);
    const artifactRoute = [artifactDirectory, artifactSegment].filter(Boolean).join("/");
    const artifactBase = `${basePath}/${artifactRoute}`;
    const entry = {
      id: artifact.id,
      title: artifact.title,
      description: artifact.description,
      favicon: artifact.favicon,
      sourcePath: artifact.sourcePath,
      claudeUrl: artifact.url,
      sessionId: artifact.sessionId,
      publishCount: artifact.versions.length,
      recoverableVersions: recovered.length,
      latestRecoveredVersion: latest?.version || null,
      latestPublishedAt: artifact.latest?.publishedAt || null,
      route: latest ? `${artifactRoute}/index.html` : null,
      versions: artifact.versions.map(versionMetadata),
    };
    entries.push(entry);
    if (!latest) continue;

    files.push(...renderVersionFiles(artifact, latest, artifactBase));
    if (options.allVersions) {
      for (const version of recovered) {
        const versionSegment = artifactVersionSegment(version);
        files.push(...renderVersionFiles(artifact, version, `${artifactBase}/versions/${versionSegment}`));
      }
    }
  }

  const manifest = {
    schema: "push-session/claude-artifacts/v1",
    exportedAt: options.exportedAt || new Date().toISOString(),
    allVersions: Boolean(options.allVersions),
    artifacts: entries,
  };
  const entryPath = `${basePath}/index.html`;
  files.unshift(
    { path: entryPath, content: renderGallery(manifest), contentType: "text/html; charset=utf-8" },
    { path: `${basePath}/manifest.json`, content: JSON.stringify(manifest, null, 2), contentType: "application/json; charset=utf-8" },
  );

  return {
    basePath,
    entryPath,
    files,
    manifest,
    artifactCount: artifacts.length,
    recoveredCount: entries.filter((entry) => entry.route).length,
    totalBytes: files.reduce((total, file) => total + Buffer.byteLength(file.content), 0),
  };
}

function renderVersionFiles(artifact, version, basePath) {
  const extension = version.source.extension === ".htm" ? ".htm" : version.source.extension === ".md" ? ".md" : ".html";
  const sourceName = `source${extension}`;
  const sourcePath = `${basePath}/${sourceName}`;
  const index = extension === ".md"
    ? renderMarkdownArtifact(artifact, version, sourceName)
    : version.source.content;
  return [
    { path: `${basePath}/index.html`, content: index, contentType: "text/html; charset=utf-8" },
    { path: sourcePath, content: version.source.content, contentType: sourceContentType(extension) },
  ];
}

function renderMarkdownArtifact(artifact, version, sourceName) {
  const title = escapeHtml(artifact.title || path.basename(version.sourcePath || "Claude artifact"));
  const payload = {
    title: artifact.title || path.basename(version.sourcePath || "Claude artifact"),
    sourcePath: version.sourcePath,
    sourceName,
    source: version.source.content,
  };
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${title}</title>
  <style>${safeStyle(artifactViewerStyles)}</style>
</head>
<body>
  <div id="root"></div>
  <script id="claude-artifact-data" type="application/json">${safeJson(payload)}</script>
  <script>${safeScript(artifactViewerScript)}</script>
</body>
</html>`;
}

function renderGallery(manifest) {
  const cards = manifest.artifacts.map((artifact) => {
    const title = escapeHtml(artifact.title || artifact.id);
    const description = artifact.description ? `<p>${escapeHtml(artifact.description)}</p>` : "";
    const recovery = artifact.recoverableVersions === artifact.publishCount
      ? `${artifact.publishCount} publish${artifact.publishCount === 1 ? "" : "es"} recovered`
      : `${artifact.recoverableVersions} of ${artifact.publishCount} publishes recovered`;
    const body = artifact.route
      ? `<a class="card-link" href="${artifact.route.replace(/index\.html$/, "")}">Open recovered artifact <span>→</span></a>`
      : `<span class="missing">Source could not be recovered</span>`;
    return `<article>
      <div class="icon">${escapeHtml(artifact.favicon || "◇")}</div>
      <div><h2>${title}</h2>${description}<small>${escapeHtml(recovery)}</small>${body}</div>
    </article>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Recovered Claude artifacts</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background:#0c0a09; color:#e7e5e4; }
    * { box-sizing:border-box } body { margin:0; min-height:100vh; background:radial-gradient(circle at 50% -20%,#1f3d2a 0,transparent 38%),#0c0a09; }
    main { width:min(960px,calc(100% - 2.5rem)); margin:auto; padding:5rem 0; }
    header { margin-bottom:2.5rem } .eyebrow { color:#4ade80; font-size:.75rem; font-weight:700; letter-spacing:.12em; text-transform:uppercase }
    h1 { margin:.55rem 0; font-size:clamp(2.2rem,7vw,4.8rem); line-height:.98; letter-spacing:-.055em } header p { color:#a8a29e; max-width:42rem; line-height:1.6 }
    .grid { display:grid; gap:1rem } article { display:grid; grid-template-columns:3rem 1fr; gap:1rem; padding:1.35rem; border:1px solid #292524; border-radius:1rem; background:rgba(28,25,23,.82); box-shadow:0 18px 50px rgba(0,0,0,.18) }
    .icon { display:grid; place-items:center; width:3rem; height:3rem; border-radius:.8rem; background:#292524; font-size:1.35rem } h2 { margin:.1rem 0 .35rem; font-size:1.15rem } article p { margin:.25rem 0 .65rem; color:#a8a29e; line-height:1.5 } small { display:block; color:#78716c }
    .card-link { display:inline-flex; gap:.4rem; margin-top:1rem; color:#4ade80; font-weight:650; text-decoration:none } .card-link:hover { color:#86efac } .missing { display:inline-block; margin-top:1rem; color:#fca5a5 }
    footer { margin-top:2rem; color:#57534e; font-size:.8rem } footer a { color:#a8a29e }
  </style>
</head>
<body><main>
  <header><span class="eyebrow">push-session recovery</span><h1>Claude artifacts,<br>back in your hands.</h1><p>Recovered from local Claude Code transcripts and file history. Original source files are stored beside each rendered page.</p></header>
  <section class="grid">${cards || "<p>No artifacts were found.</p>"}</section>
  <footer>Exported ${escapeHtml(manifest.exportedAt)} · <a href="manifest.json">manifest.json</a></footer>
</main></body>
</html>`;
}

function versionMetadata(version) {
  return {
    version: version.version,
    label: version.label,
    publishedAt: version.publishedAt,
    sourcePath: version.sourcePath,
    sourceRecovered: Boolean(version.source),
    recoveredFrom: version.source?.recoveredFrom || null,
    bytes: version.source?.bytes || null,
    sha256: version.source?.sha256 || null,
  };
}

function sourceContentType(extension) {
  return extension === ".md" ? "text/markdown; charset=utf-8" : "text/html; charset=utf-8";
}

function normalizePublishPath(value) {
  const normalized = String(value || "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.split("/").some((segment) => segment === "..")) {
    throw new Error(`Invalid artifact export path: ${value}`);
  }
  return normalized;
}

export function artifactRouteSegment(value) {
  return String(value || "artifact")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "artifact";
}

export function artifactVersionSegment(version) {
  return `${String(version.version).padStart(4, "0")}-${artifactRouteSegment(version.label || "publish")}`;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeJson(value) {
  return JSON.stringify(value).replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
}

function safeScript(value) {
  return String(value).replace(/<\/(script)/gi, "<\\/$1");
}

function safeStyle(value) {
  return String(value).replace(/<\/(style)/gi, "<\\/$1");
}
