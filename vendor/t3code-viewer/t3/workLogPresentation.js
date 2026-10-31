// Static-viewer extraction of T3 Code's work-log presentation vocabulary:
// packages/shared/src/toolActivity.ts (classifyToolActivity, formatSearchToolLabel,
// formatReadToolLabel, dynamicToolTitle), packages/client-runtime/src/work-log/
// presentation.ts (toolGroupAction, summarizeToolGroup, toolGroupSummaryKind,
// normalizeCompactToolLabel) and commandLabel.ts (commandDisplayText). Adapted to
// the tool names local agent transcripts record; see ../LICENSE and ../NOTICE.md.

const SHELL_PROGRAMS = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh", "fish"]);
const SEARCH_QUERY_KEYS = ["pattern", "query", "searchTerm", "regex", "grep", "needle", "q"];
const SEARCH_GLOB_KEYS = ["glob", "globPattern", "glob_pattern", "include", "filePattern", "file_pattern"];
const SEARCH_TARGET_KEYS = ["path", "target_directory", "directory", "dir_path", "cwd"];
const PATH_KEYS = ["file_path", "absolute_path", "notebook_path", "path", "filePath", "target_file"];

const COMMAND_TOOLS = new Set(["bash", "shell", "terminal", "execcommand", "runshellcommand", "localshell", "writestdin", "bashoutput", "killshell", "runterminalcmd"]);
const EDIT_TOOLS = new Set(["edit", "write", "multiedit", "applypatch", "notebookedit", "strreplace", "strreplacebasededittool", "createfile", "writefile", "replace", "editfile", "searchreplace", "deletefile"]);
const READ_TOOLS = new Set(["read", "readfile", "readmanyfiles", "viewimage", "imageview", "notebookread", "view"]);
const CODE_SEARCH_TOOLS = new Set(["grep", "glob", "find", "rg", "ls", "listdirectory", "listdir", "searchfilecontent", "codebasesearch", "filesearch", "grepsearch", "globfilesearch"]);
const WEB_TOOLS = new Set(["websearch", "webfetch", "googlewebsearch", "fetch", "websearchcall", "searchquery", "imagequery"]);
const AGENT_TOOLS = new Set(["task", "agent", "spawnagent", "sendinput", "waitagent", "closeagent", "resumeagent", "delegatetask"]);
const TODO_TOOLS = new Set(["todowrite", "todoread", "updateplan", "writetodos", "todolist"]);

export const TOOL_ACTIONS = ["command", "edit", "read", "code-search", "search", "agent", "todo", "skill", "mcp", "other"];

function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function asTrimmedString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstInputString(record, keys) {
  if (!record) return undefined;
  for (const key of keys) {
    const value = asTrimmedString(record[key]);
    if (value) return value;
  }
  return undefined;
}

function toolNameToken(value) {
  const trimmed = asTrimmedString(value);
  if (!trimmed) return undefined;
  return trimmed.replace(/[_\s-]/gu, "").toLowerCase();
}

function parseMcpName(name) {
  const match = /^mcp__(.+?)__(.+)$/u.exec(String(name || ""));
  return match ? { server: match[1], tool: match[2] } : null;
}

export function normalizeCompactToolLabel(value) {
  return String(value || "")
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .replaceAll("_", " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sentenceCase(value) {
  const label = normalizeCompactToolLabel(value);
  return label ? `${label.charAt(0).toUpperCase()}${label.slice(1).toLowerCase()}` : "Tool call";
}

/** Mirrors classifyToolActivity + toolGroupAction for transcript tool names. */
export function classifyToolAction({ itemType, name }) {
  if (parseMcpName(name)) return "mcp";
  const token = toolNameToken(name);
  if (itemType === "command_execution" || COMMAND_TOOLS.has(token)) return "command";
  if (itemType === "file_change" || EDIT_TOOLS.has(token)) return "edit";
  if (itemType === "image_view" || READ_TOOLS.has(token)) return "read";
  if (CODE_SEARCH_TOOLS.has(token)) return "code-search";
  if (itemType === "web_search" || WEB_TOOLS.has(token)) return "search";
  if (itemType === "collab_agent_tool_call" || AGENT_TOOLS.has(token)) return "agent";
  if (TODO_TOOLS.has(token)) return "todo";
  if (token === "skill") return "skill";
  if (itemType === "mcp_tool_call") return "mcp";
  return "other";
}

/** commandDisplayText: drop a lone `bash -lc "<script>"` wrapper. */
export function commandDisplayText(command) {
  if (Array.isArray(command)) {
    const parts = command.map(String);
    const program = parts[0]?.split(/[\\/]/u).at(-1);
    if (program && SHELL_PROGRAMS.has(program) && parts.length === 3 && /^-\w*c$/u.test(parts[1])) {
      return parts[2].trim();
    }
    return parts.join(" ").trim();
  }
  const trimmed = String(command || "").trim();
  const wrapped = /^(?:\/\S*\/)?(?:ba|z|da|k)?sh\s+-\w*c\s+(["'])([\s\S]*)\1$/u.exec(trimmed);
  return wrapped ? wrapped[2].trim() : trimmed;
}

function relativePath(value, project) {
  const filePath = String(value || "").trim();
  if (!filePath || !project) return filePath;
  const root = String(project).replace(/[\\/]+$/u, "");
  if (filePath === root) return ".";
  return filePath.startsWith(`${root}/`) || filePath.startsWith(`${root}\\`) ? filePath.slice(root.length + 1) : filePath;
}

function patchPaths(input) {
  const text = typeof input === "string" ? input : asTrimmedString(asRecord(input)?.input) || asTrimmedString(asRecord(input)?.patch);
  if (!text) return [];
  const paths = [];
  for (const match of text.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gmu)) paths.push(match[1].trim());
  for (const match of text.matchAll(/^\+\+\+ b\/(.+)$/gmu)) paths.push(match[1].trim());
  return [...new Set(paths)];
}

function inputPaths(input) {
  const record = asRecord(input);
  if (!record) return patchPaths(input);
  const direct = firstInputString(record, PATH_KEYS);
  if (direct) return [direct];
  if (Array.isArray(record.paths)) return record.paths.filter((entry) => typeof entry === "string");
  if (Array.isArray(record.file_paths)) return record.file_paths.filter((entry) => typeof entry === "string");
  return patchPaths(record);
}

function searchLabel(token, input) {
  const record = asRecord(input);
  if (!record) return typeof input === "string" && input.trim() ? `Searched ${input.trim()}` : undefined;
  const glob = token === "glob" ? firstInputString(record, ["pattern", ...SEARCH_GLOB_KEYS]) : firstInputString(record, SEARCH_GLOB_KEYS);
  const query = token === "glob" ? undefined : firstInputString(record, SEARCH_QUERY_KEYS);
  const target = firstInputString(record, SEARCH_TARGET_KEYS)?.split(/[\\/]/u).findLast((part) => part.length > 0 && part !== ".");
  if (query && target) return `Searched ${query} in ${target}`;
  if (glob && target) return `Searched files ${glob} in ${target}`;
  if (glob) return `Searched files ${glob}`;
  if (query) return `Searched ${query}`;
  if (target) return token === "ls" || token === "listdirectory" ? `Listed ${target}` : `Searched in ${target}`;
  return undefined;
}

function withMore(label, extra) {
  return extra > 0 ? `${label} +${extra} more` : label;
}

/**
 * One transcript tool call -> the heading T3 Code's work log shows for it.
 * Returns { action, label, paths }.
 */
export function describeToolCall({ itemType, name, input, summary, command, project }) {
  const action = classifyToolAction({ itemType, name });
  const token = toolNameToken(name);
  const record = asRecord(input);
  const paths = action === "edit" || action === "read" ? inputPaths(input).map((entry) => relativePath(entry, project)) : [];
  let label;
  switch (action) {
    case "command": {
      const raw = command ?? record?.cmd ?? record?.command ?? (typeof input === "string" ? input : undefined) ?? summary;
      label = raw ? commandDisplayText(raw) : "Ran command";
      break;
    }
    case "edit":
      label = paths[0] ? withMore(`Edited ${paths[0]}`, paths.length - 1) : "Edited files";
      break;
    case "read":
      label = paths[0] ? withMore(`Read ${paths[0]}`, paths.length - 1) : token === "viewimage" ? "Viewed image" : "Read file";
      break;
    case "code-search":
      label = searchLabel(token, input) || "Searched code";
      break;
    case "search": {
      const url = asTrimmedString(record?.url);
      label = url ? `Fetched ${url.replace(/^https?:\/\//u, "")}` : searchLabel(token, input) || "Searched the web";
      break;
    }
    case "agent": {
      const description = asTrimmedString(record?.description) || asTrimmedString(record?.message) || asTrimmedString(record?.prompt);
      const kind = asTrimmedString(record?.subagent_type) || asTrimmedString(record?.agent_type);
      label = description ? `${kind ? `${sentenceCase(kind)} agent` : "Agent"}: ${description.split("\n")[0]}` : "Ran agent";
      break;
    }
    case "todo":
      label = token === "updateplan" ? "Updated plan" : "Updated todo list";
      break;
    case "skill":
      label = asTrimmedString(record?.skill) ? `Skill: ${record.skill.trim()}` : "Used skill";
      break;
    case "mcp": {
      const mcp = parseMcpName(name);
      label = mcp ? `${normalizeCompactToolLabel(mcp.server)}: ${normalizeCompactToolLabel(mcp.tool)}` : sentenceCase(name);
      break;
    }
    default:
      label = asTrimmedString(summary) || sentenceCase(name === "result" ? "Tool result" : name);
  }
  return { action, label: String(label).split("\n")[0].slice(0, 240), paths };
}

function actionLabel(action, count) {
  const plural = (one, many) => (count === 1 ? one : many);
  switch (action) {
    case "read":
      return `Read ${count} ${plural("file", "files")}`;
    case "edit":
      return `Changed ${count} ${plural("file", "files")}`;
    case "command":
      return `Ran ${count} ${plural("command", "commands")}`;
    case "search":
      return `Searched the web ${count} ${plural("time", "times")}`;
    case "code-search":
      return `Searched code ${count} ${plural("time", "times")}`;
    case "agent":
      return `Ran ${count} ${plural("agent", "agents")}`;
    case "todo":
      return `Updated todos ${count} ${plural("time", "times")}`;
    case "skill":
      return `Used ${count} ${plural("skill", "skills")}`;
    default:
      return `Used ${count} ${plural("tool", "tools")}`;
  }
}

function actionPriority(action) {
  if (action === "command" || action === "edit" || action === "agent") return 0;
  if (action === "other" || action === "mcp") return 2;
  return 1;
}

function actionCount(action, entries) {
  if (action !== "edit") return entries.length;
  const files = new Set();
  let withoutFiles = 0;
  for (const entry of entries) {
    const paths = entry.data?.paths || [];
    if (paths.length === 0) withoutFiles += 1;
    else paths.forEach((filePath) => files.add(filePath));
  }
  return files.size + withoutFiles;
}

export function entryAction(entry) {
  if (entry.itemType === "reasoning") return "reasoning";
  return entry.data?.action || classifyToolAction({ itemType: entry.itemType, name: entry.data?.name || entry.title });
}

/** summarizeToolGroup: two highest-priority actions, then "N other actions". */
export function summarizeToolGroup(entries) {
  const tools = entries.filter((entry) => entry.itemType !== "reasoning");
  if (entries.length > 0 && tools.length === 0) {
    return entries.length === 1 ? "Thought" : `Thought (×${entries.length})`;
  }
  const groups = new Map();
  for (const entry of tools) {
    const action = entryAction(entry) === "mcp" ? "other" : entryAction(entry);
    const group = groups.get(action);
    if (group) group.push(entry);
    else groups.set(action, [entry]);
  }
  const summaries = [...groups].map(([action, group], index) => ({
    index,
    count: group.length,
    priority: actionPriority(action),
    label: actionLabel(action, actionCount(action, group)),
  }));
  const selected = [...summaries]
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .slice(0, 2)
    .sort((a, b) => a.index - b.index);
  const labels = selected.map(({ label }) => label);
  const remaining = tools.length - selected.reduce((count, group) => count + group.count, 0);
  if (remaining > 0) labels.push(`Performed ${remaining} other ${remaining === 1 ? "action" : "actions"}`);
  const sentence = labels.map((label, index) => (index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1)));
  return sentence.length < 3 ? sentence.join(" and ") : `${sentence.slice(0, -1).join(", ")}, and ${sentence.at(-1)}`;
}

/** toolGroupSummaryKind: one action names the group icon; anything else is mixed. */
export function toolGroupSummaryKind(entries) {
  const tools = entries.filter((entry) => entry.itemType !== "reasoning");
  if (entries.length > 0 && tools.length === 0) return "reasoning";
  const actions = new Set(tools.map(entryAction));
  return actions.size === 1 ? actions.values().next().value : "mixed";
}

export function entryFailed(entry) {
  return entry.status === "failed" || entry.status === "declined" || Boolean(entry.data?.isError);
}
