import os from "node:os";

import * as clack from "@clack/prompts";
import pc from "picocolors";

import { adapters, findAdapter, scanAgents } from "./agents/index.js";
import { byRecent } from "./agents/common.js";
import { parseArgs } from "./args.js";
import { discoverClaudeSessionArtifacts } from "./artifacts/claude.js";
import { runArtifacts } from "./artifacts/cli.js";
import { renderSessionWithArtifacts } from "./artifacts/session.js";
import { discoverCodexSessionSites } from "./artifacts/sites.js";
import { resolveAuth } from "./auth.js";
import {
  configPath,
  loadConfig,
  ownedSpaceFor,
  rememberOwnedSpace,
  rememberPublishResult,
  resolveApiUrl,
  selectPublishState,
} from "./config.js";
import { listSpaces, publishSession } from "./spacefast.js";
import { packageVersion } from "./version.js";

export const OWNED_SPACE_TITLE = "AI sessions";
const NEW_SPACE = Symbol("new-space");
const AUTOCOMPLETE_AFTER = 8;

export async function run(argv = process.argv.slice(2), dependencies = {}) {
  if (argv[0] === "artifacts") return runArtifacts(argv.slice(1), dependencies);
  const env = dependencies.env || process.env;
  const parsed = parseArgs(argv, env);
  if (parsed.options.help) return printHelp();
  if (parsed.options.version) return console.log(packageVersion);
  const log = dependencies.log || console.log;
  const prompts = dependencies.prompts || clack;
  const interactive = dependencies.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY && !parsed.options.json);
  const warn = dependencies.warn || ((message) => {
    if (interactive) prompts.log.warn(message);
    else console.error(`Warning: ${message}`);
  });
  if (!parsed.agent && !interactive) {
    throw new Error("Pick an agent when there's no terminal to ask in, e.g. npx push-session codex <session-id>");
  }
  if (interactive) prompts.intro(pc.bgGreen(pc.black(" push-session ")));

  const availableAdapters = dependencies.adapters || adapters;
  const selection = await selectAgentAndSession({
    requestedAgent: parsed.agent,
    requestedSession: parsed.sessionId,
    interactive,
    limit: parsed.options.limit,
    availableAdapters,
    prompts,
    warn,
  });
  const messages = await selection.adapter.load(selection.session);
  if (messages.length === 0) throw new Error("That session has nothing to share yet.");

  let artifacts = [];
  let sites = [];
  if (selection.adapter.id === "claude") {
    try {
      const discoverSessionArtifacts = dependencies.discoverSessionArtifacts || discoverClaudeSessionArtifacts;
      artifacts = await discoverSessionArtifacts(selection.session, {
        home: env.CLAUDE_CONFIG_DIR,
      });
    } catch (error) {
      warn(`Could not recover this session's Claude artifacts: ${error.message}. Publishing the transcript without them.`);
    }
  }
  if (selection.adapter.id === "codex") {
    try {
      const discoverSessionSites = dependencies.discoverSessionSites || discoverCodexSessionSites;
      sites = await discoverSessionSites(selection.session);
    } catch (error) {
      warn(`Could not recover this session's ChatGPT Sites: ${error.message}. Publishing the transcript without them.`);
    }
  }
  const bundle = renderSessionWithArtifacts(selection.session, messages, artifacts, { sites });
  if (parsed.options.dryRun) {
    const result = {
      dryRun: true,
      agent: selection.adapter.id,
      sessionId: selection.session.id,
      title: selection.session.title,
      messages: messages.length,
      bytes: bundle.totalBytes,
      pages: bundle.pageCount,
      artifacts: bundle.artifactCount,
      artifactVersions: bundle.artifactVersions,
      sites: bundle.siteCount,
      siteVersions: bundle.siteVersions,
      recoveredSiteVersions: bundle.recoveredSiteVersions,
      route: bundle.entryPath,
    };
    if (parsed.options.json) log(JSON.stringify(result));
    else {
      prompts.note(`${result.messages} transcript entries\n${result.pages} JSON page${result.pages === 1 ? "" : "s"}\n${result.artifacts} Claude artifact${result.artifacts === 1 ? "" : "s"}\n${result.sites} ChatGPT Site${result.sites === 1 ? "" : "s"}\n${result.bytes.toLocaleString()} bytes\n${result.route}`, "Ready to publish");
      prompts.outro("Dry run. Nothing left your machine.");
    }
    return result;
  }

  let config;
  let configReadable = true;
  try {
    config = loadConfig(env);
  } catch (error) {
    warn(`${error.message} Config file: ${configPath(env)}. Publishing without saved state; the existing config will not be changed.`);
    config = { version: 1 };
    configReadable = false;
  }

  const apiUrl = resolveApiUrl(config, parsed.options);
  const auth = await (dependencies.resolveAuth || resolveAuth)({ env, apiUrl, keyring: dependencies.keyring });
  const context = { parsed, config, configReadable, apiUrl, auth, env, interactive, prompts, warn, dependencies, selection, bundle };
  const result = auth ? await publishOwned(context) : await publishAnonymous(context);

  const output = {
    agent: selection.adapter.id,
    sessionId: selection.session.id,
    title: selection.session.title,
    url: result.shareUrl,
    landingUrl: result.landingUrl,
    pages: bundle.pageCount,
    artifacts: bundle.artifactCount,
    artifactVersions: bundle.artifactVersions,
    sites: bundle.siteCount,
    siteVersions: bundle.siteVersions,
    recoveredSiteVersions: bundle.recoveredSiteVersions,
    versionUrl: result.versionUrl,
    spaceId: result.space.id,
    spaceTitle: result.space.title || null,
    claimUrl: result.space.claimUrl,
    claimExpiresAt: result.space.expiresAt,
  };
  if (parsed.options.json) {
    log(JSON.stringify(output));
  } else {
    (dependencies.write || ((text) => process.stdout.write(text)))(formatShareLinks(output));
    if (output.claimUrl) {
      prompts.outro("Claim the Space to keep these links. Or run `sf login` once and sessions land in your own Space.");
    } else {
      prompts.outro("Shipped.");
    }
  }
  return output;
}

async function publishOwned(context) {
  const { parsed, config, configReadable, apiUrl, auth, env, interactive, prompts, warn, dependencies, selection, bundle } = context;
  const fetchImpl = dependencies.fetchImpl;
  const api = { apiUrl, accessToken: auth.accessToken, fetchImpl };
  const remember = (space) => {
    if (!configReadable) return;
    try {
      rememberOwnedSpace(config, apiUrl, space, env);
    } catch (error) {
      warn(`${error.message} Published fine, but your default Space wasn't saved.`);
    }
  };

  // --space is a one-off: publish there, keep the saved default.
  let target = null;
  let saveTarget = false;
  if (parsed.options.space) {
    target = { id: parsed.options.space, title: null };
  } else if (parsed.options.newSpace) {
    target = { id: null, title: OWNED_SPACE_TITLE };
    saveTarget = true;
  } else {
    const saved = parsed.options.pickSpace ? null : ownedSpaceFor(config, apiUrl);
    if (saved) {
      target = saved;
    } else if (interactive) {
      target = await pickSpace({ api, prompts, message: "Where should your sessions live?" });
      saveTarget = true;
    } else {
      const [existing] = (await listSpaces({ ...api, query: OWNED_SPACE_TITLE })).filter((space) => space.title === OWNED_SPACE_TITLE);
      target = existing ? { id: existing.id, title: existing.title, liveUrl: existing.liveUrl } : { id: null, title: OWNED_SPACE_TITLE };
      saveTarget = true;
    }
  }

  const publish = (space, teamId) => {
    const spinner = interactive ? prompts.spinner() : null;
    spinner?.start(space.id ? `Publishing to ${space.title || space.id}` : `Creating ${space.title} and publishing`);
    return publishSession({
      session: selection.session,
      files: bundle.files,
      entryPath: bundle.entryPath,
      basePath: bundle.basePath,
      apiUrl,
      spaceId: space.id,
      spaceTitle: space.id ? undefined : space.title,
      teamId: space.id ? undefined : teamId || parsed.options.team,
      access: space.id ? undefined : "private",
      accessToken: auth.accessToken,
      fetchImpl,
    }).then(
      (result) => {
        spinner?.stop(`Published to ${result.space.title || space.title || result.space.id}`);
        return result;
      },
      (error) => {
        spinner?.error("Publish failed");
        throw error;
      },
    );
  };

  let result;
  for (let attempt = 0; ; attempt += 1) {
    try {
      result = await publish(target);
      break;
    } catch (error) {
      if (!target.id && error?.code === "team_required" && interactive && attempt === 0) {
        const teamId = await pickTeam({ prompts, teams: error.details?.teams || [] });
        result = await publish(target, teamId);
        break;
      }
      if (!target.id && error?.code === "team_required") {
        const slugs = (error.details?.teams || []).map((team) => team.slug).join(", ");
        throw new Error(`You're in more than one team. Choose one with --team <slug>${slugs ? ` (${slugs})` : ""}.`);
      }
      if (error?.status === 401) {
        throw new Error(auth.source === "sf"
          ? "Your sf login was rejected. Run `sf login` again."
          : "SPACEFAST_TOKEN was rejected. Check the token or unset it.");
      }
      const gone = target.id && [403, 404].includes(error?.status);
      if (gone && parsed.options.space) {
        throw new Error(`Space "${parsed.options.space}" isn't one you can publish to.`);
      }
      if (!gone) throw error;
      if (!interactive || attempt > 0) {
        throw new Error(`Your saved Space "${target.title || target.id}" is gone or no longer yours. Pick another with --pick-space, or publish once with --space <id>.`);
      }
      warn(`Your saved Space "${target.title || target.id}" is gone or no longer yours. Pick a new home.`);
      target = await pickSpace({ api, prompts, message: "Where should your sessions live now?" });
      saveTarget = true;
    }
  }

  if (saveTarget) {
    remember({ id: result.space.id, title: result.space.title || target.title, liveUrl: result.space.liveUrl });
  }
  if (!result.space.title) result.space.title = target.title || null;
  return result;
}

async function pickSpace({ api, prompts, message }) {
  const spaces = await listSpaces(api);
  const options = [
    { value: NEW_SPACE, label: `New Space · ${OWNED_SPACE_TITLE}`, hint: "private to your team" },
    ...spaces.map((space) => ({
      value: space.id,
      label: space.title || space.slug,
      hint: [space.teamSlug, hostOf(space.liveUrl) || space.slug].filter(Boolean).join(" · "),
    })),
  ];
  const choose = options.length > AUTOCOMPLETE_AFTER ? prompts.autocomplete : prompts.select;
  const value = await choose({
    message,
    options,
    maxItems: 10,
    ...(choose === prompts.autocomplete && { placeholder: "Type to search your Spaces", filter: matchesOption }),
  });
  cancelIfNeeded(prompts, value);
  if (value === NEW_SPACE) return { id: null, title: OWNED_SPACE_TITLE };
  const space = spaces.find((item) => item.id === value);
  return { id: space.id, title: space.title, liveUrl: space.liveUrl };
}

async function pickTeam({ prompts, teams }) {
  if (teams.length === 0) throw new Error("Spacefast needs a team for the new Space. Pass --team <slug>.");
  const value = await prompts.select({
    message: "Which team owns the new Space?",
    options: teams.map((team) => ({ value: team.id, label: team.name || team.slug, hint: team.slug })),
  });
  cancelIfNeeded(prompts, value);
  return value;
}

async function publishAnonymous(context) {
  const { parsed, config, configReadable, env, interactive, prompts, warn, dependencies, selection, bundle } = context;
  const state = selectPublishState(config, parsed.options, env);
  if (interactive && !state.spaceId) prompts.log.info("Not signed in, so this goes to a claimable Space. `sf login` puts sessions in your own.");

  const spinner = interactive ? prompts.spinner() : null;
  spinner?.start(state.spaceId ? "Publishing to your session Space" : "Creating your session Space");
  const publish = ({ spaceId, accessToken: publishAccessToken, claimToken }) => publishSession({
    session: selection.session,
    files: bundle.files,
    entryPath: bundle.entryPath,
    basePath: bundle.basePath,
    apiUrl: state.apiUrl,
    spaceId,
    accessToken: publishAccessToken,
    claimToken,
    fetchImpl: dependencies.fetchImpl,
  });
  let result;
  try {
    result = await publish({
      spaceId: state.spaceId,
      accessToken: state.accessToken,
      claimToken: state.claimToken,
    });
    spinner?.stop("Session published");
  } catch (error) {
    if (!state.reusingGlobalSpace || !canReplaceSavedSpace(error)) {
      spinner?.stop("Publish failed");
      throw error;
    }
    warn("The saved session space is no longer reusable. Creating a new global session space.");
    spinner?.message("Creating a new session Space");
    try {
      result = await publish({ spaceId: null, accessToken: null, claimToken: null });
    } catch (fallbackError) {
      spinner?.stop("Publish failed");
      throw fallbackError;
    }
    spinner?.stop("Session published");
  }

  if (configReadable) {
    try {
      rememberPublishResult(config, state, result, env);
    } catch (error) {
      warn(`${error.message} This publish succeeded, but global space reuse could not be saved.`);
    }
  }
  return result;
}

export function formatShareLinks(output) {
  const fields = [
    output.title && ["Session", output.title],
    ["Link", output.url || "Published"],
    (output.spaceTitle || output.spaceId) && ["Space", output.spaceTitle || output.spaceId],
    output.versionUrl && ["Version", output.versionUrl],
    output.claimUrl && ["Claim", output.claimUrl],
    output.claimExpiresAt && ["Expires", formatDate(output.claimExpiresAt)],
  ].filter(Boolean);
  const bar = pc.gray("│");
  const lines = [bar, `${pc.green("◇")}  ${pc.bold("Share link")}`];
  for (const [label, value] of fields) {
    lines.push(bar, `${bar}  ${pc.bold(label)}`, `${bar}  ${value}`);
  }
  return `${lines.join("\n")}\n`;
}

function canReplaceSavedSpace(error) {
  if (error?.stage === "claim_exchange") return true;
  return error?.stage === "initial_publish" && [401, 403, 404].includes(error?.status);
}

async function selectAgentAndSession({ requestedAgent, requestedSession, interactive, limit, availableAdapters, prompts, warn }) {
  const adapter = requestedAgent ? findAdapter(requestedAgent, availableAdapters) : null;
  if (requestedAgent && !adapter) {
    throw new Error(`Unknown agent "${requestedAgent}". Try one of: ${availableAdapters.map((item) => item.id).join(", ")}.`);
  }

  let sessions;
  if (adapter) {
    if (!adapter.installed()) throw new Error(`${adapter.label} doesn't look installed here.`);
    sessions = adapter.discover({ limit: Infinity, query: requestedSession })
      .map((session) => ({ session, adapter }));
    if (sessions.length === 0) throw new Error(`No ${adapter.label} sessions here yet.`);
  } else {
    sessions = scanAgents(availableAdapters, { limit: Infinity, onError: (adapter, error) => warn(`Could not read ${adapter.label} sessions: ${error.message}`) })
      .flatMap((entry) => entry.sessions.map((session) => ({ session, adapter: entry.adapter })))
      .sort((left, right) => byRecent(left.session, right.session));
    if (sessions.length === 0) throw new Error("No agent sessions found on this machine. Run Codex, Claude Code, Gemini CLI, Cursor Agent, Pi, or T3 Code first.");
  }

  if (requestedSession) {
    return resolveSession(sessions, requestedSession);
  }
  if (!interactive) throw new Error(`Pass a session ID when there's no terminal to ask in: npx push-session ${adapter.id} <session-id>`);
  let page = 0;
  let search = "";
  while (true) {
    const matches = sessions.filter((entry) => matchesOption(search, {
      search: [entry.session.title, entry.session.project, entry.session.id, entry.adapter.label, entry.adapter.id].filter(Boolean).join(" "),
    }));
    const pageCount = Math.max(1, Math.ceil(matches.length / limit));
    const visible = matches.slice(page * limit, (page + 1) * limit);
    const options = visible.map((entry, index) => ({
      value: index,
      label: entry.session.title,
      hint: [
        adapter ? null : entry.adapter.label,
        relativeDate(entry.session.updatedAt || entry.session.createdAt),
        shortProject(entry.session.project),
        shortId(entry.session.id),
      ].filter(Boolean).join(" · "),
      search: [entry.session.title, entry.session.project, entry.session.id, entry.adapter.label, entry.adapter.id].filter(Boolean).join(" "),
    }));
    if (page > 0) options.push({ value: "previous", label: "← Previous page" });
    if (page + 1 < pageCount) options.push({ value: "next", label: "Next page →" });
    options.push({ value: "search", label: "Search all sessions…" });
    if (search) options.push({ value: "clear", label: "Clear search" });
    const message = adapter ? `Which ${adapter.label} session?` : "Which session do you want to share?";
    const value = await prompts.autocomplete({
      message: `${message} (${matches.length} sessions, page ${page + 1}/${pageCount})`,
      placeholder: "Filter this page, or choose Search all sessions",
      options,
      filter: (search, option) => typeof option.value === "string" || matchesOption(search, option),
      maxItems: 12,
    });
    cancelIfNeeded(prompts, value);
    if (value === "previous") page -= 1;
    else if (value === "next") page += 1;
    else if (value === "search") {
      const query = await prompts.text({ message: "Search by title, project, agent, or ID", initialValue: search });
      cancelIfNeeded(prompts, query);
      search = String(query || "").trim();
      page = 0;
    } else if (value === "clear") {
      search = "";
      page = 0;
    } else return visible[value];
  }
}

function matchesOption(search, option) {
  const haystack = (option.search || `${option.label || ""} ${option.hint || ""}`).toLowerCase();
  return search.toLowerCase().split(/\s+/).filter(Boolean).every((term) => haystack.includes(term));
}

function hostOf(value) {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

function resolveSession(sessions, query) {
  const exact = sessions.find((entry) => entry.session.id === query);
  if (exact) return exact;
  const matches = sessions.filter((entry) => entry.session.id.startsWith(query));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`Session ID prefix "${query}" is ambiguous (${matches.length} matches).`);
  throw new Error(`Session "${query}" was not found.`);
}

function cancelIfNeeded(prompts, value) {
  if (!prompts.isCancel(value)) return;
  prompts.cancel("Nothing published.");
  process.exit(0);
}

function relativeDate(value) {
  if (!value) return null;
  const time = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(time)) return null;
  const delta = Math.max(0, Date.now() - time);
  if (delta < 1_000) return "now";
  if (delta < 60_000) return `${Math.floor(delta / 1_000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  if (delta < 30 * 86_400_000) return `${Math.floor(delta / 86_400_000)}d ago`;
  return new Date(time).toISOString().slice(0, 10);
}

function shortProject(project) {
  if (!project) return null;
  const normalized = String(project).replaceAll("\\", "/").replace(/\/$/, "");
  const home = os.homedir().replaceAll("\\", "/").replace(/\/$/, "");
  const display = normalized === home ? "~" : normalized.startsWith(`${home}/`) ? `~${normalized.slice(home.length)}` : normalized;
  if (display.length <= 48) return display;
  const parts = display.split("/").filter(Boolean);
  return `…/${parts.slice(-3).join("/")}`;
}

function shortId(id) {
  return id.length > 12 ? id.slice(0, 8) : id;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function printHelp() {
  console.log(`push-session ${packageVersion}

Share your AI coding-agent sessions as private Spacefast links.

Usage
  npx push-session                       Pick any session from any agent
  npx push-session <agent>               Pick from one agent
  npx push-session <agent> <session-id>  Share that one, no questions
  npx push-session artifacts <list|export|publish>

Agents
  t3             T3 Code
  codex          OpenAI Codex CLI
  claude         Anthropic Claude Code
  gemini         Google Gemini CLI
  cursor         Cursor Agent
  pi             Pi coding agent

Where sessions go
  Signed in (sf login or SPACEFAST_TOKEN): the first run asks which of your
  Spaces gets your sessions and remembers it. Signed out: a claimable Space
  that lives on this machine until you claim it.

Options
  --pick-space   Choose your sessions Space again
  --space <id>   Publish to this Space once; your default stays put
  --new-space    Start a fresh "${OWNED_SPACE_TITLE}" Space and make it the default
  --team <slug>  Team for a new Space, if you're in more than one
  --limit <n>    Sessions per picker page (default: 50)
  --dry-run      Render everything, upload nothing
  --json         Print one machine-readable result
  --api-url      Override the Spacefast API origin
  -h, --help     Show help
  -v, --version  Show version

Environment
  SPACEFAST_TOKEN      Publish as this credential instead of your sf login
  SPACEFAST_API_URL    Override the Spacefast API origin
  PUSH_SESSION_CONFIG  Override the config file path`);
}
