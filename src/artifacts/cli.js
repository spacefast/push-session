import os from "node:os";
import path from "node:path";

import * as prompts from "@clack/prompts";
import pc from "picocolors";

import { loadConfig, saveConfig } from "../config.js";
import { publishSession } from "../spacefast.js";
import { parseArtifactArgs } from "./args.js";
import { discoverClaudeArtifacts, matchesArtifact } from "./claude.js";
import { writeArtifactBundle } from "./files.js";
import { renderClaudeArtifactBundle } from "./render.js";

export async function runArtifacts(argv = [], dependencies = {}) {
  const parsed = parseArtifactArgs(argv);
  if (parsed.options.help) return printArtifactHelp();
  const log = dependencies.log || console.log;
  const env = dependencies.env || process.env;
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && !parsed.options.json);
  if (interactive) prompts.intro(pc.bgGreen(pc.black(" Claude artifacts ")));

  const discover = dependencies.discoverArtifacts || discoverClaudeArtifacts;
  const artifacts = await discover({
    home: env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
  });
  if (artifacts.length === 0) throw new Error("No published Claude Code artifacts were found in local transcripts.");

  if (parsed.command === "list") {
    const visible = parsed.query ? artifacts.filter((artifact) => matchesArtifact(artifact, parsed.query)) : artifacts;
    if (parsed.options.json) log(JSON.stringify({ artifacts: visible.map(artifactSummary) }));
    else printArtifactList(visible);
    return visible;
  }

  const selected = await selectArtifacts(artifacts, parsed, interactive);
  const recoverable = selected.filter((artifact) => artifact.recoverableVersions > 0);
  if (recoverable.length === 0) throw new Error("The selected artifact source could not be recovered from its transcript, file history, or live path.");
  const defaultRoute = parsed.options.all
    ? "artifacts/claude/archive"
    : `artifacts/claude/${safeSegment(recoverable[0].id)}`;
  const bundle = renderClaudeArtifactBundle(recoverable, {
    allVersions: parsed.options.allVersions,
    basePath: parsed.options.route || defaultRoute,
  });

  if (parsed.command === "export") {
    const written = writeArtifactBundle(bundle, parsed.options.output, { force: parsed.options.force });
    const result = {
      command: "export",
      artifacts: bundle.artifactCount,
      recovered: bundle.recoveredCount,
      bytes: bundle.totalBytes,
      outputDirectory: written.outputDirectory,
      entryPath: written.entryPath,
      files: written.files.length,
    };
    if (parsed.options.json) log(JSON.stringify(result));
    else {
      prompts.note(`${result.recovered} artifact${result.recovered === 1 ? "" : "s"}\n${result.files} files\n${result.bytes.toLocaleString()} bytes\n${result.entryPath}`, "Exported");
      prompts.outro("Original sources are stored beside each rendered page.");
    }
    return result;
  }

  if (parsed.options.dryRun) {
    const result = {
      command: "publish",
      dryRun: true,
      artifacts: bundle.artifactCount,
      recovered: bundle.recoveredCount,
      bytes: bundle.totalBytes,
      files: bundle.files.length,
      route: bundle.entryPath,
    };
    if (parsed.options.json) log(JSON.stringify(result));
    else prompts.note(`${result.recovered} artifact${result.recovered === 1 ? "" : "s"}\n${result.files} files\n${result.bytes.toLocaleString()} bytes\n${result.route}`, "Ready to publish");
    return result;
  }

  const title = recoverable.length === 1 ? recoverable[0].title : "Recovered Claude artifacts";
  const published = await publishBundle({ bundle, title, parsed, env, dependencies, interactive });
  const result = {
    command: "publish",
    artifacts: bundle.artifactCount,
    recovered: bundle.recoveredCount,
    url: published.shareUrl,
    landingUrl: published.landingUrl,
    versionUrl: published.versionUrl,
    spaceId: published.space.id,
    claimUrl: published.space.claimUrl,
    claimExpiresAt: published.space.expiresAt,
  };
  if (parsed.options.json) log(JSON.stringify(result));
  else printPublished(result);
  return result;
}

async function selectArtifacts(artifacts, parsed, interactive) {
  if (parsed.options.all) return artifacts;
  if (parsed.query) {
    const exact = artifacts.find((artifact) => artifact.id === parsed.query || artifact.url === parsed.query);
    if (exact) return [exact];
    const matches = artifacts.filter((artifact) => matchesArtifact(artifact, parsed.query));
    if (matches.length === 1) return matches;
    if (matches.length > 1) throw new Error(`Artifact query "${parsed.query}" is ambiguous (${matches.length} matches).`);
    throw new Error(`Artifact "${parsed.query}" was not found.`);
  }
  if (!interactive) throw new Error(`Choose an artifact in non-interactive mode, or use --all.`);
  const value = await prompts.select({
    message: "Which Claude artifact?",
    options: artifacts.map((artifact) => ({
      value: artifact.id,
      label: artifact.title,
      hint: `${artifact.recoverableVersions}/${artifact.versions.length} versions · ${shortId(artifact.sessionId)}`,
    })),
    maxItems: 12,
  });
  if (prompts.isCancel(value)) {
    prompts.cancel("No artifact was selected.");
    process.exit(0);
  }
  return [artifacts.find((artifact) => artifact.id === value)];
}

async function publishBundle({ bundle, title, parsed, env, dependencies, interactive }) {
  const warn = dependencies.warn || ((message) => interactive ? prompts.log.warn(message) : console.error(`Warning: ${message}`));
  let config;
  try {
    config = loadConfig(env);
  } catch (error) {
    warn(`${error.message} Publishing without saved state.`);
    config = { version: 1 };
  }
  const configuredSpace = parsed.options.newSpace ? null : parsed.options.space || config.space?.id || null;
  const reusingGlobalSpace = Boolean(!parsed.options.newSpace && !parsed.options.space && config.space?.id);
  const configuredClaim = configuredSpace === config.space?.id ? config.space?.claimToken : null;
  const savedAccessToken = configuredSpace === config.space?.id ? config.space?.accessToken : null;
  const accessToken = env.SPACEFAST_TOKEN || savedAccessToken || null;
  if (parsed.options.space && !accessToken && !configuredClaim) {
    throw new Error("Publishing to --space requires SPACEFAST_TOKEN unless it is the saved anonymous space.");
  }

  const spinner = interactive ? prompts.spinner() : null;
  spinner?.start(configuredSpace ? "Publishing artifacts to your session space" : "Creating your artifact space");
  const publish = ({ spaceId, accessToken: token, claimToken }) => publishSession({
    session: { id: `claude-artifacts-${Date.now()}`, title },
    files: bundle.files,
    entryPath: bundle.entryPath,
    basePath: bundle.basePath,
    apiUrl: parsed.options.apiUrl || config.apiUrl,
    spaceId,
    accessToken: token,
    claimToken,
    fetchImpl: dependencies.fetchImpl,
    shareName: `Claude artifact: ${title}`,
    spaceTitle: "Shared AI artifacts",
  });

  let result;
  try {
    result = await publish({ spaceId: configuredSpace, accessToken, claimToken: configuredClaim });
  } catch (error) {
    if (!reusingGlobalSpace || !canReplaceSavedSpace(error)) {
      spinner?.stop("Publish failed");
      throw error;
    }
    warn("The saved session space is no longer reusable. Creating a new global artifact space.");
    const fallbackToken = env.SPACEFAST_TOKEN && error?.status !== 401 ? env.SPACEFAST_TOKEN : null;
    try {
      result = await publish({ spaceId: null, accessToken: fallbackToken, claimToken: null });
    } catch (fallbackError) {
      if (!fallbackToken || fallbackError?.stage !== "initial_publish" || fallbackError?.status !== 401) {
        spinner?.stop("Publish failed");
        throw fallbackError;
      }
      warn("SPACEFAST_TOKEN was rejected. Retrying with a claimable anonymous space.");
      result = await publish({ spaceId: null, accessToken: null, claimToken: null });
    }
  }
  spinner?.stop("Artifacts published");

  try {
    const continuingSavedAccess = result.space.id === config.space?.id ? savedAccessToken : null;
    const persistedAccessToken = result.credential?.accessToken || continuingSavedAccess || undefined;
    saveConfig({
      version: 1,
      apiUrl: parsed.options.apiUrl || config.apiUrl,
      space: {
        id: result.space.id,
        liveUrl: result.space.liveUrl,
        accessToken: persistedAccessToken,
        claimToken: persistedAccessToken ? undefined : result.space.claimToken,
        claimUrl: result.space.claimUrl,
        expiresAt: result.space.expiresAt,
      },
    }, env);
  } catch (error) {
    warn(`${error.message} This publish succeeded, but global space reuse could not be saved.`);
  }
  return result;
}

function artifactSummary(artifact) {
  return {
    id: artifact.id,
    url: artifact.url,
    title: artifact.title,
    sessionId: artifact.sessionId,
    sessionIds: artifact.sessionIds,
    project: artifact.project,
    sourcePath: artifact.sourcePath,
    publishes: artifact.versions.length,
    recoverableVersions: artifact.recoverableVersions,
    updatedAt: artifact.updatedAt,
  };
}

function printArtifactList(artifacts) {
  for (const artifact of artifacts) {
    const statusText = artifact.recoverableVersions > 0 ? "recoverable" : "source missing";
    const status = artifact.recoverableVersions > 0 ? pc.green(statusText.padEnd(14)) : pc.red(statusText.padEnd(14));
    console.log(`${shortId(artifact.id).padEnd(12)} ${status} ${artifact.recoverableVersions}/${artifact.versions.length}  ${artifact.title}`);
  }
  console.log(`\n${artifacts.length} Claude artifact${artifacts.length === 1 ? "" : "s"}`);
}

function printPublished(result) {
  const lines = [
    `Access\n${result.url}`,
    result.versionUrl && `Version\n${result.versionUrl}`,
    result.claimUrl && `Claim\n${result.claimUrl}`,
  ].filter(Boolean).join("\n\n");
  prompts.note(lines, "Artifact link");
  prompts.outro(result.claimUrl ? "Claim the space to keep these links permanently." : "Done.");
}

function canReplaceSavedSpace(error) {
  return error?.stage === "claim_exchange" || (error?.stage === "initial_publish" && [401, 403, 404].includes(error?.status));
}

function shortId(value) {
  const text = String(value || "unknown");
  return text.length > 12 ? text.slice(0, 8) : text;
}

function safeSegment(value) {
  return String(value || "artifact").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "artifact";
}

function printArtifactHelp() {
  console.log(`Recover Claude Code artifacts from local session history.

Usage
  npx push-session artifacts list [query]
  npx push-session artifacts export [query] [--output <dir>]
  npx push-session artifacts publish [query]

Selection
  --all           Export or publish every discovered artifact
  --versions      Include every recoverable published version

Export
  --output <dir>  Output directory (default: claude-artifacts-export)
  --force         Overwrite generated paths in a non-empty output directory

Publish
  --space <id>    Publish to a specific Spacefast space
  --new-space     Create and remember a new artifact space
  --route <path>  Override the Spacefast route prefix
  --dry-run       Build the bundle without uploading it
  --api-url       Override the Spacefast API origin

Output
  --json          Print machine-readable output
  -h, --help      Show this help`);
}
