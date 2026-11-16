const SECRET_KEY = /secret|token|password|passwd|api[_-]?key|private[_-]?key|access[_-]?key/i;
const TOKEN_RULES = [
  ["anthropic", /(?<![\w-])sk-ant-[A-Za-z0-9_-]{20,200}(?![\w-])/gd],
  ["openai", /(?<![\w-])sk-(?:(?:proj-|svcacct-)[A-Za-z0-9_-]{20,200}|(?!ant-|proj-|svcacct-)[A-Za-z0-9_-]{20,200})(?![\w-])/gd],
  ["github", /(?<![\w-])(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,255})(?![\w-])/gd],
  ["gitlab", /(?<![\w-])glpat-[A-Za-z0-9_-]{20,255}(?![\w-])/gd],
  ["slack", /(?<![\w-])xox[abprs]-[A-Za-z0-9-]{10,255}(?![\w-])/gd],
  ["stripe", /(?<![\w-])(?:sk|rk)_live_[A-Za-z0-9]{16,200}(?![\w-])/gd],
  ["aws", /(?<![\w-])(?:AKIA|ASIA)[A-Z0-9]{16}(?![\w-])/gd],
  ["google", /(?<![\w-])AIza[A-Za-z0-9_-]{35}(?![\w-])/gd],
  ["npm", /(?<![\w-])npm_[A-Za-z0-9]{36}(?![\w-])/gd],
];

// Capture just the value so keys, quotes, and surrounding commands survive.
const ASSIGNMENT_RULES = [
  { pattern: /(?<![\w.-])([A-Za-z_][\w.-]*)[ \t]*=[ \t]*(?:"((?:\\.|[^"\\\r\n])*)"|'((?:\\.|[^'\\\r\n])*)'|([^\s"'`,;<>()[\]{}]+))/gd, key: 1, values: [2, 3, 4] },
  { pattern: /(["'])([A-Za-z_][\w.-]*)\1[ \t]*:[ \t]*(?:"((?:\\.|[^"\\\r\n])*)"|'((?:\\.|[^'\\\r\n])*)')/gd, key: 2, values: [3, 4] },
];

export function redactText(text) {
  const matches = [];
  const add = (match, kind, group = 0) => {
    const [start, end] = match.indices[group];
    matches.push({ start, end, kind });
  };
  for (const [kind, pattern] of TOKEN_RULES) {
    for (const match of text.matchAll(pattern)) add(match, kind);
  }
  for (const match of text.matchAll(/-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?-----END \1-----/gd)) {
    add(match, "private-key");
  }
  for (const match of text.matchAll(/\bAuthorization["']?[ \t]*:[ \t]*["']?(Bearer|Basic)[ \t]+([A-Za-z0-9._~+/-]+=*)(?![\w=])/gdi)) {
    if (isSecretValue(match[2])) add(match, match[1].toLowerCase(), 2);
  }
  for (const match of text.matchAll(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/@]+)@[^\s/]+/gd)) {
    if (!isPlaceholder(match[1])) add(match, "url-password", 1);
  }
  for (const { pattern, key, values } of ASSIGNMENT_RULES) {
    for (const match of text.matchAll(pattern)) {
      const group = values.find((index) => match[index] !== undefined);
      const quoted = group !== values[values.length - 1];
      // `KEY=getSecret()` is a call, not a literal.
      if (!quoted && text[match.indices[group][1]] === "(") continue;
      if (SECRET_KEY.test(match[key]) && isSecretValue(match[group]) && (quoted || !isCodeExpression(match[group]))) {
        add(match, "assignment", group);
      }
    }
  }

  // Prefer the outermost match. Equal spans retain the more specific token kind.
  // Work on original offsets so replacement markers cannot be matched again.
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const counts = {};
  const parts = [];
  let offset = 0;
  for (const { start, end, kind } of matches) {
    if (start < offset) continue;
    parts.push(text.slice(offset, start), `[redacted: ${kind}]`);
    counts[kind] = (counts[kind] || 0) + 1;
    offset = end;
  }
  parts.push(text.slice(offset));
  return { text: parts.join(""), counts };
}

export function redactMessages(messages) {
  const counts = {};
  const walk = (value, key = "") => {
    if (typeof value === "string") {
      const header = /^authorization$/i.test(key) ? "Authorization: " : "";
      const result = redactText(header + value);
      // Structured tool arguments need the same assignment rule as JSON text.
      if (SECRET_KEY.test(key) && isSecretValue(value)) {
        const kinds = Object.keys(result.counts);
        const kind = kinds.length === 1 && result.text === `[redacted: ${kinds[0]}]` ? kinds[0] : "assignment";
        counts[kind] = (counts[kind] || 0) + 1;
        return `[redacted: ${kind}]`;
      }
      for (const [kind, count] of Object.entries(result.counts)) counts[kind] = (counts[kind] || 0) + count;
      return result.text.slice(header.length);
    }
    if (Array.isArray(value)) return value.map((item) => walk(item, key));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, walk(item, name)]));
    }
    return value;
  };
  return { messages: messages.map((message) => walk(message)), counts };
}

function isSecretValue(value) {
  return value.length >= 8 && !/\s/.test(value) && !isPlaceholder(value);
}

// Placeholders and variable references are not secrets: `${TOKEN}`, `$API_KEY`,
// `<token>`, `***`, `xxxxxxxx`, `...`.
function isPlaceholder(value) {
  return /^(?:\$|<|\{|%|\[redacted)/.test(value) || /^(?:[.*x]+|pass(?:word)?|changeme|redacted)$/i.test(value);
}

// Unquoted right-hand sides in code are usually expressions, not literals:
// `process.env.API_KEY`, `getToken()`, `/regex/`, `options.secret`.
function isCodeExpression(value) {
  return /^[/@!]/.test(value) || /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value) || /\(/.test(value) ||
    /^(?:true|false|null|undefined|None|True|False)$/.test(value);
}
