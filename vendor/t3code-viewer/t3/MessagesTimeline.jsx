// Static-viewer extraction of T3 Code's MessagesTimeline row components.
// Component names, row structure, tool vocabulary, status treatment, and
// interaction behavior come directly from MessagesTimeline.tsx.
import { memo, useMemo, useState } from "react";
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CopyIcon,
  EyeIcon,
  GlobeIcon,
  HammerIcon,
  MinusIcon,
  SquarePenIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";

import ChatMarkdown from "./ChatMarkdown.jsx";
import "./components.css";

function MessageCopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="copy-button small"
      type="button"
      aria-label="Copy message"
      onClick={() => navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_000);
      })}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

export function UserTimelineRow({ message }) {
  const [expanded, setExpanded] = useState(false);
  const text = message.detail || "";
  const collapsible = text.length > 1_200;
  return (
    <section className="user-row timeline-row group flex flex-col items-end gap-1">
      <div className={`user-bubble relative max-w-[80%] rounded-2xl border border-border bg-secondary p-3 ${collapsible && !expanded ? "collapsed" : ""}`}>
        <ChatMarkdown text={text} lineBreaks />
        {collapsible ? (
          <button className="text-button" type="button" onClick={() => setExpanded((value) => !value)}>
            {expanded ? "Show less" : "Show full message"}
          </button>
        ) : null}
      </div>
      <div className="message-actions flex items-center justify-end">
        {message.createdAt ? <time>{shortTimestamp(message.createdAt)}</time> : null}
        <MessageCopyButton text={text} />
      </div>
    </section>
  );
}

export function AssistantTimelineRow({ message }) {
  const text = message.detail || "";
  return (
    <section className="assistant-row timeline-row group/assistant pb-4">
      <div className="assistant-markdown relative min-w-0 px-1 py-0.5">
        <ChatMarkdown text={text || "(empty response)"} />
      </div>
      <div className="message-actions assistant-actions">
        <MessageCopyButton text={text} />
        {message.data?.model ? <span>{message.data.model}</span> : null}
        {message.createdAt ? <time>{shortTimestamp(message.createdAt)}</time> : null}
      </div>
    </section>
  );
}

export const WorkGroupSection = memo(function WorkGroupSection({ entries }) {
  const [showAll, setShowAll] = useState(false);
  const nonEmptyEntries = useMemo(() => entries.filter((entry) => entry.detail || entry.title), [entries]);
  const hidden = Math.max(0, nonEmptyEntries.length - 4);
  const visible = showAll || hidden === 0 ? nonEmptyEntries : nonEmptyEntries.slice(-4);
  if (nonEmptyEntries.length === 0) return null;
  return (
    <section className="work-group timeline-row -mx-1 space-y-0.5 px-1 py-0.5" aria-label={`${nonEmptyEntries.length} tool calls`}>
      {hidden > 0 ? (
        <button className="work-overflow" type="button" aria-expanded={showAll} onClick={() => setShowAll((value) => !value)}>
          <ChevronDownIcon className={showAll ? "rotate" : ""} />
          {showAll ? "Show fewer tool calls" : `+${hidden} previous tool call${hidden === 1 ? "" : "s"}`}
        </button>
      ) : null}
      <div className="work-list space-y-px">
        {visible.map((workEntry, index) => (
          <SimpleWorkEntryRow key={workEntry.itemId || index} workEntry={workEntry} />
        ))}
      </div>
    </section>
  );
});

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow({ workEntry }) {
  const [expanded, setExpanded] = useState(false);
  const heading = toolWorkEntryHeading(workEntry);
  const rawPreview = workEntry.data?.summary || workEntry.data?.command || "";
  const preview = rawPreview && normalizeCompactToolLabel(rawPreview).toLowerCase() !== normalizeCompactToolLabel(heading).toLowerCase() ? rawPreview : null;
  const expandedBody = workEntry.detail || null;
  const canExpand = expandedBody !== null;
  const failed = workEntry.status === "failed" || workEntry.status === "declined" || workEntry.data?.isError;
  const neutral = workEntry.status === "inProgress";
  const EntryIcon = workEntryIcon(workEntry);
  return (
    <div
      className={`work-entry flex flex-col rounded-md px-0.5 py-0.5 transition-colors ${canExpand ? "expandable" : ""}`}
      role={canExpand ? "button" : undefined}
      tabIndex={canExpand ? 0 : undefined}
      aria-label={preview ? `${heading} - ${preview}` : heading}
      onClick={canExpand ? () => setExpanded((value) => !value) : undefined}
      onKeyDown={canExpand ? (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setExpanded((value) => !value);
        }
      } : undefined}
    >
      <div className="work-line flex select-none items-center gap-1.5">
        <span className="work-icon flex size-5 shrink-0 items-center justify-center text-muted-foreground/65"><EntryIcon /></span>
        <span className="work-heading font-medium text-foreground/82">{heading}</span>
        {preview ? <span className="work-preview text-muted-foreground/55">{preview}</span> : null}
        {canExpand ? <ChevronDownIcon className={`work-chevron ${expanded ? "rotate" : ""}`} /> : null}
        <span className={`work-status ${failed ? "failed" : neutral ? "neutral" : "success"}`} title={failed ? "Failed" : neutral ? "In progress" : "Completed"}>
          {failed ? <XIcon /> : neutral ? <MinusIcon /> : <CheckIcon />}
        </span>
      </div>
      {expanded && expandedBody ? (
        <div className="mt-1 ms-7 cursor-default border-s border-border/45 ps-3 pt-0.5" onClick={(event) => event.stopPropagation()}>
          <pre className="work-detail">{expandedBody}</pre>
        </div>
      ) : null}
    </div>
  );
});

function workEntryIcon(workEntry) {
  if (workEntry.itemType === "command_execution") return TerminalIcon;
  if (workEntry.itemType === "file_change") return SquarePenIcon;
  if (workEntry.itemType === "web_search") return GlobeIcon;
  if (workEntry.itemType === "image_view") return EyeIcon;
  if (workEntry.itemType === "mcp_tool_call") return WrenchIcon;
  if (workEntry.itemType === "dynamic_tool_call" || workEntry.itemType === "collab_agent_tool_call") return HammerIcon;
  if (workEntry.itemType === "error") return CircleAlertIcon;
  if (workEntry.itemType === "reasoning") return BotIcon;
  return ZapIcon;
}

function normalizeCompactToolLabel(value) {
  return String(value || "").replaceAll("_", " ").replace(/\s+/g, " ").trim();
}

function toolWorkEntryHeading(workEntry) {
  const labels = {
    exec_command: "Ran command",
    shell: "Ran command",
    bash: "Ran command",
    apply_patch: "Edited files",
    read_file: "Read file",
    view_image: "Viewed image",
    web_search: "Searched the web",
  };
  const name = workEntry.data?.name || workEntry.title || workEntry.itemType || "Tool call";
  const label = labels[name] || normalizeCompactToolLabel(name);
  return label ? `${label.charAt(0).toUpperCase()}${label.slice(1)}` : "Tool call";
}

function shortTimestamp(value) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}
