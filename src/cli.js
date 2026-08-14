import fs from "node:fs";

import * as prompts from "@clack/prompts";
import pc from "picocolors";

import { adapters, findAdapter, scanAgents } from "./agents/index.js";
import { parseArgs } from "./args.js";
import { loadConfig, saveConfig } from "./config.js";
import { renderSessionBundle } from "./render.js";
import { publishSession } from "./spacefast.js";

const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

export async function run(argv = process.argv.slice(2), dependencies = {}) {
  const parsed = parseArgs(argv);
  if (parsed.options.help) return printHelp();
  if (parsed.options.version) return console.log(packageJson.version);

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && !parsed.options.json);
  if (!parsed.agent && !interactive) {
    throw new Error("Choose an agent in non-interactive mode, for example: npx push-session codex <session-id>");
  }
  if (interactive) prompts.intro(pc.bgGreen(pc.black(" push-session ")));

  const availableAdapters = dependencies.adapters || adapters;
  const selection = await selectAgentAndSession({
    requestedAgent: parsed.agent,
    requestedSession: parsed.sessionId,
    interactive,
    limit: parsed.options.limit,
    availableAdapters,
  });
  const messages = await selection.adapter.load(selection.session);
  if (messages.length === 0) throw new Error("The selected session has no shareable messages.");

  const bundle = renderSessionBundle(selection.session, messages);
  if (parsed.options.dryRun) {
    const result = {
      dryRun: true,
      agent: selection.adapter.id,
      sessionId: selection.session.id,
      title: selection.session.title,
      messages: messages.length,
      bytes: bundle.totalBytes,
      pages: bundle.pageCount,
      route: bundle.entryPath,
    };
    if (parsed.options.json) console.log(JSON.stringify(result));
    else {
      prompts.note(`${result.messages} transcript entries\n${result.pages} JSON page${result.pages === 1 ? "" : "s"}\n${result.bytes.toLocaleString()} bytes\n${result.route}`, "Ready to publish");
      prompts.outro("Dry run complete. Nothing was uploaded.");
    }
    return result;
  }

  const env = dependencies.env || process.env;
  const config = loadConfig(env);
  const configuredSpace = parsed.options.newSpace ? null : parsed.options.space || config.space?.id || null;
  const configuredClaim = configuredSpace === config.space?.id ? config.space?.claimToken : null;
  const accessToken = env.SPACEFAST_TOKEN || null;
  if (parsed.options.space && !accessToken && !configuredClaim) {
    throw new Error("Publishing to --space requires SPACEFAST_TOKEN unless it is the saved anonymous space.");
  }

  const spinner = interactive ? prompts.spinner() : null;
  spinner?.start(configuredSpace ? "Publishing to your session space" : "Creating your session space");
  let result;
  try {
    result = await publishSession({
      session: selection.session,
      files: bundle.files,
      entryPath: bundle.entryPath,
      basePath: bundle.basePath,
      apiUrl: parsed.options.apiUrl || config.apiUrl,
      spaceId: configuredSpace,
      accessToken,
      claimToken: configuredClaim,
      fetchImpl: dependencies.fetchImpl,
    });
    spinner?.stop("Session published");
  } catch (error) {
    spinner?.stop("Publish failed");
    if (error?.status === 401 && configuredClaim) {
      throw new Error("The saved Spacefast space was claimed or its key expired. Set SPACEFAST_TOKEN and retry, or use --new-space.");
    }
    throw error;
  }

  saveConfig(
    {
      version: 1,
      apiUrl: parsed.options.apiUrl || config.apiUrl,
      space: {
        id: result.space.id,
        liveUrl: result.space.liveUrl,
        claimToken: accessToken ? undefined : result.space.claimToken,
        claimUrl: result.space.claimUrl,
        expiresAt: result.space.expiresAt,
      },
    },
    env,
  );

  const output = {
    agent: selection.adapter.id,
    sessionId: selection.session.id,
    title: selection.session.title,
    url: result.shareUrl,
    landingUrl: result.landingUrl,
    pages: bundle.pageCount,
    versionUrl: result.versionUrl,
    spaceId: result.space.id,
    claimUrl: result.space.claimUrl,
    claimExpiresAt: result.space.expiresAt,
  };
  if (parsed.options.json) {
    console.log(JSON.stringify(output));
  } else {
    prompts.note(
      [
        `${pc.bold("Session")}  ${output.url || "Published"}`,
        output.versionUrl && `${pc.bold("Version")}  ${output.versionUrl}`,
        output.claimUrl && `${pc.bold("Claim")}    ${output.claimUrl}`,
        output.claimExpiresAt && `${pc.bold("Expires")}  ${formatDate(output.claimExpiresAt)}`,
      ]
        .filter(Boolean)
        .join("\n"),
      "Share link",
    );
    prompts.outro(output.claimUrl ? "Claim the space to keep these links permanently." : "Done.");
  }
  return output;
}

async function selectAgentAndSession({ requestedAgent, requestedSession, interactive, limit, availableAdapters }) {
  let adapter = requestedAgent ? findAdapter(requestedAgent, availableAdapters) : null;
  let sessions;
  if (requestedAgent && !adapter) {
    throw new Error(`Unknown agent "${requestedAgent}". Supported agents: ${availableAdapters.map((item) => item.id).join(", ")}.`);
  }

  if (!adapter) {
    const found = scanAgents(availableAdapters, { limit });
    if (found.length === 0) throw new Error("No supported agent sessions were found on this machine.");
    const value = await prompts.select({
      message: "Which agent has the session?",
      options: found.map((entry) => ({
        value: entry.adapter.id,
        label: entry.adapter.label,
        hint: `${entry.sessions.length} session${entry.sessions.length === 1 ? "" : "s"}`,
      })),
    });
    cancelIfNeeded(value);
    const selected = found.find((entry) => entry.adapter.id === value);
    adapter = selected.adapter;
    sessions = selected.sessions;
  } else {
    if (!adapter.installed()) throw new Error(`${adapter.label} does not appear to be installed.`);
    sessions = adapter.discover({ limit, query: requestedSession });
  }

  if (sessions.length === 0) throw new Error(`No ${adapter.label} sessions were found.`);
  let session;
  if (requestedSession) {
    session = resolveSession(sessions, requestedSession);
  } else {
    if (!interactive) throw new Error(`Choose a session ID in non-interactive mode: npx push-session ${adapter.id} <session-id>`);
    const visible = sessions.slice(0, limit);
    const value = await prompts.select({
      message: `Which ${adapter.label} session should be shared?`,
      options: visible.map((item) => ({
        value: item.id,
        label: item.title,
        hint: [relativeDate(item.updatedAt || item.createdAt), shortProject(item.project), shortId(item.id)].filter(Boolean).join(" · "),
      })),
      maxItems: 12,
    });
    cancelIfNeeded(value);
    session = visible.find((item) => item.id === value);
  }
  return { adapter, session };
}

function resolveSession(sessions, query) {
  const exact = sessions.find((session) => session.id === query);
  if (exact) return exact;
  const matches = sessions.filter((session) => session.id.startsWith(query));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`Session ID prefix "${query}" is ambiguous (${matches.length} matches).`);
  throw new Error(`Session "${query}" was not found.`);
}

function cancelIfNeeded(value) {
  if (!prompts.isCancel(value)) return;
  prompts.cancel("No session was published.");
  process.exit(0);
}

function relativeDate(value) {
  if (!value) return null;
  const delta = Date.now() - value;
  if (delta < 60_000) return "now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)}d ago`;
  return new Date(value).toISOString().slice(0, 10);
}

function shortProject(project) {
  if (!project) return null;
  const parts = project.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || project;
}

function shortId(id) {
  return id.length > 12 ? id.slice(0, 8) : id;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function printHelp() {
  console.log(`push-session ${packageJson.version}

Share local AI coding-agent sessions through Spacefast.

Usage
  npx push-session
  npx push-session <agent>
  npx push-session <agent> <session-id>

Agents
  codex          OpenAI Codex CLI
  claude         Anthropic Claude Code
  gemini         Google Gemini CLI
  cursor         Cursor Agent

Options
  --space <id>   Publish to a specific Spacefast space
  --new-space    Create and remember a new session space
  --limit <n>    Sessions shown in the picker (default: 50)
  --dry-run      Parse and render without uploading
  --json         Print one machine-readable result
  --api-url      Override the Spacefast API origin
  -h, --help     Show help
  -v, --version  Show version

Environment
  SPACEFAST_TOKEN      Publish to an owned space
  SPACEFAST_API_URL    Override the Spacefast API origin
  PUSH_SESSION_CONFIG Override the config file path`);
}
