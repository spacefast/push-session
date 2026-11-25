import { randomUUID } from "node:crypto";
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
import { pickPublished } from "./published-picker.js";
import { redactDeep, redactText } from "./redact.js";
import { indexEntry, loadSessionIndex, sessionIndexFiles } from "./session-index.js";
import { OPEN_WEB, pickSession } from "./session-picker.js";
import {
  configPath,
  loadConfig,
  ownedSpaceFor,
  rememberOwnedSpace,
  rememberPublishResult,
  resolveApiUrl,
  selectPublishState,
} from "./config.js";
import {
  changeVisibility,
  listSpaceAccess,
  listSpaces,
  openToEveryone,
  publishSession,
  readSpace,
  readSpaceFiles,
  revokeIndexAccess,
  revokeSessionAccess,
  sessionAccess,
  sessionRoute,
  updateSpaceFiles,
} from "./spacefast.js";
import { drawAgentLogos } from "./terminal-logos.js";
import { openBrowser, runWeb } from "./web.js";
import { packageVersion } from "./version.js";

export const OWNED_SPACE_TITLE = "AI sessions";
const NEW_SPACE = Symbol("new-space");
const AUTOCOMPLETE_AFTER = 8;

export async function run(argv = process.argv.slice(2), dependencies = {}) {
  if (argv[0] === "artifacts") return runArtifacts(argv.slice(1), dependencies);
  if (argv[0] === "web") {
    if (argv.includes("-h") || argv.includes("--help")) return printHelp();
    if (argv.includes("-v") || argv.includes("--version")) return console.log(packageVersion);
    // Each publish from the page is an ordinary non-interactive run for one session.
    const publish = (args) => run(args, { ...dependencies, interactive: false, log: () => {}, warn: () => {} });
    return runWeb(argv.slice(1), { publish, dependencies });
  }
  const env = dependencies.env || process.env;
  const parsed = parseArgs(argv, env);
  if (parsed.options.help) return printHelp();
  if (parsed.options.version) return console.log(packageVersion);
  if (["list", "unshare", "delete"].includes(parsed.agent)) return manageSessions(parsed, dependencies);
  if (parsed.options.keepFiles || parsed.options.yes) throw new Error("--keep-files and --yes are only supported by unshare and delete.");
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
    // The browser picker publishes for real, to the saved Space: not offered where that differs from what was asked.
    web: !parsed.options.dryRun && !parsed.options.newSpace && !parsed.options.pickSpace,
    availableAdapters,
    prompts,
    warn,
  });
  if (selection.web) {
    // Ctrl+X in the list: carry on in the browser, with the same publishing options.
    const { team, space, apiUrl, redact } = parsed.options;
    const forwarded = [...(team ? ["--team", team] : []), ...(space ? ["--space", space] : []), ...(apiUrl ? ["--api-url", apiUrl] : []), ...(redact ? [] : ["--no-redact"])];
    return run(["web", ...forwarded], dependencies);
  }
  const loaded = await selection.adapter.load(selection.session);
  if (loaded.length === 0) throw new Error("That session has nothing to share yet.");
  let { value: messages, count: redacted, kinds: redactionCounts } = parsed.options.redact ? redactDeep(loaded) : { value: loaded, count: 0, kinds: {} };
  const countKinds = (found) => {
    redacted += found.count;
    for (const [kind, number] of Object.entries(found.kinds)) redactionCounts[kind] = (redactionCounts[kind] || 0) + number;
  };
  if (parsed.options.redact && selection.session.title) {
    // The title is usually the first prompt, so it can carry the same secrets as the transcript.
    const title = redactText(selection.session.title);
    selection.session = { ...selection.session, title: title.text };
    countKinds(title);
  }

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
  if (parsed.options.redact) {
    // Recovered artifact and Site sources are published too, so they get the same masking.
    const sources = redactDeep({ artifacts, sites });
    ({ artifacts, sites } = sources.value);
    countKinds(sources);
  }
  const renderBundle = (basePath) => renderSessionWithArtifacts(selection.session, messages, artifacts, { sites, ...(basePath && { basePath }) });
  const bundle = renderBundle();
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
      redacted,
      redactionCounts,
      route: bundle.entryPath,
    };
    if (parsed.options.json) log(JSON.stringify(result));
    else {
      prompts.note(`${result.messages} transcript entries\n${result.pages} JSON page${result.pages === 1 ? "" : "s"}\n${result.artifacts} Claude artifact${result.artifacts === 1 ? "" : "s"}\n${result.sites} ChatGPT Site${result.sites === 1 ? "" : "s"}\n${result.bytes.toLocaleString()} bytes\n${redactionLine(redacted, parsed.options.redact, redactionCounts)}\n${result.route}`, "Ready to publish");
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
  let skippedLogin = null;
  const auth = await (dependencies.resolveAuth || resolveAuth)({
    env,
    apiUrl,
    keyring: dependencies.keyring,
    onSkip: (reason, loginOrigin) => { skippedLogin = { reason, loginOrigin }; },
  });
  // A login that exists but can't be used must not silently turn into a claimable Space.
  if (!auth && skippedLogin?.reason === "expired") {
    throw new Error("Your sf login has expired. Run `sf login` again, or set SPACEFAST_TOKEN.");
  }
  if (!auth && skippedLogin?.reason === "unreadable") {
    throw new Error("Couldn't read your sf login. Run `sf login` again, or set SPACEFAST_TOKEN.");
  }
  if (!auth && skippedLogin?.reason === "other_api") {
    warn(`Your sf login is for ${skippedLogin.loginOrigin}, not ${apiUrl}. Publishing signed out.`);
  }
  if (!auth && parsed.options.visibility === "public") {
    throw new Error(`--${parsed.options.visibility} needs you signed in. Run \`sf login\` or set SPACEFAST_TOKEN.`);
  }
  // A session picked from the list gets one look before it leaves the machine; an explicit ID asks nothing.
  const review = interactive && !parsed.sessionId;
  if (review) {
    prompts.note(`${messages.length} transcript entries · ${bundle.totalBytes.toLocaleString()} bytes\n${redactionLine(redacted, parsed.options.redact, redactionCounts)}`, selection.session.title);
  } else if (redacted > 0) {
    warn(redactionLine(redacted, true, redactionCounts));
  }
  // Signed in, the review is the question of who may open the session; signed out there is one answer.
  if (review && !auth) {
    const confirmed = await prompts.confirm({ message: "Publish this session?" });
    cancelIfNeeded(prompts, confirmed);
    if (!confirmed) return nothingPublished(prompts);
  }
  const context = { parsed, config, configReadable, apiUrl, auth, env, interactive, prompts, warn, dependencies, selection, bundle, renderBundle, review };
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
    redacted,
    redactionCounts,
    visibility: result.visibility,
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
  const { parsed, config, configReadable, apiUrl, auth, env, interactive, prompts, warn, dependencies, selection, renderBundle, review } = context;
  const fetchImpl = dependencies.fetchImpl;
  const api = { apiUrl, accessToken: auth.accessToken, fetchImpl };
  // Null means the Space's session list could not be read, so its index page is left as it is.
  let unreadable = null;
  const loadIndex = async (space) => {
    unreadable = null;
    if (!space.id) return { sessions: [], rootTaken: false };
    try {
      return await loadSessionIndex(api, space.id, { first: context.bundle.basePath });
    } catch (error) {
      // A Space that is gone is reported by the publish itself.
      if (![403, 404].includes(error?.status)) unreadable = error;
      return null;
    }
  };
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
    // The remembered Space named by its ID is still the remembered Space, title and all.
    const saved = ownedSpaceFor(config, apiUrl);
    target = saved?.id === parsed.options.space ? saved : { id: parsed.options.space, title: null };
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

  // A session keeps the address it was first published at. A new one gets a random address, so a
  // public session cannot be found by guessing its ID.
  const legacyPath = context.bundle.basePath;
  const place = async (space) => {
    const index = await loadIndex(space);
    const list = index && index.sessions;
    if (unreadable) {
      throw new Error(`Could not read this Space's session list (${unreadable.message}), so this session's address and who can open it are unknown. Nothing was published; try again.`);
    }
    const known = list?.find((entry) => (entry.sessionId === selection.session.id && entry.agent === selection.adapter.id) || entry.path === legacyPath);
    return { list, root: !index?.rootTaken, bundle: renderBundle(known?.path || `sessions/${randomUUID()}`) };
  };
  let { list: sessions, root, bundle } = await place(target);
  const saved = sessions?.find((session) => session.path === bundle.basePath)?.visibility;
  let visibility = parsed.options.visibility;
  let chosen = Boolean(visibility);
  if (!visibility && review) {
    visibility = await prompts.select({
      message: "Who can open this session?",
      initialValue: saved || "private",
      options: [
        { value: "private", label: "Only people with the link", hint: "private" },
        { value: "public", label: "Everyone", hint: "public, no link needed" },
      ],
    });
    cancelIfNeeded(prompts, visibility);
    chosen = true;
  }
  // Republishing without a flag keeps what the session already had.
  visibility ||= saved || "private";

  const publish = (space, teamId) => {
    const listed = sessions && [
      ...sessions.filter((session) => session.path !== bundle.basePath),
      indexEntry({ path: bundle.basePath, session: selection.session, messages: bundle.stats?.messages, visibility }),
    ];
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
      visibility,
      indexFiles: listed ? sessionIndexFiles(listed, { spaceTitle: space.title, root }) : [],
      rootIndex: root,
      publicIndex: listed ? listed.some((session) => session.visibility === "public") : undefined,
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
      ({ list: sessions, root, bundle } = await place(target));
      // What the session had in the old Space says nothing about this one.
      if (!chosen) visibility = sessions?.find((session) => session.path === bundle.basePath)?.visibility || "private";
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
  const newSpace = { value: NEW_SPACE, label: `New Space · ${OWNED_SPACE_TITLE}`, hint: "private to your team" };
  const existing = spaces.map((space) => ({
    value: space.id,
    label: space.title || space.slug,
    hint: [space.teamSlug, hostOf(space.liveUrl) || space.slug].filter(Boolean).join(" · "),
  }));
  // If an "AI sessions" Space already exists, offer it before making another one with the same name.
  const options = spaces.some((space) => space.title === OWNED_SPACE_TITLE) ? [...existing, newSpace] : [newSpace, ...existing];
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
    // A claimed Space's key is exchanged once, so its credential is saved before anything else can fail.
    onCredential: (exchanged) => {
      if (!configReadable || spaceId !== config.space?.id) return;
      try {
        rememberPublishResult(config, state, { credential: { accessToken: exchanged }, space: config.space }, env);
      } catch (error) {
        warn(`${error.message} The saved session space's new credential could not be saved.`);
      }
    },
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

const MANAGE_SIGN_IN_MESSAGE = "Sign in with `sf login` to manage shared sessions.";

/** `list` shows what a Space has published and, in a terminal, changes it; `delete` and `unshare` take one session back. */
async function manageSessions(parsed, dependencies) {
  const { options } = parsed;
  const command = parsed.agent;
  const removing = command !== "list";
  if (removing && !parsed.sessionId) throw new Error(`Usage: push-session ${command} <session-id|route|url>${command === "unshare" ? " [--keep-files]" : ""} [--yes]`);
  if (command === "delete" && options.keepFiles) throw new Error("delete removes a session's files. To keep them, run `push-session unshare <session> --keep-files`.");
  if (!removing && (parsed.sessionId || options.keepFiles || options.yes)) throw new Error("Usage: push-session list [--json]");
  if (options.newSpace || options.pickSpace || options.team || options.dryRun || options.visibility) {
    throw new Error("list, delete and unshare use an existing Space; --new-space, --pick-space, --team, --dry-run, --public and --private are not supported.");
  }
  const env = dependencies.env || process.env;
  const log = dependencies.log || console.log;
  const prompts = dependencies.prompts || clack;
  const interactive = !options.json && (dependencies.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY));
  if (removing && !interactive && !options.yes && !options.json) {
    throw new Error(`${command === "delete" ? "Deleting" : "Unsharing"} without a terminal requires --yes or --json.`);
  }
  const config = loadConfig(env);
  const apiUrl = resolveApiUrl(config, options);
  const auth = await (dependencies.resolveAuth || resolveAuth)({ env, apiUrl, keyring: dependencies.keyring });
  const savedAnonymous = apiUrl === resolveApiUrl(config, {}) ? config.space : null;
  const savedOwned = ownedSpaceFor(config, apiUrl);
  const space = options.space
    ? [savedOwned, savedAnonymous].find((saved) => saved?.id === options.space) || { id: options.space }
    : (auth && savedOwned) || savedAnonymous;
  if (!space?.id) throw new Error("No remembered session Space. Publish a session first or pass --space <id>.");
  // A signed-out Space answers to its own credential, not to an account it was never claimed into.
  const signedOutSpace = savedAnonymous?.id === space.id ? savedAnonymous : null;
  const accessToken = signedOutSpace?.accessToken || auth?.accessToken || signedOutSpace?.claimToken || null;
  if (!accessToken) throw new Error(MANAGE_SIGN_IN_MESSAGE);
  const api = { apiUrl, accessToken, fetchImpl: dependencies.fetchImpl };
  const inSpace = { ...api, spaceId: space.id };
  const visibilityOf = (entries, sessionPath) => (openToEveryone(entries, sessionPath) ? "public" : "private");

  // In a terminal a change shows that it is under way; either way its outcome is one line.
  const progress = (label) => {
    const spinner = interactive ? prompts.spinner?.() : null;
    spinner?.start(label);
    return {
      done: (message) => (spinner ? spinner.stop(message) : log(message)),
      failed: (message) => (spinner ? spinner.error(message || `${label} failed`) : message && log(message)),
    };
  };

  const load = async () => {
    // A Space named with --space is not one this machine remembers, so its title and address are read.
    const [index, access, details] = await Promise.all([loadSessionIndex(api, space.id), listSpaceAccess(inSpace), space.liveUrl ? space : readSpace(inSpace)]);
    return { index, access, details, origin: originOf(details.liveUrl) };
  };

  const published = ({ index, access, origin }) => index.sessions
    .map((entry) => {
      const visibility = visibilityOf(access, entry.path);
      const shareLinks = sessionAccess(access, entry.path).links;
      return {
        sessionId: entry.sessionId || entry.path.slice("sessions/".length),
        title: entry.title || entry.path,
        agent: entry.agent || null,
        route: entry.path,
        visibility,
        // A public session opens at its own address; a private one through its share link.
        url: visibility === "public" ? origin && `${origin}/${entry.path}/` : shareLinks[0]?.url || null,
        shareLinks,
        createdAt: entry.createdAt || null,
        updatedAt: entry.updatedAt || entry.publishedAt || null,
      };
    })
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));

  // Ends a session's links and public access and, unless its files are kept, deletes them.
  const takeBack = async ({ index, access, details }, basePath, { as, keepFiles, ask }) => {
    const verb = as === "delete" ? "Delete" : "Unshare";
    const entry = index.sessions.find((session) => session.path === basePath);
    const own = sessionAccess(access, basePath);
    const deletePaths = keepFiles ? [] : (await readSpaceFiles({ ...inSpace, select: () => [] })).paths.filter((file) => file.startsWith(`${basePath}/`));
    if (!entry && !own.links.length && !own.publicGrants.length && !deletePaths.length) throw new Error(`No published session found at ${basePath}.`);
    const ends = [
      own.links.length > 0 && `${own.links.length} share link${own.links.length === 1 ? "" : "s"}`,
      own.publicGrants.length > 0 && "public access",
    ].filter(Boolean).join(" and ") || "no links";
    const files = keepFiles ? "keeps its files for your team" : `deletes ${deletePaths.length} file${deletePaths.length === 1 ? "" : "s"}`;
    if (ask) {
      const confirmed = await prompts.confirm({
        message: `${verb} "${entry?.title || basePath}"? This ends ${ends} and ${files}.`,
        initialValue: false,
      });
      if (prompts.isCancel(confirmed) || !confirmed) {
        log(`Nothing ${verb.toLowerCase()}d.`);
        return { cancelled: true };
      }
    }
    const revoked = { linkIds: [], publicGrants: 0 };
    // What is left once the session's own grants are gone. A wider one, such as a public Space, is
    // not this command's to end, so files that are kept stay open through it, and that is said.
    const remaining = access.filter((item) => !own.publicGrants.includes(item));
    const stillPublic = keepFiles && openToEveryone(remaining, basePath);
    const change = progress(keepFiles ? "Ending its links" : "Deleting");
    try {
      await revokeSessionAccess(inSpace, own, revoked);
      // The session leaves the Space's list, or stays on it when its files are kept.
      const sessions = index.sessions
        .filter((session) => session.path !== basePath || keepFiles)
        .map((session) => (session.path === basePath ? { ...session, visibility: stillPublic ? "public" : "private" } : session));
      if (!sessions.some((session) => visibilityOf(remaining, session.path) === "public")) await revokeIndexAccess(inSpace, remaining);
      await updateSpaceFiles({ ...inSpace, deletePaths, files: sessionIndexFiles(sessions, { spaceTitle: details.title, root: !index.rootTaken }) });
    } catch (error) {
      change.failed();
      // The route, not what was typed: a link that was just ended no longer leads to the session.
      const again = ["push-session", as, basePath, options.space && `--space ${options.space}`, options.apiUrl && `--api-url ${options.apiUrl}`, keepFiles && "--keep-files"].filter(Boolean).join(" ");
      error.message = `${error.message} ${verb} stopped after ending ${revoked.linkIds.length} of ${own.links.length} links; file removal is not confirmed. Run \`${again}\` to finish.`;
      throw error;
    }
    const result = { spaceId: space.id, route: basePath, revokedLinkIds: revoked.linkIds, revokedPublicAccess: revoked.publicGrants > 0, deletedPaths: deletePaths, keptFiles: keepFiles, stillPublic };
    if (options.json) log(JSON.stringify(result));
    else {
      change.done(`${verb}d ${entry?.title ? `"${entry.title}"` : basePath}: ended ${ends}, ${keepFiles ? "kept its files" : `deleted ${deletePaths.length} file${deletePaths.length === 1 ? "" : "s"}`}.`);
      if (stillPublic) log("Its files are still open to everyone, because the Space itself is public.");
    }
    return result;
  };

  // Changes who can open a session and returns the address that now opens it.
  const setVisibility = async ({ index, access, details, origin }, session, visibility) => {
    // The other sessions are written as their access has them, which is what the list just showed.
    const sessions = index.sessions.map((entry) => ({ ...entry, visibility: entry.path === session.route ? visibility : visibilityOf(access, entry.path) }));
    const root = !index.rootTaken;
    // Every public grant of the session's own ends, however it was written.
    if (visibility === "private") await revokeSessionAccess(inSpace, { links: [], publicGrants: sessionAccess(access, session.route).publicGrants });
    const link = await changeVisibility(
      { ...inSpace, basePath: session.route, visibility, title: session.title, rootIndex: root, publicIndex: sessions.some((entry) => entry.visibility === "public") },
      () => updateSpaceFiles({ ...inSpace, files: sessionIndexFiles(sessions, { spaceTitle: details.title, root }) }),
    );
    return visibility === "public" ? origin && `${origin}/${session.route}/` : link?.url || null;
  };

  // Publishes a session again from this machine, to the address and the access it already has.
  const update = async ({ index }, session) => {
    const entry = index.sessions.find((item) => item.path === session.route);
    const change = progress("Updating");
    const warnings = [];
    try {
      const output = await run(
        // The Space on screen is named, so a default that changed while the list was open is not published to.
        [entry.agent, entry.sessionId, "--json", ...(signedOutSpace ? [] : [`--${session.visibility}`, "--space", space.id]), ...(options.apiUrl ? ["--api-url", options.apiUrl] : [])],
        { ...dependencies, interactive: false, log: () => {}, warn: (message) => warnings.push(message) },
      );
      change.done(`Updated "${flatTitle(output.title || session.title)}"`);
      for (const line of [output.url, ...warnings].filter(Boolean)) log(`${pc.gray("│")}  ${line}`);
      return true;
    } catch (error) {
      // The session may no longer be on this machine; the list goes on either way.
      change.failed(`Could not update "${flatTitle(session.title)}": ${error.message}`);
      return false;
    }
  };

  // What a session in the list can have done to it, as the keys that do it.
  const actionsFor = ({ index, access }, session) => {
    const entry = index.sessions.find((item) => item.path === session.route);
    const own = sessionAccess(access, session.route);
    // A session the Space itself opens to everyone cannot be made private here, and a signed-out
    // Space has no public sessions: a key is offered only where it does something.
    const fixed = Boolean(signedOutSpace) || openToEveryone(access.filter((item) => !own.publicGrants.includes(item)), session.route);
    // A publish to a signed-out Space goes to the session's own address and nowhere else, and signed
    // in it goes to another Space altogether: updating is offered where it lands on this session.
    const here = entry?.sessionId
      && (!signedOutSpace || (!auth && sessionRoute({ id: entry.sessionId }) === `${session.route}/index.html`))
      && findAdapter(entry.agent, dependencies.adapters || adapters)?.installed();
    return [
      ...(session.url ? [{ key: "enter", label: "open" }] : []),
      ...(fixed ? [] : [{ key: "c", label: session.visibility === "public" ? "make private" : "make public" }]),
      ...(here ? [{ key: "u", label: "update" }] : []),
      { key: "d", label: "delete" },
    ];
  };

  try {
    let state = await load();
    if (removing) {
      const basePath = resolveSharedRoute(parsed.sessionId, { sessions: state.index.sessions, access: state.access, origin: state.origin });
      return await takeBack(state, basePath, { as: command, keepFiles: options.keepFiles, ask: interactive && !options.yes });
    }

    let sessions = published(state);
    const columns = dependencies.columns || process.stdout.columns;
    const title = state.details.title || space.id;
    if (options.json) log(JSON.stringify({ spaceId: space.id, sessions }));
    else if (!interactive || sessions.length === 0) log(formatSessionList({ title, sessions }, { columns }));
    // In a terminal the list is also where a session is changed: a key acts on the row the cursor is on.
    let route;
    while (interactive && sessions.length > 0) {
      const choice = await (dependencies.pickPublished || pickPublished)({
        title: listHeading(title, sessions.length),
        options: sessions.map((session) => ({ value: session.route, name: flatTitle(session.title), lines: sessionLines(session, columns), actions: actionsFor(state, session) })),
        initialValue: route,
        closed: formatSessionList({ title, sessions }, { columns }),
      });
      if (!choice) break;
      route = choice.value;
      if (choice.action === "enter") {
        (dependencies.openBrowser || openBrowser)(sessions.find((item) => item.route === route).url);
        continue;
      }
      // The list may have been open for a while, so the Space is read again and the change is made
      // to what it holds now: a session published meanwhile stays on the sessions page, and a key
      // the session no longer takes does nothing.
      state = await load();
      sessions = published(state);
      const session = sessions.find((item) => item.route === route);
      if (!session || !actionsFor(state, session).some((item) => item.key === choice.action)) {
        if (sessions.length === 0) log(formatSessionList({ title, sessions }));
        continue;
      }
      if (choice.action === "d") {
        if ((await takeBack(state, route, { as: "delete", keepFiles: false, ask: true })).cancelled) continue;
      } else if (choice.action === "u") {
        if (!(await update(state, session))) continue;
      } else {
        const visibility = session.visibility === "public" ? "private" : "public";
        const change = progress(`Making it ${visibility}`);
        const url = await setVisibility(state, session, visibility).catch((error) => {
          change.failed();
          throw error;
        });
        change.done(`"${flatTitle(session.title)}" is now ${visibility}`);
        if (url) log(`${pc.gray("│")}  ${url}`);
      }
      state = await load();
      sessions = published(state);
      if (sessions.length === 0) log(formatSessionList({ title, sessions }));
    }
    return { spaceId: space.id, sessions };
  } catch (error) {
    // Until it is claimed, a signed-out Space can be published to and nothing else.
    if (signedOutSpace && !signedOutSpace.accessToken && [401, 403, 404].includes(error.status)) {
      error.message = `This Space has not been claimed, so its sessions cannot be managed yet. Claim it${signedOutSpace.claimUrl ? ` at ${signedOutSpace.claimUrl}` : ""}, then run this again. ${error.message}`;
    } else if (!auth && [401, 403].includes(error.status)) error.message = `${MANAGE_SIGN_IN_MESSAGE} ${error.message}`;
    throw error;
  }
}

// A title on one line, short enough for a prompt.
function flatTitle(title) {
  const flat = String(title).replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
}

// A session ID, a sessions/<id> route, or a link to the session, as the folder it is published in.
function resolveSharedRoute(value, { sessions, access, origin }) {
  const invalid = () => new Error("Expected a session ID, sessions/<id> route, or session share URL.");
  if ([".", ".."].includes(value)) throw invalid();
  let route = value;
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    const linked = access.find((entry) => entry.subject?.audience === "link" && entry.subject.url === url.href);
    if (linked) route = linked.subject.landingPath;
    else {
      if (url.origin !== origin) throw new Error("That URL does not belong to the selected Space. Use a session ID or route.");
      route = decodeURIComponent(url.pathname);
    }
  } else if (!value.includes("/")) {
    // New sessions live at a random address, so the ID is looked up in the Space's list first.
    const listed = sessions.find((session) => session.sessionId === value || session.path === `sessions/${value}`);
    route = listed?.path || sessionRoute({ id: value });
  }
  const match = String(route).match(/^\/?(sessions\/([a-zA-Z0-9._-]+))(?:\/index\.html|\/)?$/);
  if (!match || [".", ".."].includes(match[2])) throw invalid();
  return match[1];
}

function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

// A session as the list shows it: its row, and the address that opens it.
function sessionLines(session, columns) {
  // Mark, title, access and age share the row; the title gets what the terminal has left, within reason.
  const width = Math.max(20, Math.min(56, (columns || 80) - 30));
  const flat = String(session.title).replace(/\s+/g, " ").trim();
  const title = flat.length > width ? `${flat.slice(0, width - 1)}…` : flat.padEnd(width);
  const access = session.visibility === "public" ? pc.yellow("Public ") : "Private";
  const age = relativeDate(Date.parse(session.updatedAt)) || "";
  return [`${agentMark({ id: session.agent })}  ${title}  ${access}  ${pc.dim(age)}`.trimEnd(), session.url || "No share link: only your team can open it"];
}

function listHeading(title, count) {
  return `${pc.bold(title)} ${pc.dim(`· ${count} session${count === 1 ? "" : "s"}`)}`;
}

/** The `list` output: one row per session with its agent, who can open it and its age, then its link. */
export function formatSessionList({ title, sessions }, { columns } = {}) {
  if (sessions.length === 0) return "No published sessions in this Space.";
  const bar = pc.gray("│");
  const lines = [bar, `${pc.green("◇")}  ${listHeading(title, sessions.length)}`, bar];
  for (const session of sessions) {
    const [row, address] = sessionLines(session, columns);
    lines.push(`${bar}  ${row}`, `${bar}      ${pc.dim(address)}`);
  }
  return lines.join("\n");
}

const ACCESS_LABELS = {
  private: "Private, opens with the link",
  public: "Public, open to everyone",
};

function nothingPublished(prompts) {
  prompts.cancel("Nothing published.");
  return null;
}

export function formatShareLinks(output) {
  const fields = [
    output.title && ["Session", output.title],
    ["Link", output.url || "Published"],
    ACCESS_LABELS[output.visibility] && ["Access", ACCESS_LABELS[output.visibility]],
    (output.spaceTitle || output.spaceId) && ["Space", output.spaceTitle || output.spaceId],
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

async function selectAgentAndSession({ requestedAgent, requestedSession, interactive, limit, web, availableAdapters, prompts, warn }) {
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
  // Every session is in the list, so typing searches all of them and the arrows scroll through all of them.
  const agents = [...new Map(sessions.map((entry) => [entry.adapter.id, entry.adapter])).values()];
  // The real logos where the terminal can draw images; text marks everywhere else.
  const logos = adapter ? null : await drawAgentLogos({ agents: agents.map((agent) => agent.id) });
  const markOf = (agent) => logos?.mark(agent.id) || agentMark(agent);
  const options = sessions.map((entry, index) => ({
    // Numbered from 1: the prompt library ignores an initial value of 0.
    value: index + 1,
    agent: entry.adapter.id,
    // With several agents in one list, each row starts with its agent's mark.
    label: adapter ? entry.session.title : `${markOf(entry.adapter)} ${entry.session.title}`,
    hint: [
      relativeDate(entry.session.updatedAt || entry.session.createdAt),
      shortProject(entry.session.project),
      shortId(entry.session.id),
    ].filter(Boolean).join(" · "),
    search: [entry.session.title, entry.session.project, entry.session.id, entry.adapter.label, entry.adapter.id].filter(Boolean).join(" "),
  }));
  const question = adapter ? `Which ${adapter.label} session?` : "Which session do you want to share?";
  const message = (count) => `${question} (${count} session${count === 1 ? "" : "s"})`;
  let value;
  if (prompts === clack) {
    // In a real terminal the list also takes Tab, to switch which agent's sessions are shown.
    value = await pickSession({
      message,
      options,
      agents: adapter ? [] : agents.map((agent) => ({ id: agent.id, label: agent.label, mark: markOf(agent) })),
      filter: matchesOption,
      maxItems: limit,
      web,
    });
    if (value === OPEN_WEB) return { web: true };
    if (value === null) {
      prompts.cancel("Nothing published.");
      process.exit(0);
    }
  } else {
    value = await prompts.autocomplete({
      message: message(options.length),
      placeholder: "Type to search by title, project, agent, or ID",
      options,
      initialValue: 1,
      filter: matchesOption,
      maxItems: limit,
    });
    cancelIfNeeded(prompts, value);
  }
  return sessions[value - 1];
}

// For terminals that cannot draw the logos, each agent gets the nearest glyph in its brand colour,
// two cells wide: Claude's spark, OpenAI's blossom, Cursor's hexagon, Gemini's star, T3, and Pi's own
// text mark, a coral P and a yellow i.
const AGENT_MARKS = {
  claude: { glyph: "✻", rgb: [217, 119, 87] },
  codex: { glyph: "❋" },
  cursor: { glyph: "⬢" },
  gemini: { glyph: "✦", rgb: [71, 150, 227] },
  pi: { parts: [["P", [228, 138, 122]], ["i", [234, 182, 93]]] },
  t3: { glyph: "T3" },
};

function agentMark(agent) {
  const mark = AGENT_MARKS[agent.id] || { glyph: "•" };
  const colour = (text, rgb) => `\x1b[38;2;${rgb.join(";")}m${text}\x1b[39m`;
  if (mark.parts) return mark.parts.map(([text, rgb]) => (pc.isColorSupported ? colour(text, rgb) : text)).join("");
  const cell = mark.glyph.padEnd(2);
  if (!pc.isColorSupported) return cell;
  return mark.rgb ? `\x1b[38;2;${mark.rgb.join(";")}m${cell}\x1b[39m` : pc.bold(cell);
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

function formatDate(value, now = Date.now()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const days = Math.round((date.getTime() - now) / 86_400_000);
  if (days < 0) return day;
  return `${day} (${days === 0 ? "today" : `in ${days} day${days === 1 ? "" : "s"}`})`;
}

function redactionLine(count, enabled, kinds = {}) {
  if (!enabled) return "Secret masking is off (--no-redact)";
  if (count === 0) return "No secrets found to mask";
  const breakdown = Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([kind, number]) => `${kind}: ${number}`).join(", ");
  return `Masked ${count} secret${count === 1 ? "" : "s"} (${breakdown || "keys, tokens, passwords"}). --no-redact publishes them as written.`;
}

function printHelp() {
  console.log(`push-session ${packageVersion}

Share your AI coding-agent sessions as private Spacefast links.

Usage
  npx push-session                       Pick any session from any agent
  npx push-session <agent>               Pick from one agent
  npx push-session <agent> <session-id>  Share that one, no questions
  npx push-session web                   Pick sessions in a page on this machine
  npx push-session list                  Show what you have published; update, change or delete it
  npx push-session delete <id|route|url>   Delete a published session: its links and its files
  npx push-session unshare <id|route|url>  The same; with --keep-files it only ends the links
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
  Spaces gets your sessions and remembers it. The Space gets a sessions page:
  your team sees every session there, everyone else only the public ones. Signed out: a claimable Space
  that lives on this machine until you claim it.

Options
  --pick-space   Choose your sessions Space again
  --space <id>   Publish to this Space once; your default stays put
  --new-space    Start a fresh "${OWNED_SPACE_TITLE}" Space and make it the default
  --team <slug>  Team for a new Space, if you're in more than one
  --limit <n>    Sessions shown at a time in the picker (default: 12)
  --private      Only your team and people with the share link (the default)
  --public       Anyone can open the session, no link needed
  --no-redact    Publish keys, tokens and passwords as written instead of masking them
  --keep-files   With unshare: end the links and public access, keep the files for your team
  --yes          With delete or unshare: do not ask first
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
