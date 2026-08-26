import path from "node:path";

import { artifactRouteSegment } from "./render.js";

export function renderChatGptSitesBundle(sites, options = {}) {
  const basePath = normalizePath(options.basePath || "sites");
  const files = [];
  const manifestSites = [];

  for (const site of sites) {
    const segment = siteRouteSegment(site.id);
    const siteBase = `${basePath}/${segment}`;
    const versions = site.versions.map((version) => versionMetadata(version));
    const entry = {
      id: site.id,
      title: site.title,
      slug: site.slug,
      originalUrl: site.url,
      recoveredVersions: site.recoverableVersions,
      versions,
    };
    manifestSites.push(entry);
    files.push({
      path: `${siteBase}/index.html`,
      content: renderSitePage(site),
      contentType: "text/html; charset=utf-8",
    });
    files.push({
      path: `${siteBase}/manifest.json`,
      content: JSON.stringify(entry, null, 2),
      contentType: "application/json; charset=utf-8",
    });
    for (const version of site.versions) {
      if (!version.source) continue;
      const versionBase = `${siteBase}/versions/${siteVersionSegment(version)}`;
      files.push({
        path: `${versionBase}/index.html`,
        content: renderVersionPage(site, version),
        contentType: "text/html; charset=utf-8",
      });
      for (const sourceFile of version.source.files) {
        files.push({
          path: `${versionBase}/source/${sourceFile.path}`,
          content: sourceFile.content,
          contentType: sourceFile.contentType,
        });
      }
      if (version.source.archive) {
        files.push({
          path: `${versionBase}/${version.source.archive.name}`,
          content: version.source.archive.content,
          contentType: "application/gzip",
        });
      }
    }
  }

  const manifest = {
    schema: "push-session/chatgpt-sites/v1",
    exportedAt: options.exportedAt || new Date().toISOString(),
    sites: manifestSites,
  };
  files.push({
    path: `${basePath}/manifest.json`,
    content: JSON.stringify(manifest, null, 2),
    contentType: "application/json; charset=utf-8",
  });
  return { files, manifest };
}

export function siteRouteSegment(value) {
  return artifactRouteSegment(value || "site");
}

export function siteVersionSegment(version) {
  const label = version.number || version.id || version.commitSha?.slice(0, 12) || "version";
  return `${String(version.number || 0).padStart(4, "0")}-${artifactRouteSegment(label)}`;
}

function renderSitePage(site) {
  const versions = [...site.versions].reverse().map((version) => {
    const recovered = version.source
      ? `<a class="button secondary" href="versions/${siteVersionSegment(version)}/">Browse recovered version</a>`
      : `<span class="missing">Local source is no longer available</span>`;
    const live = version.liveUrl || site.url;
    return `<article><div><span class="version">Version ${escapeHtml(version.number || version.id || "recorded")}</span><h2>${escapeHtml(shortCommit(version.commitSha))}</h2><p>${escapeHtml(versionStatus(version))}</p></div><div class="actions">${live ? `<a class="button" href="${escapeAttribute(live)}" target="_blank" rel="noreferrer">Open live Site ↗</a>` : ""}${recovered}</div></article>`;
  }).join("\n");
  return pageShell(site.title, `<header><span class="eyebrow">ChatGPT Sites · session output</span><h1>${escapeHtml(site.title)}</h1><p>This page preserves the Site version recorded in the Codex session. The live application stays on ChatGPT Sites; recovered source and the original deployment package stay with this Spacefast share.</p>${site.url ? `<a class="button hero" href="${escapeAttribute(site.url)}" target="_blank" rel="noreferrer">Open live Site ↗</a>` : ""}</header><section>${versions || "<p>No saved Site versions were recorded.</p>"}</section><footer><a href="manifest.json">manifest.json</a></footer>`);
}

function renderVersionPage(site, version) {
  const source = version.source;
  const sourceFiles = source.files.map((file) => `<li><a href="source/${encodePath(file.path)}">${escapeHtml(file.path)}</a><span>${formatBytes(file.bytes)}</span></li>`).join("\n");
  const omitted = source.omittedFiles.length
    ? `<details><summary>${source.omittedFiles.length} sensitive or oversized file${source.omittedFiles.length === 1 ? "" : "s"} omitted</summary><ul class="omitted">${source.omittedFiles.map((file) => `<li>${escapeHtml(file)}</li>`).join("")}</ul></details>`
    : "";
  const archive = source.archive ? `<a class="button secondary" href="${source.archive.name}" download>Download deployment package · ${formatBytes(source.archive.bytes)}</a>` : "";
  const live = version.liveUrl || site.url;
  return pageShell(`${site.title} · version ${version.number}`, `<header><a class="back" href="../../">← ${escapeHtml(site.title)}</a><span class="eyebrow">Recovered Site version</span><h1>Version ${escapeHtml(version.number || version.id || "recorded")}</h1><p>Exact commit <code>${escapeHtml(version.commitSha || "not recorded")}</code> · ${escapeHtml(source.recoveredFrom)}</p><div class="actions">${live ? `<a class="button" href="${escapeAttribute(live)}" target="_blank" rel="noreferrer">Open live Site ↗</a>` : ""}${archive}</div></header><section><div class="file-heading"><h2>Source files</h2><span>${source.files.length} files · ${formatBytes(source.files.reduce((sum, file) => sum + file.bytes, 0))}</span></div><ul class="files">${sourceFiles || "<li>No Git source files were recoverable.</li>"}</ul>${omitted}</section>`);
}

function pageShell(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)}</title><style>
    :root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#090b10;color:#eef1f8}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 20% -10%,#12335b 0,transparent 34%),radial-gradient(circle at 90% 0,#31205b 0,transparent 28%),#090b10}main{width:min(980px,calc(100% - 2rem));margin:auto;padding:5rem 0}header{max-width:760px;margin-bottom:3rem}.eyebrow{display:block;margin-bottom:.7rem;color:#79b8ff;font-size:.73rem;font-weight:750;letter-spacing:.12em;text-transform:uppercase}h1{margin:0 0 1rem;font-size:clamp(2.5rem,7vw,5rem);line-height:.98;letter-spacing:-.055em}h2{margin:.15rem 0 .4rem;font-size:1.05rem}p{color:#aeb7ca;line-height:1.65}.button{display:inline-flex;align-items:center;justify-content:center;padding:.7rem .9rem;border:1px solid #478be6;border-radius:.7rem;background:#2369c8;color:white;font-size:.83rem;font-weight:700;text-decoration:none}.button:hover{background:#2e78dc}.button.secondary{border-color:#343c4c;background:#171b24;color:#d8dfec}.hero{margin-top:.6rem}.actions{display:flex;flex-wrap:wrap;align-items:center;gap:.55rem}article{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin:.75rem 0;padding:1.2rem;border:1px solid #252c39;border-radius:1rem;background:#11151dcc}.version{color:#79b8ff;font-size:.7rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.missing{color:#7f899b;font-size:.8rem}.back{display:inline-block;margin-bottom:2rem;color:#aeb7ca;text-decoration:none}code{padding:.15rem .35rem;border:1px solid #303849;border-radius:.35rem;background:#11151d;color:#dbe7fb;font:85% ui-monospace,SFMono-Regular,monospace}.file-heading{display:flex;align-items:baseline;justify-content:space-between;gap:1rem}.file-heading span,footer{color:#7f899b;font-size:.78rem}.files,.omitted{padding:0;list-style:none;border:1px solid #252c39;border-radius:.8rem;overflow:hidden}.files li,.omitted li{display:flex;justify-content:space-between;gap:1rem;padding:.65rem .8rem;border-bottom:1px solid #202632;font:12px/1.4 ui-monospace,SFMono-Regular,monospace}.files li:last-child,.omitted li:last-child{border-bottom:0}.files a{min-width:0;overflow-wrap:anywhere;color:#cbdcff;text-decoration:none}.files span{flex:none;color:#697487}details{margin-top:1rem;color:#8994a6;font-size:.8rem}summary{cursor:pointer}footer{margin-top:2rem}footer a{color:#aeb7ca}@media(max-width:680px){main{padding:3rem 0}article{align-items:flex-start;flex-direction:column}.file-heading{align-items:flex-start;flex-direction:column}}
  </style></head><body><main>${body}</main></body></html>`;
}

function versionMetadata(version) {
  return {
    id: version.id,
    number: version.number,
    commitSha: version.commitSha,
    status: version.status,
    liveUrl: version.liveUrl,
    savedAt: version.savedAt,
    sourceRecovered: Boolean(version.source),
    recoveredFrom: version.source?.recoveredFrom || null,
    files: version.source?.files.map(({ path: filePath, bytes, sha256, contentType }) => ({ path: filePath, bytes, sha256, contentType })) || [],
    omittedFiles: version.source?.omittedFiles || [],
    archiveRecovered: Boolean(version.source?.archive),
  };
}

function normalizePath(value) {
  const normalized = String(value || "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.split("/").includes("..")) throw new Error(`Invalid Sites export path: ${value}`);
  return normalized;
}

function encodePath(value) {
  return String(value).split("/").map(encodeURIComponent).join("/");
}

function shortCommit(value) {
  return value ? `Commit ${value.slice(0, 12)}` : "Saved Site version";
}

function versionStatus(version) {
  const pieces = [version.status, version.savedAt ? new Date(version.savedAt).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" }) : null].filter(Boolean);
  return pieces.join(" · ") || "Recorded in this session";
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const power = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / (1024 ** power)).toFixed(power === 0 ? 0 : 1)} ${units[power]}`;
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function escapeHtml(value) {
  return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
