// Static-viewer extraction of T3 Code's timeline rows, from
// apps/web/src/components/chat/{MessagesTimeline,TimelineUserMessageRow,
// TimelineAssistantRows,TimelineWorkGroupRows,TimelineWorkEntryRow,
// TimelineWorkEntryRow.logic,TimelineToolActivityIcon,TimelineRowParts,WorkLog}.tsx.
// Row structure, burst grouping, tool-group summaries, icon vocabulary and the
// expand/copy interactions follow those files; live state, virtualization,
// approvals, rewind and diff panels are outside this read-only boundary.
import { memo, useState } from "react";
import {
  BotIcon,
  BrainIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CopyIcon,
  EyeIcon,
  GlobeIcon,
  HammerIcon,
  ListTodoIcon,
  SearchIcon,
  SquarePenIcon,
  TerminalIcon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";

import ChatMarkdown from "./ChatMarkdown.jsx";
import { describeToolCall, entryAction, entryFailed, summarizeToolGroup, toolGroupSummaryKind } from "./workLogPresentation.js";
import "./components.css";

const ACTION_ICONS = {
  command: TerminalIcon,
  edit: SquarePenIcon,
  read: EyeIcon,
  "code-search": SearchIcon,
  search: GlobeIcon,
  agent: BotIcon,
  todo: ListTodoIcon,
  reasoning: BrainIcon,
  skill: ZapIcon,
  mcp: WrenchIcon,
  other: HammerIcon,
  mixed: HammerIcon,
};

function MessageCopyButton({ text, label = "Copy message" }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="copy-button small"
      type="button"
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      onClick={() => navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_000);
      })}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

function RowTimestamp({ createdAt }) {
  if (!createdAt) return null;
  return <time dateTime={createdAt} title={longTimestamp(createdAt)}>{dayAwareTimestamp(createdAt)}</time>;
}

export function UserTimelineRow({ message, groupedWithNext = false }) {
  const [expanded, setExpanded] = useState(false);
  const text = message.detail || "";
  const collapsible = text.length > 1_200;
  return (
    <section className={`user-row timeline-row ${groupedWithNext ? "grouped" : ""}`}>
      <div className={`user-bubble ${collapsible && !expanded ? "collapsed" : ""}`}>
        <ChatMarkdown text={text} lineBreaks />
      </div>
      {collapsible ? (
        <button className="text-button" type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Show less" : "Show full message"}
        </button>
      ) : null}
      {groupedWithNext ? null : (
        <div className="message-actions">
          <RowTimestamp createdAt={message.createdAt} />
          <MessageCopyButton text={text} />
        </div>
      )}
    </section>
  );
}

export function AssistantTimelineRow({ message, showMeta = true }) {
  const text = message.detail || "";
  return (
    <section className={`assistant-row timeline-row ${showMeta ? "" : "continues"}`}>
      <div className="assistant-markdown">
        <ChatMarkdown text={text || "(empty response)"} />
      </div>
      {showMeta ? (
        <div className="message-actions assistant-actions">
          <MessageCopyButton text={text} label="Copy response" />
          {message.data?.model ? <span className="assistant-model">{message.data.model}</span> : null}
          <RowTimestamp createdAt={message.createdAt} />
        </div>
      ) : null}
    </section>
  );
}

/** One work burst: a lone call renders as its row; several fold under a summary header. */
export const WorkGroupSection = memo(function WorkGroupSection({ entries }) {
  const [expanded, setExpanded] = useState(false);
  const visible = entries.filter((entry) => entry.detail || entry.title || entry.data?.label);
  if (visible.length === 0) return null;
  if (visible.length === 1) {
    return (
      <section className="work-group timeline-row" aria-label="Activity">
        <WorkEntryRow workEntry={visible[0]} />
      </section>
    );
  }
  const kind = toolGroupSummaryKind(visible);
  const Icon = ACTION_ICONS[kind] || HammerIcon;
  const summary = summarizeToolGroup(visible);
  const latestTool = visible.findLast((entry) => entry.itemType !== "reasoning");
  const failed = latestTool ? entryFailed(latestTool) : false;
  return (
    <section className="work-group timeline-row" aria-label="Activity">
      <button
        className="work-line work-toggle"
        type="button"
        aria-expanded={expanded}
        aria-label={failed ? `${summary}, tool call failed` : summary}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className={`work-icon ${failed ? "failed" : ""}`}><Icon /></span>
        <span className="work-label">{summary}</span>
        <ChevronRightIcon className={`work-chevron ${expanded ? "open" : ""}`} />
        <span className="work-trailing"><RowTimestamp createdAt={visible[0].createdAt} /></span>
      </button>
      {expanded ? (
        <div className="work-list">
          {visible.map((workEntry, index) => <WorkEntryRow key={workEntry.itemId || index} workEntry={workEntry} />)}
        </div>
      ) : null}
    </section>
  );
});

const WorkEntryRow = memo(function WorkEntryRow({ workEntry }) {
  const [expanded, setExpanded] = useState(false);
  const isReasoning = workEntry.itemType === "reasoning";
  const action = entryAction(workEntry);
  const label = isReasoning
    ? expanded ? "Thought" : (workEntry.detail || "Thought").replace(/\s+/g, " ").trim()
    : workEntry.data?.label || describeToolCall({ itemType: workEntry.itemType, name: workEntry.data?.name || workEntry.title, summary: workEntry.data?.summary }).label;
  const body = expandedBody(workEntry, label);
  const canExpand = Boolean(body);
  const failed = entryFailed(workEntry);
  const Icon = failed && action === "other" ? CircleAlertIcon : ACTION_ICONS[action] || HammerIcon;
  const toggle = () => setExpanded((value) => !value);
  return (
    <div className={`work-entry ${canExpand ? "expandable" : ""} ${failed ? "failed" : ""}`}>
      <div
        className="work-line"
        role={canExpand ? "button" : undefined}
        tabIndex={canExpand ? 0 : undefined}
        aria-expanded={canExpand ? expanded : undefined}
        aria-label={failed ? `${label}, tool call failed` : label}
        onClick={canExpand ? toggle : undefined}
        onKeyDown={canExpand ? (event) => {
          if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            toggle();
          }
        } : undefined}
      >
        <span className={`work-icon ${failed ? "failed" : ""}`} role={failed ? "img" : undefined} aria-label={failed ? "Tool call failed" : undefined}>
          <Icon />
        </span>
        <span className={`work-label ${action === "command" ? "mono" : ""}`}>{label}</span>
        {canExpand ? <ChevronRightIcon className={`work-chevron ${expanded ? "open" : ""}`} /> : null}
      </div>
      {expanded && body ? (
        isReasoning ? (
          <div className="work-detail reasoning"><ChatMarkdown text={body} /></div>
        ) : (
          <pre className="work-detail">{body}</pre>
        )
      ) : null}
      {workEntry.data?.artifact ? (
        <a className="artifact-work-link" href={workEntry.data.artifact.href} target="_blank" rel="noreferrer">
          <span>{workEntry.data.artifact.favicon || "◇"}</span>
          Open {workEntry.data.artifact.title || "artifact"}
          {workEntry.data.artifact.version ? ` · version ${workEntry.data.artifact.version}` : ""}
          <span aria-hidden="true">↗</span>
        </a>
      ) : null}
    </div>
  );
});

// buildToolCallExpandedBody: drop blocks that only repeat the visible label.
function expandedBody(workEntry, label) {
  const detail = workEntry.detail?.trim();
  if (!detail) return null;
  if (workEntry.itemType === "reasoning") return detail;
  const blocks = detail.split(/\n\n(?=(?:Input|Output)\n)/u).filter((block) => {
    const content = block.replace(/^(?:Input|Output)\n/u, "").trim();
    return content && content !== label.trim() && content !== JSON.stringify(label);
  });
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

function dayAwareTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const sameDay = date.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(undefined, sameDay
    ? { hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function longTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "medium" }).format(date);
}
