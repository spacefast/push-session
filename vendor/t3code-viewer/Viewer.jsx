import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import "./viewer.css";
import "./pagination.css";
import { AssistantTimelineRow, UserTimelineRow, WorkGroupSection } from "./t3/MessagesTimeline.jsx";

function readPayload() {
  const node = document.getElementById("push-session-data");
  if (!node?.textContent) throw new Error("Missing session data.");
  return JSON.parse(node.textContent);
}

function Timeline({ messages }) {
  const rows = useMemo(() => groupTools(messages), [messages]);
  return (
    <main className="timeline">
      {rows.length === 0 ? <div className="empty">This session has no shareable messages.</div> : null}
      {rows.map((row) =>
        row.kind === "tools" ? (
          <WorkGroupSection key={row.id} entries={row.entries} />
        ) : row.message.itemType === "user_message" ? (
          <UserTimelineRow key={row.id} message={row.message} />
        ) : (
          <AssistantTimelineRow key={row.id} message={row.message} />
        ),
      )}
    </main>
  );
}

function SessionHeader({ session, stats }) {
  return (
    <header className="session-header">
      <div className="topline">
        <div className="provider"><span className="provider-dot" />{session.providerLabel}</div>
        <ThemeToggle />
      </div>
      <h1>{session.title || `${session.providerLabel} session`}</h1>
      <div className="session-meta">
        {session.project ? <span><Icon name="folder" />{session.project}</span> : null}
        {session.createdAt ? <span><Icon name="calendar" />{longTimestamp(session.createdAt)}</span> : null}
        <span><Icon name="message" />{stats.messages} messages</span>
        <span><Icon name="terminal" />{stats.tools} tool calls</span>
        <span title={session.threadId}><Icon name="hash" />{shortId(session.threadId)}</span>
      </div>
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

function groupTools(messages) {
  const rows = [];
  let tools = [];
  const flush = () => {
    if (tools.length > 0) rows.push({ kind: "tools", id: `tools:${rows.length}`, entries: tools });
    tools = [];
  };
  for (const message of mergeWireFragments(messages)) {
    if (isToolItem(message)) tools.push(message);
    else {
      flush();
      rows.push({ kind: "message", id: message.id || `message:${rows.length}`, message });
    }
  }
  flush();
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

function shortId(value) {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

function longTimestamp(value) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function isToolItem(item) {
  return !["user_message", "assistant_message", "reasoning", "plan", "error", "unknown"].includes(item.itemType);
}

function useWirePages(pageUrls) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [loadedPages, setLoadedPages] = useState(0);
  const nextPageRef = useRef(0);
  const loadingRef = useRef(false);

  const loadNext = useCallback(async () => {
    const index = nextPageRef.current;
    if (loadingRef.current || index >= pageUrls.length) return;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(pageUrls[index], { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`Could not load transcript page ${index + 1} (${response.status}).`);
      const page = await response.json();
      if (page.protocol !== "t3code.provider-runtime/v2" || !Array.isArray(page.events)) {
        throw new Error(`Transcript page ${index + 1} is not valid T3 wire data.`);
      }
      const completedItems = page.events
        .filter((event) => event?.type === "item.completed" && event.payload)
        .map((event) => ({ ...event.payload, itemId: event.itemId, createdAt: event.createdAt }));
      setItems((current) => [...current, ...completedItems]);
      nextPageRef.current = index + 1;
      setLoadedPages(index + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [pageUrls]);

  useEffect(() => { void loadNext(); }, [loadNext]);
  return { items, loading, error, loadNext, loadedPages, hasMore: loadedPages < pageUrls.length };
}

function PageSentinel({ loading, error, hasMore, loadNext, loadedPages }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!hasMore || error || !ref.current) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadNext();
    }, { rootMargin: "800px 0px" });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [error, hasMore, loadNext, loadedPages]);

  if (error) {
    return <div className="page-status error"><span>{error}</span><button type="button" onClick={loadNext}>Retry</button></div>;
  }
  if (!hasMore && !loading) return null;
  return <div ref={ref} className="page-status" aria-live="polite">{loading ? "Loading more of the session…" : "Continue scrolling"}</div>;
}

function ProvenanceBubble() {
  return (
    <aside className="provenance-bubble">
      <Icon name="info" />
      <span>
        What you see is parts of <a href="https://github.com/pingdotgg/t3code" target="_blank" rel="noreferrer">T3 Code</a>.
        {" "}Where you see it is <a href="https://spacefast.com" target="_blank" rel="noreferrer">Spacefast</a>.
      </span>
    </aside>
  );
}

function App() {
  const payload = useMemo(readPayload, []);
  const pages = useMemo(() => payload.pages || [], [payload.pages]);
  const { items, loading, error, loadNext, loadedPages, hasMore } = useWirePages(pages);
  return (
    <div className="app-shell">
      <SessionHeader session={payload.session} stats={payload.stats} />
      <Timeline messages={items} />
      <PageSentinel loading={loading} error={error} hasMore={hasMore} loadNext={loadNext} loadedPages={loadedPages} />
      <footer>Shared with <a href="https://www.npmjs.com/package/push-session" target="_blank" rel="noreferrer">push-session</a></footer>
      <ProvenanceBubble />
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
