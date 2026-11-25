import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";

import { adapters, scanAgents } from "./agents/index.js";
import { byRecent } from "./agents/common.js";
import { parseArgs } from "./args.js";
import { resolveAuth } from "./auth.js";
import { loadConfig, ownedSpaceFor, resolveApiUrl } from "./config.js";
import { renderWebPage } from "./web-page.js";

/**
 * `push-session web`: a page on this machine for choosing which sessions to publish.
 *
 * The server can publish the user's sessions, so it answers only on the loopback address, only to
 * requests that carry the token from its own URL, and only when the Host header is its own: another
 * site open in the browser can then neither read the list nor trigger a publish.
 */
export async function runWeb(argv, { publish, dependencies = {} }) {
  const { port, open, forwarded } = parseWebArgs(argv);
  const env = dependencies.env || process.env;
  const available = dependencies.adapters || adapters;
  const log = dependencies.log || console.log;
  const token = randomBytes(24).toString("base64url");
  const page = renderWebPage();

  const listSessions = () => scanAgents(available, { limit: Infinity })
    .flatMap((entry) => entry.sessions.map((session) => ({
      key: `${entry.adapter.id}:${session.id}`,
      agent: entry.adapter.id,
      agentLabel: entry.adapter.label,
      id: session.id,
      title: session.title,
      project: session.project || null,
      updatedAt: session.updatedAt || session.createdAt || null,
    })))
    .sort(byRecent);

  const status = async () => {
    const options = parseArgs(forwarded, env).options;
    let config = { version: 1 };
    try { config = loadConfig(env); } catch { /* an unreadable config is reported by the publish itself */ }
    const apiUrl = resolveApiUrl(config, options);
    const auth = await (dependencies.resolveAuth || resolveAuth)({ env, apiUrl, keyring: dependencies.keyring });
    return { signedIn: Boolean(auth), space: auth ? ownedSpaceFor(config, apiUrl)?.title || null : null };
  };

  // Publishes run one after another: each reads and rewrites the Space's session list.
  let queue = Promise.resolve();
  const publishSession = ({ key, visibility }) => {
    const separator = String(key).indexOf(":");
    const agent = String(key).slice(0, separator);
    const sessionId = String(key).slice(separator + 1);
    if (separator < 1 || !sessionId || !["public", "private"].includes(visibility)) {
      return Promise.resolve({ ok: false, error: "That request was not understood." });
    }
    const next = queue.then(async () => {
      try {
        const output = await publish([agent, sessionId, "--json", `--${visibility}`, ...forwarded]);
        return { ok: true, url: output.url, visibility: output.visibility, spaceTitle: output.spaceTitle, redacted: output.redacted };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
    queue = next.catch(() => {});
    return next;
  };

  const server = http.createServer(async (request, response) => {
    const send = (code, body, type = "application/json; charset=utf-8") => {
      response.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
      response.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    try {
      const { port: boundPort } = server.address();
      if (![`127.0.0.1:${boundPort}`, `localhost:${boundPort}`].includes(request.headers.host)) return send(403, { error: "Forbidden." });
      const url = new URL(request.url, `http://${request.headers.host}`);
      const given = url.pathname === "/" ? url.searchParams.get("t") : request.headers["x-push-session-token"];
      if (!sameToken(given, token)) return send(403, { error: "Open the address push-session web printed; this one is missing its token." });

      if (request.method === "GET" && url.pathname === "/") return send(200, page, "text/html; charset=utf-8");
      if (request.method === "GET" && url.pathname === "/api/sessions") return send(200, { sessions: listSessions() });
      if (request.method === "GET" && url.pathname === "/api/status") return send(200, await status());
      if (request.method === "POST" && url.pathname === "/api/publish") {
        if (!String(request.headers["content-type"]).startsWith("application/json")) return send(415, { ok: false, error: "Send JSON." });
        let body = "";
        for await (const chunk of request) {
          body += chunk;
          if (body.length > 10_000) return send(413, { ok: false, error: "Too large." });
        }
        return send(200, await publishSession(JSON.parse(body)));
      }
      return send(404, { error: "Not found." });
    } catch (error) {
      return send(500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = `http://127.0.0.1:${server.address().port}/?t=${token}`;
  log(`push-session web is running at ${address}\nIt answers only on this machine. Press Ctrl-C to stop.`);
  if (open) (dependencies.openBrowser || openBrowser)(address);
  return { url: address, close: () => new Promise((resolve) => server.close(resolve)) };
}

function parseWebArgs(argv) {
  let port = 0;
  let open = true;
  const forwarded = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--no-open") open = false;
    else if (value === "--port" || value.startsWith("--port=")) {
      const text = value === "--port" ? argv[index += 1] : value.slice("--port=".length);
      port = Number(text);
      if (!/^\d+$/.test(text || "") || port > 65_535) throw new Error("--port must be a number from 0 to 65535.");
    } else forwarded.push(value);
  }
  // The rest are the usual publishing options (--team, --space, --no-redact, ...), checked now, not on the first publish.
  const parsed = parseArgs(forwarded, {});
  const { options } = parsed;
  // Each publish from the page runs without a terminal, so options that ask a question, make a new
  // Space every time, or publish nothing have no meaning here.
  if (parsed.agent || options.json || options.dryRun || options.visibility || options.newSpace || options.pickSpace) {
    throw new Error("push-session web takes publishing options such as --team, --space and --no-redact; sessions and who can open them are chosen in the page.");
  }
  return { port, open, forwarded };
}

function sameToken(given, token) {
  const left = Buffer.from(String(given || ""));
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The command that opens a web address, or null for anything that is not one. No shell runs it:
 * part of a session's address comes from the Space's files, and `cmd` would read an `&` in it as
 * the start of another command.
 */
export function browserCommand(address, platform = process.platform) {
  const url = URL.canParse(address) ? new URL(address) : null;
  if (!url || !["http:", "https:"].includes(url.protocol)) return null;
  return platform === "darwin" ? ["open", [url.href]]
    : platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url.href]]
      : ["xdg-open", [url.href]];
}

export function openBrowser(address) {
  const launch = browserCommand(address);
  if (!launch) return;
  try {
    spawn(launch[0], launch[1], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // The address is printed either way.
  }
}
