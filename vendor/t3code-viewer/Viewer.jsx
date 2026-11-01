import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import "./viewer.css";
import "./pagination.css";
import "./artifact-links.css";
import { AssistantTimelineRow, UserTimelineRow, WorkGroupSection } from "./t3/MessagesTimeline.jsx";

function readPayload() {
  const node = document.getElementById("push-session-data");
  if (!node?.textContent) throw new Error("Missing session data.");
  return JSON.parse(node.textContent);
}

function Timeline({ messages, loading }) {
  const rows = useMemo(() => buildRows(messages), [messages]);
  if (rows.length === 0) {
    return (
      <main className="timeline">
        <div className="empty">{loading ? "Loading the session…" : "Nothing to show. This session has no messages."}</div>
      </main>
    );
  }
  return (
    <main className="timeline">
      {rows.map((row) =>
        row.kind === "tools" ? (
          <WorkGroupSection key={row.id} entries={row.entries} />
        ) : row.message.itemType === "user_message" ? (
          <UserTimelineRow key={row.id} message={row.message} groupedWithNext={row.groupedWithNext} />
        ) : (
          <AssistantTimelineRow key={row.id} message={row.message} showMeta={row.showMeta} />
        ),
      )}
    </main>
  );
}

function ArtifactShelf({ artifacts }) {
  if (!artifacts?.length) return null;
  return (
    <section className="artifact-shelf" aria-label="Outputs">
      <div className="artifact-shelf-title">Outputs</div>
      <div className="artifact-cards">
        {artifacts.map((artifact) => (
          <a className="artifact-card" href={artifact.href} target="_blank" rel="noreferrer" key={artifact.id}>
            <span className="artifact-icon">{artifact.favicon || "◇"}</span>
            <span className="artifact-card-copy">
              <strong>{artifact.title || (artifact.kind === "chatgpt-site" ? "ChatGPT Site" : "Claude artifact")}</strong>
              <small>{artifact.kind === "chatgpt-site"
                ? `${plural(artifact.publishes, "saved version")} · ${artifact.recoveredVersions} recovered`
                : plural(artifact.recoveredVersions, "version")}</small>
            </span>
            <span className="artifact-arrow" aria-hidden="true">↗</span>
          </a>
        ))}
      </div>
    </section>
  );
}

function SessionHeader({ session, stats, artifacts }) {
  return (
    <header className="session-header">
      <div className="topline">
        <div className="provider">{session.providerLabel}</div>
        <ThemeToggle />
      </div>
      <h1>{session.title || `${session.providerLabel} session`}</h1>
      <div className="session-meta">
        {session.project ? <span title={session.project}><Icon name="folder" />{shortProject(session.project)}</span> : null}
        {session.createdAt ? <span><Icon name="calendar" /><time dateTime={session.createdAt}>{longTimestamp(session.createdAt)}</time></span> : null}
        <span><Icon name="message" />{plural(stats.messages, "message")}</span>
        {stats.tools ? <span><Icon name="terminal" />{plural(stats.tools, "tool call")}</span> : null}
        {stats.artifacts ? <span><Icon name="file" />{plural(stats.artifacts, "output")}</span> : null}
      </div>
      <ArtifactShelf artifacts={artifacts} />
    </header>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(
    () =>
      document.documentElement.classList.contains("dark") ||
      (!document.documentElement.classList.contains("light") &&
        window.matchMedia("(prefers-color-scheme: dark)").matches),
  );
  return (
    <button
      className="theme-toggle"
      type="button"
      aria-label={`Use ${dark ? "light" : "dark"} theme`}
      onClick={() => {
        const next = !dark;
        document.documentElement.classList.toggle("dark", next);
        document.documentElement.classList.toggle("light", !next);
        setDark(next);
      }}
    >
      <Icon name={dark ? "sun" : "moon"} />
    </button>
  );
}

function Icon({ name, className = "" }) {
  const paths = {
    calendar: <Fragment><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></Fragment>,
    check: <path d="m5 12 4 4L19 6"/>,
    chevron: <path d="m6 9 6 6 6-6"/>,
    copy: <Fragment><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></Fragment>,
    eye: <Fragment><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12"/><circle cx="12" cy="12" r="3"/></Fragment>,
    file: <Fragment><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></Fragment>,
    folder: <path d="M3 6.5h6l2 2h10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>,
    globe: <Fragment><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14 0 18M12 3c-3 3.5-3 14 0 18"/></Fragment>,
    hash: <Fragment><path d="M10 3 8 21M16 3l-2 18M4 9h16M3 15h16"/></Fragment>,
    info: <Fragment><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></Fragment>,
    message: <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/>,
    moon: <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>,
    search: <Fragment><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></Fragment>,
    sun: <Fragment><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></Fragment>,
    terminal: <Fragment><path d="m4 6 5 5-5 5M12 18h8"/></Fragment>,
    tool: <Fragment><path d="M14.7 6.3a4 4 0 0 0-5-5L12 3.6 9.6 6 7.3 3.7a4 4 0 0 0 5 5L5 16l3 3 7.3-7.3a4 4 0 0 0 5-5L18 9l-2.4-2.4 2.3-2.3a4 4 0 0 0-3.2 2"/></Fragment>,
    x: <Fragment><path d="m6 6 12 12M18 6 6 18"/></Fragment>,
  };
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.tool}</svg>;
}

// MessagesTimeline.logic: tool calls between messages fold into one work
// group, back-to-back user messages stack as one burst, and an assistant reply
// split around tool work shows its copy/model/time row once, on the last part.
function buildRows(messages) {
  const rows = [];
  let tools = [];
  const flush = () => {
    if (tools.length > 0) rows.push({ kind: "tools", id: `tools:${rows.length}:${tools[0].itemId || ""}`, entries: tools });
    tools = [];
  };
  for (const message of mergeWireFragments(messages)) {
    if (isToolItem(message)) tools.push(message);
    else {
      flush();
      rows.push({ kind: "message", id: message.itemId || `message:${rows.length}`, message });
    }
  }
  flush();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.kind !== "message") continue;
    const next = rows[index + 1];
    if (row.message.itemType === "user_message") {
      row.groupedWithNext = next?.kind === "message" && next.message.itemType === "user_message";
      continue;
    }
    const nextUser = rows.slice(index + 1).find((candidate) => candidate.kind === "message");
    row.showMeta = !nextUser || nextUser.message.itemType === "user_message";
  }
  return rows;
}

function mergeWireFragments(messages) {
  const merged = [];
  for (const message of messages) {
    const fragment = message.data?.wireFragment;
    if (!fragment) {
      merged.push(message);
      continue;
    }
    const data = { ...(message.data || {}) };
    delete data.wireFragment;
    const previous = merged.at(-1);
    if (fragment.index > 1 && previous?.itemId === fragment.sourceItemId) {
      previous.detail = `${previous.detail || ""}${message.detail || ""}`;
      continue;
    }
    merged.push({ ...message, itemId: fragment.sourceItemId, data });
  }
  return merged;
}

function plural(count, noun) {
  const value = Number(count) || 0;
  return `${value.toLocaleString()} ${noun}${value === 1 ? "" : "s"}`;
}

function shortProject(value) {
  const normalized = String(value).replaceAll("\\", "/").replace(/\/$/, "");
  const home = /^(\/(?:home|Users)\/[^/]+)(\/|$)/.exec(normalized);
  const display = home ? `~${normalized.slice(home[1].length)}` : normalized;
  if (display.length <= 52) return display;
  return `…/${display.split("/").filter(Boolean).slice(-3).join("/")}`;
}

function longTimestamp(value) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function isToolItem(item) {
  return !["user_message", "assistant_message", "reasoning", "plan", "error", "unknown"].includes(item.itemType);
}

function pageFromUrl(total) {
  const value = new URL(window.location.href).searchParams.get("page") || "1";
  const page = /^\d+$/.test(value) ? Number(value) : 1;
  return Math.max(1, Math.min(total || 1, Number.isSafeInteger(page) ? page : 1));
}

function useWirePage(pageUrls) {
  const [page, setPage] = useState(() => pageFromUrl(pageUrls.length));
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({ page: 0, items: [], loading: true, error: null });

  useEffect(() => {
    const onPopState = () => setPage(pageFromUrl(pageUrls.length));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [pageUrls.length]);

  useEffect(() => {
    const controller = new AbortController();
    setState({ page, items: [], loading: true, error: null });
    async function load() {
      try {
        const url = pageUrls[page - 1];
        if (!url) {
          setState({ page, items: [], loading: false, error: null });
          return;
        }
        const response = await fetch(url, { headers: { accept: "application/json" }, signal: controller.signal });
        if (!response.ok) throw new Error(`Could not load transcript page ${page} (${response.status}).`);
        const data = await response.json();
        if (data.protocol !== "t3code.provider-runtime/v2" || data.page !== page || !Array.isArray(data.events)) {
          throw new Error(`Transcript page ${page} is unreadable.`);
        }
        const items = data.events
          .filter((event) => event?.type === "item.completed" && event.payload)
          .map((event) => ({ ...event.payload, itemId: event.itemId, createdAt: event.createdAt }));
        if (!controller.signal.aborted) setState({ page, items, loading: false, error: null });
      } catch (cause) {
        if (!controller.signal.aborted) setState({ page, items: [], loading: false, error: cause instanceof Error ? cause.message : String(cause) });
      }
    }
    void load();
    return () => controller.abort();
  }, [page, pageUrls, attempt]);

  const navigate = useCallback((value) => {
    const next = Math.max(1, Math.min(pageUrls.length || 1, value));
    if (next === page) return;
    const url = new URL(window.location.href);
    if (next === 1) url.searchParams.delete("page");
    else url.searchParams.set("page", String(next));
    window.history.pushState(null, "", url);
    setPage(next);
  }, [page, pageUrls.length]);
  const current = state.page === page ? state : { items: [], loading: true, error: null };
  return { ...current, page, navigate, retry: () => setAttempt((value) => value + 1) };
}

function PageNavigation({ page, total, navigate }) {
  if (total < 2) return null;
  return (
    <nav className="page-navigation" aria-label="Transcript pages">
      <button type="button" disabled={page === 1} onClick={() => navigate(page - 1)}>← Previous</button>
      <form onSubmit={(event) => {
        event.preventDefault();
        const value = Number(new FormData(event.currentTarget).get("page"));
        if (Number.isInteger(value)) navigate(value);
      }}>
        <label>Page <input key={page} name="page" type="number" min="1" max={total} defaultValue={page} aria-label="Page number" /> of {total}</label>
        <button type="submit">Go</button>
      </form>
      <button type="button" disabled={page === total} onClick={() => navigate(page + 1)}>Next →</button>
    </nav>
  );
}

function App() {
  const payload = useMemo(readPayload, []);
  const pages = useMemo(() => payload.pages || [], [payload.pages]);
  const { items, loading, error, retry, page, navigate } = useWirePage(pages);
  const navigation = { page, total: pages.length, navigate };
  const fragmented = items.some((item) => item.data?.wireFragment);
  return (
    <div className="app-shell">
      <SessionHeader session={payload.session} stats={payload.stats} artifacts={payload.artifacts} />
      <PageNavigation {...navigation} />
      {error ? <div className="page-status error" role="alert"><span>{error}</span><button type="button" onClick={retry}>Try again</button></div> : null}
      {fragmented ? <p className="page-status">Long messages and tool output may continue on adjacent pages.</p> : null}
      {!error ? <div aria-busy={loading}><Timeline key={page} messages={items} loading={loading} /></div> : null}
      {loading ? <div className="page-status" role="status">Loading page {page}…</div> : null}
      <PageNavigation {...navigation} />
      <footer className="site-footer">
        Shared with <a href="https://github.com/spacefast/push-session" target="_blank" rel="noreferrer">push-session</a>
      </footer>
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
