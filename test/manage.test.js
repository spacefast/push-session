import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { formatSessionList, run } from "../src/cli.js";
import { saveConfig } from "../src/config.js";

const API = "https://api.spacefast.com";
const LIVE = "https://sessions.example";
const INDEX_GRANT = ["/", "/index.html", "/sessions", "/sessions/index.html", "/sessions/public.json"];

// A Space with a private session at a random address, a public one, and the sessions page.
function fakeSpace(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "push-session-manage-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { PUSH_SESSION_CONFIG: path.join(root, "config.json"), SPACEFAST_HOME: root };
  saveConfig({ version: 1, owned: { [API]: { id: "spc_one", title: "AI sessions", liveUrl: `${LIVE}/` } } }, env);
  const entry = (sessionPath, sessionId, title, agent, visibility, updatedAt) => ({ path: sessionPath, sessionId, title, agent, visibility, updatedAt });
  const files = new Map([
    ["index.html", '<meta name="generator" content="push-session">'],
    ["sessions/index.json", JSON.stringify({ version: 1, sessions: [
      entry("sessions/aaaa-1111", "session-private", "Fix the importer", "claude", "private", "2026-11-20T10:00:00.000Z"),
      entry("sessions/bbbb-2222", "session-public", "Ship the pager fix", "codex", "public", "2026-11-22T10:00:00.000Z"),
    ] })],
    ["sessions/aaaa-1111/index.html", "private page"],
    ["sessions/aaaa-1111/pages/0001.json", "{}"],
    ["sessions/aaaa-11110/index.html", "another session whose address starts the same"],
    ["sessions/bbbb-2222/index.html", "public page"],
  ]);
  const grant = (id, audience, include, subject = {}) => ({ id, subject: { audience, ...subject }, capabilities: ["page.view"], resources: { include, exclude: [] }, target: { kind: "live" } });
  const access = [
    grant("grt_link", "link", ["/sessions/aaaa-1111", "/sessions/aaaa-1111/**"], { linkId: "lnk_one", landingPath: "/sessions/aaaa-1111", url: `${LIVE}/__/one` }),
    grant("grt_public", "public", ["/sessions/bbbb-2222", "/sessions/bbbb-2222/**"]),
    grant("grt_index", "public", INDEX_GRANT),
    grant("grt_member", "member", ["/**"]),
  ];
  const calls = [];
  const fail = new Set();
  const fetchImpl = async (url, init = {}) => {
    const target = new URL(url);
    const method = init.method || "GET";
    if (target.origin === LIVE) return new Response(files.get(target.pathname.slice("/read/".length)));
    if (target.pathname.endsWith("/files/links")) {
      return jsonResponse(200, { data: { links: Object.fromEntries(target.searchParams.getAll("path").map((file) => [file, { url: `${LIVE}/read/${file}` }])) } });
    }
    if (target.pathname.endsWith("/files")) return jsonResponse(200, { data: { versionId: "ver_1", files: [...files.keys()].map((file) => ({ path: file })) } });
    if (target.pathname.endsWith("/access") && method === "GET") return jsonResponse(200, { data: access });
    if (target.pathname === "/v1/spaces/spc_one" && method === "GET") return jsonResponse(200, { data: { id: "spc_one", title: "Team sessions", liveUrl: `${LIVE}/` } });
    if (fail.has(`${method} ${target.pathname}`)) return jsonResponse(500, { title: "Unavailable" });
    calls.push(`${method} ${target.pathname.replace("/v1/spaces/spc_one", "")}`);
    if (method === "POST" && target.pathname.endsWith("/access")) {
      const body = JSON.parse(init.body);
      const made = grant(`grt_${access.length}`, body.audience, body.resources.include);
      access.push(made);
      return jsonResponse(201, { data: made });
    }
    if (method === "POST" && target.pathname.endsWith("/share-links")) {
      const body = JSON.parse(init.body);
      access.push(grant(`grt_${access.length}`, "link", body.resources.include, { linkId: "lnk_new", landingPath: body.landingPath, url: `${LIVE}/__/new` }));
      return jsonResponse(201, { data: { id: "lnk_new", url: `${LIVE}/__/new` } });
    }
    if (method === "DELETE") {
      const id = target.pathname.split("/").pop();
      const at = access.findIndex((item) => item.id === id || item.subject.linkId === id);
      if (at >= 0) access.splice(at, 1);
      return new Response(null, { status: 204 });
    }
    const payload = JSON.parse(init.body.get("payload"));
    for (const file of payload.deletePaths || []) files.delete(file);
    for (const file of init.body.getAll("files")) files.set(file.name, await file.text());
    return jsonResponse(201, { data: { space: { id: "spc_one" }, next: { action: "done" } } });
  };
  const logged = [];
  const dependencies = { env, fetchImpl, resolveAuth: async () => ({ accessToken: "token", source: "sf" }), log: (line) => logged.push(line), interactive: false, columns: 80, adapters: [] };
  const listed = () => JSON.parse(files.get("sessions/index.json")).sessions.map((session) => [session.path, session.visibility]);
  return { dependencies, env, files, access, calls, fail, logged, listed, grant };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("list shows each session with its agent, who can open it, and the address that opens it", async (context) => {
  const space = fakeSpace(context);
  const result = await run(["list", "--json"], space.dependencies);
  assert.deepEqual(result.sessions.map((session) => [session.sessionId, session.route, session.agent, session.visibility, session.url]), [
    ["session-public", "sessions/bbbb-2222", "codex", "public", `${LIVE}/sessions/bbbb-2222/`],
    ["session-private", "sessions/aaaa-1111", "claude", "private", `${LIVE}/__/one`],
  ]);
  assert.deepEqual(result.sessions[1].shareLinks, [{ id: "lnk_one", url: `${LIVE}/__/one` }]);
  assert.deepEqual(JSON.parse(space.logged[0]), result);
  assert.deepEqual(space.calls, [], "listing changes nothing");

  space.logged.length = 0;
  await run(["list"], space.dependencies);
  const lines = space.logged[0].split("\n");
  assert.match(lines[1], /AI sessions · 2 sessions/);
  assert.match(lines[3], /Ship the pager fix\s+Public/);
  assert.match(lines[4], /https:\/\/sessions\.example\/sessions\/bbbb-2222\/$/);
  assert.match(lines[5], /Fix the importer\s+Private/);
  assert.match(lines[6], /https:\/\/sessions\.example\/__\/one$/);
});

test("the list keeps to the terminal's width and says so when a session has no link or there are none", () => {
  const session = { title: `A very long title ${"that keeps going ".repeat(8)}`, agent: "claude", visibility: "private", url: null, updatedAt: "2026-01-02T00:00:00.000Z" };
  const [, , , row, link] = formatSessionList({ title: "AI sessions", sessions: [session] }, { columns: 60 }).split("\n");
  assert.match(row, /…\s+Private\s+2026-01-02$/);
  assert.ok(row.replace(/\x1b\[[0-9;]*m/g, "").length <= 60, "the row fits 60 columns");
  assert.match(link, /No share link: only your team can open it/);
  assert.equal(formatSessionList({ title: "AI sessions", sessions: [] }), "No published sessions in this Space.");
});

test("unshare finds a session by its ID, ends its link, deletes only its files and takes it off the list", async (context) => {
  const space = fakeSpace(context);
  const result = await run(["unshare", "session-private", "--json"], space.dependencies);
  assert.deepEqual(result, {
    spaceId: "spc_one",
    route: "sessions/aaaa-1111",
    revokedLinkIds: ["lnk_one"],
    revokedPublicAccess: false,
    deletedPaths: ["sessions/aaaa-1111/index.html", "sessions/aaaa-1111/pages/0001.json"],
    keptFiles: false,
    stillPublic: false,
  });
  assert.deepEqual(space.calls, ["DELETE /share-links/lnk_one", "POST /v1/publish"]);
  assert.equal(space.files.has("sessions/aaaa-11110/index.html"), true, "a session whose address only starts the same is left alone");
  assert.deepEqual(space.listed(), [["sessions/bbbb-2222", "public"]]);
  assert.equal(space.access.some((item) => item.id === "grt_index"), true, "the sessions page stays public while a public session is left");

  await assert.rejects(run(["unshare", "session-private", "--json"], space.dependencies), /No published session found at sessions\/session-private/);
});

test("unsharing the last public session ends its public access and closes the sessions page", async (context) => {
  const space = fakeSpace(context);
  const result = await run(["unshare", `${LIVE}/sessions/bbbb-2222/`, "--yes"], space.dependencies);
  assert.equal(result.revokedPublicAccess, true);
  assert.deepEqual(space.calls, ["DELETE /access/grt_public", "DELETE /access/grt_index", "POST /v1/publish"]);
  assert.deepEqual(space.access.map((item) => item.id), ["grt_link", "grt_member"]);
  assert.deepEqual(space.listed(), [["sessions/aaaa-1111", "private"]]);
  assert.equal(JSON.parse(space.files.get("sessions/public.json")).sessions.length, 0);
  assert.match(space.logged[0], /Unshared "Ship the pager fix": ended public access, deleted 1 file\./);
});

test("--keep-files makes a public session private and keeps it on the list", async (context) => {
  const space = fakeSpace(context);
  const result = await run(["unshare", "sessions/bbbb-2222", "--keep-files", "--json"], space.dependencies);
  assert.deepEqual([result.revokedPublicAccess, result.deletedPaths, result.keptFiles], [true, [], true]);
  assert.equal(space.files.has("sessions/bbbb-2222/index.html"), true);
  assert.deepEqual(space.listed(), [["sessions/bbbb-2222", "private"], ["sessions/aaaa-1111", "private"]]);
});

test("a public Space keeps kept files open and says so, and a Space named with --space is read for its address", async (context) => {
  const space = fakeSpace(context);
  space.access.push(space.grant("grt_all", "public", ["/**"]));
  const listed = await run(["list", "--json"], space.dependencies);
  assert.deepEqual(listed.sessions.map((session) => session.visibility), ["public", "public"], "a session in a public Space is public whatever its own grants say");

  const result = await run(["unshare", "session-private", "--keep-files", "--yes"], space.dependencies);
  assert.equal(result.stillPublic, true);
  assert.match(space.logged.at(-1), /still open to everyone, because the Space itself is public/);
  assert.equal(space.access.some((item) => item.id === "grt_all"), true, "the Space's own access is not this command's to end");
  assert.deepEqual(space.listed().find(([file]) => file === "sessions/aaaa-1111"), ["sessions/aaaa-1111", "public"]);

  // Not the remembered Space: nothing saved says where it is served.
  saveConfig({ version: 1 }, space.env);
  const named = await run(["list", "--space", "spc_one", "--json"], space.dependencies);
  assert.equal(named.sessions[0].url, `${LIVE}/sessions/bbbb-2222/`);
  await run(["list", "--space", "spc_one"], space.dependencies);
  assert.match(space.logged.at(-1).split("\n")[1], /Team sessions/);
});

test("a failed unshare names the session's route to finish with, since an ended link no longer leads to it", async (context) => {
  const space = fakeSpace(context);
  space.fail.add("POST /v1/publish");
  await assert.rejects(run(["unshare", `${LIVE}/__/one`, "--json"], space.dependencies), /ending 1 of 1 links; file removal is not confirmed\. Run `push-session unshare sessions\/aaaa-1111` to finish\./);
  await assert.rejects(run(["unshare", "sessions/bbbb-2222", "--space", "spc_one", "--keep-files", "--json"], space.dependencies), /Run `push-session unshare sessions\/bbbb-2222 --space spc_one --keep-files` to finish\./);
  space.fail.clear();
  const finished = await run(["unshare", "sessions/aaaa-1111", "--json"], space.dependencies);
  assert.deepEqual([finished.revokedLinkIds, finished.deletedPaths.length], [[], 2]);
});

test("a signed-out Space is managed with its own credential, and says it must be claimed when it has none", async (context) => {
  const space = fakeSpace(context);
  const tokens = [];
  const fetchImpl = (url, init = {}) => {
    tokens.push(init.headers?.authorization);
    if (init.headers?.authorization === "Bearer claim-key") return jsonResponse(403, { title: "Claim this space into a managed principal before using this endpoint." });
    return space.dependencies.fetchImpl(url, init);
  };
  // Signed in, but the only Space this machine remembers was made signed out.
  saveConfig({ version: 1, space: { id: "spc_one", liveUrl: `${LIVE}/`, accessToken: "space-key" } }, space.env);
  const listed = await run(["list", "--json"], { ...space.dependencies, fetchImpl });
  assert.equal(listed.sessions.length, 2);
  assert.equal(tokens.filter(Boolean).every((token) => token === "Bearer space-key"), true, "the Space's own credential is used, not the account's");

  saveConfig({ version: 1, space: { id: "spc_one", claimToken: "claim-key", claimUrl: "https://claim.example/one" } }, space.env);
  await assert.rejects(run(["list"], { ...space.dependencies, fetchImpl, resolveAuth: async () => null }), /has not been claimed, so its sessions cannot be managed yet\. Claim it at https:\/\/claim\.example\/one/);
});

test("unshare asks first in a terminal, and both commands refuse what they cannot honour", async (context) => {
  const space = fakeSpace(context);
  const asked = [];
  const prompts = { confirm: async (question) => { asked.push(question.message); return false; }, isCancel: () => false };
  assert.deepEqual(await run(["unshare", "session-private"], { ...space.dependencies, interactive: true, prompts }), { cancelled: true });
  assert.deepEqual(asked, ['Unshare "Fix the importer"? This ends 1 share link and deletes 2 files.']);
  assert.deepEqual(space.calls, [], "declining changes nothing");

  await assert.rejects(run(["unshare", "session-private"], space.dependencies), /requires --yes or --json/);
  await assert.rejects(run(["unshare"], space.dependencies), /Usage: push-session unshare/);
  await assert.rejects(run(["unshare", "https://elsewhere.example/sessions/aaaa-1111/", "--json"], space.dependencies), /does not belong to the selected Space/);
  await assert.rejects(run(["unshare", "../index.html", "--json"], space.dependencies), /Expected a session ID/);
  await assert.rejects(run(["list", "extra"], space.dependencies), /Usage: push-session list/);
  await assert.rejects(run(["list", "--new-space"], space.dependencies), /use an existing Space/);
  await assert.rejects(run(["codex", "session-one", "--keep-files"], space.dependencies), /only supported by unshare/);
  const signedOut = { ...space.dependencies, resolveAuth: async () => null };
  await assert.rejects(run(["list"], signedOut), /No remembered session Space/);
  await assert.rejects(run(["list", "--space", "spc_one"], signedOut), /Sign in with `sf login`/);
});

const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, "");

// Answers each question in turn and records what was asked and offered.
function scripted(answers) {
  const asked = [];
  const next = async (question) => {
    asked.push({ message: question.message, options: question.options?.map((option) => option.label) });
    return answers.shift();
  };
  return { asked, prompts: { select: next, confirm: next, isCancel: () => false } };
}

test("delete is unshare under a plainer name, and never keeps the files", async (context) => {
  const space = fakeSpace(context);
  const result = await run(["delete", "session-private", "--yes"], space.dependencies);
  assert.deepEqual(result.deletedPaths, ["sessions/aaaa-1111/index.html", "sessions/aaaa-1111/pages/0001.json"]);
  assert.deepEqual(result.revokedLinkIds, ["lnk_one"]);
  assert.equal(space.logged.at(-1), 'Deleted "Fix the importer": ended 1 share link, deleted 2 files.');
  assert.deepEqual(space.listed(), [["sessions/bbbb-2222", "public"]]);

  const { asked, prompts } = scripted([false]);
  assert.deepEqual(await run(["delete", "session-public"], { ...space.dependencies, interactive: true, prompts }), { cancelled: true });
  assert.equal(asked[0].message, 'Delete "Ship the pager fix"? This ends public access and deletes 1 file.');
  assert.equal(space.logged.at(-1), "Nothing deleted.");

  await assert.rejects(run(["delete", "session-public", "--keep-files"], space.dependencies), /unshare <session> --keep-files/);
  await assert.rejects(run(["delete", "session-public"], space.dependencies), /Deleting without a terminal requires --yes or --json/);
  await assert.rejects(run(["delete"], space.dependencies), /Usage: push-session delete <session-id\|route\|url> \[--yes\]$/);
});

// A terminal where the list's keys are pressed in turn, then left. Records what each list offered.
function keyed(space, presses, answers = []) {
  const lists = [];
  const pickPublished = async (list) => {
    lists.push(list.options.map((option) => [option.name, option.actions.map((item) => `${item.key}: ${item.label}`).join(", ")]));
    const [action, value] = presses.shift() || [];
    return action ? { action, value } : null;
  };
  const { asked, prompts } = scripted(answers);
  return { lists, asked, dependencies: { ...space.dependencies, interactive: true, pickPublished, prompts } };
}

test("in a terminal, c on a session changes who can open it and shows the address that now opens it", async (context) => {
  const space = fakeSpace(context);
  const terminal = keyed(space, [["c", "sessions/aaaa-1111"], ["c", "sessions/bbbb-2222"]]);
  const result = await run(["list"], terminal.dependencies);

  assert.deepEqual(terminal.lists[0], [["Ship the pager fix", "enter: open, c: make private, d: delete"], ["Fix the importer", "enter: open, c: make public, d: delete"]]);
  assert.deepEqual(terminal.lists[2], [["Ship the pager fix", "enter: open, c: make public, d: delete"], ["Fix the importer", "enter: open, c: make private, d: delete"]]);
  assert.deepEqual(space.logged.map(plain), [
    '"Fix the importer" is now public',
    `│  ${LIVE}/sessions/aaaa-1111/`,
    '"Ship the pager fix" is now private',
    `│  ${LIVE}/__/new`,
  ]);
  assert.deepEqual(result.sessions.map((session) => [session.route, session.visibility, session.url]), [
    ["sessions/bbbb-2222", "private", `${LIVE}/__/new`],
    ["sessions/aaaa-1111", "public", `${LIVE}/sessions/aaaa-1111/`],
  ]);
  assert.deepEqual(space.listed(), [["sessions/bbbb-2222", "private"], ["sessions/aaaa-1111", "public"]]);
  assert.deepEqual(JSON.parse(space.files.get("sessions/public.json")).sessions.map((session) => session.path), ["sessions/aaaa-1111"]);
  assert.ok(space.access.some((item) => item.id === "grt_index"), "the sessions page stays open while a session is public");
  assert.ok(!space.access.some((item) => item.id === "grt_public"), "the session's own public access is ended");

  // The last public session going private closes the sessions page too.
  await run(["list"], keyed(space, [["c", "sessions/aaaa-1111"]]).dependencies);
  assert.ok(!space.access.some((item) => item.subject.audience === "public"), "nothing is public any more");
  assert.equal(plain(space.logged.at(-1)), `│  ${LIVE}/__/one`, "its old link still opens it");
});

test("in a terminal, d deletes a session after asking, and leaving the list changes nothing", async (context) => {
  const space = fakeSpace(context);
  // Decline once, then delete.
  const terminal = keyed(space, [["d", "sessions/aaaa-1111"], ["d", "sessions/aaaa-1111"]], [false, true]);
  const result = await run(["list"], terminal.dependencies);
  assert.equal(terminal.asked[0].message, 'Delete "Fix the importer"? This ends 1 share link and deletes 2 files.');
  assert.deepEqual(result.sessions.map((session) => session.route), ["sessions/bbbb-2222"]);
  assert.ok(!space.files.has("sessions/aaaa-1111/index.html"));
  assert.ok(space.files.has("sessions/aaaa-11110/index.html"), "a session whose address starts the same is untouched");
  assert.deepEqual(terminal.lists.at(-1), [["Ship the pager fix", "enter: open, c: make private, d: delete"]]);

  space.calls.length = 0;
  space.logged.length = 0;
  await run(["list"], keyed(space, []).dependencies);
  assert.deepEqual(space.logged, [], "the list on screen is the one that was picked from");
  const opened = [];
  await run(["list"], { ...keyed(space, [["enter", "sessions/bbbb-2222"]]).dependencies, openBrowser: (url) => opened.push(url) });
  assert.deepEqual(opened, [`${LIVE}/sessions/bbbb-2222/`], "Enter opens the address that opens the session");
  await run(["list", "--json"], { ...space.dependencies, interactive: true, pickPublished: () => assert.fail("--json never asks") });
  assert.deepEqual(space.calls, [], "looking changes nothing");
});

test("in a terminal, u publishes a session again from this machine, to the address and access it has", async (context) => {
  const space = fakeSpace(context);
  const session = { agent: "claude", agentLabel: "Claude Code", id: "session-private", title: "Fix the importer, again" };
  const claude = { id: "claude", label: "Claude Code", aliases: [], installed: () => true, discover: () => [session], load: () => [{ role: "assistant", content: "Done" }] };
  const dependencies = { ...space.dependencies, adapters: [claude], discoverSessionArtifacts: async () => [] };
  const terminal = keyed({ dependencies }, [["u", "sessions/aaaa-1111"]]);
  await run(["list"], terminal.dependencies);

  assert.deepEqual(terminal.lists[0], [["Ship the pager fix", "enter: open, c: make private, d: delete"], ["Fix the importer", "enter: open, c: make public, u: update, d: delete"]], "only a session whose agent is here can be updated");
  assert.deepEqual(space.logged.map(plain), ['Updated "Fix the importer, again"', `│  ${LIVE}/__/one`]);
  assert.notEqual(space.files.get("sessions/aaaa-1111/index.html"), "private page", "its page is written again at the same address");
  assert.deepEqual(space.listed(), [["sessions/aaaa-1111", "private"], ["sessions/bbbb-2222", "public"]], "it is the newest on the list now");
  assert.ok(space.access.some((item) => item.id === "grt_link"), "its link is kept");

  // A session that is no longer on this machine says so, and the list goes on.
  claude.discover = () => [];
  space.logged.length = 0;
  await run(["list"], keyed({ dependencies }, [["u", "sessions/aaaa-1111"]]).dependencies);
  assert.match(space.logged[0], /^Could not update "Fix the importer, again": No Claude Code sessions here yet\./);
});

test("the list offers a change of access only where it would do something", async (context) => {
  // In a Space that is itself public, a session cannot be made private from here.
  const space = fakeSpace(context);
  space.access.push(space.grant("grt_space", "public", ["/**"]));
  const open = keyed(space, []);
  await run(["list"], open.dependencies);
  assert.deepEqual(open.lists[0].map(([, keys]) => keys), ["enter: open, d: delete", "enter: open, d: delete"]);

  // A signed-out Space has no public sessions, and a publish to it would not land on a session
  // that lives at another address than its own.
  const signedOut = fakeSpace(context);
  saveConfig({ version: 1, space: { id: "spc_one", accessToken: "space-credential", liveUrl: `${LIVE}/` } }, signedOut.env);
  const anonymous = keyed(signedOut, []);
  const installed = ["claude", "codex"].map((id) => ({ id, aliases: [], installed: () => true }));
  await run(["list"], { ...anonymous.dependencies, adapters: installed, resolveAuth: async () => null });
  assert.deepEqual(anonymous.lists[0].map(([, keys]) => keys), ["enter: open, d: delete", "enter: open, d: delete"]);
});

test("a change of access goes by what is open now, not by what the list last recorded", async (context) => {
  const space = fakeSpace(context);
  // The recorded list calls the public session private, and its grant names its folder the other way round.
  const recorded = JSON.parse(space.files.get("sessions/index.json"));
  recorded.sessions[1].visibility = "private";
  space.files.set("sessions/index.json", JSON.stringify(recorded));
  space.access.find((item) => item.id === "grt_public").resources.include.reverse();

  await run(["list"], keyed(space, [["c", "sessions/aaaa-1111"], ["c", "sessions/aaaa-1111"]]).dependencies);
  assert.ok(space.access.some((item) => item.id === "grt_index"), "the sessions page stays open for the session that is still public");
  assert.deepEqual(space.listed(), [["sessions/bbbb-2222", "public"], ["sessions/aaaa-1111", "private"]]);

  await run(["list"], keyed(space, [["c", "sessions/bbbb-2222"]]).dependencies);
  assert.ok(!space.access.some((item) => item.subject.audience === "public"), "its public access ends in whatever shape it was granted");
});
