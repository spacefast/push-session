const VALUE_FLAGS = new Set(["--space", "--api-url", "--limit"]);

export function parseArgs(argv, env = process.env) {
  const options = {
    apiUrl: env.SPACEFAST_API_URL,
    dryRun: false,
    help: false,
    json: false,
    limit: 50,
    newSpace: false,
    space: undefined,
    version: false,
  };
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!value.startsWith("-")) {
      positionals.push(value);
      continue;
    }
    if (value === "-h" || value === "--help") options.help = true;
    else if (value === "-v" || value === "--version") options.version = true;
    else if (value === "--json") options.json = true;
    else if (value === "--dry-run") options.dryRun = true;
    else if (value === "--new-space") options.newSpace = true;
    else if (value.includes("=")) {
      const [flag, ...rest] = value.split("=");
      if (!VALUE_FLAGS.has(flag)) throw new Error(`Unknown option: ${flag}`);
      assignValue(options, flag, rest.join("="));
    } else if (VALUE_FLAGS.has(value)) {
      const next = argv[index + 1];
      if (!next || next.startsWith("-")) throw new Error(`${value} requires a value.`);
      assignValue(options, value, next);
      index += 1;
    } else {
      throw new Error(`Unknown option: ${value}`);
    }
  }

  if (positionals.length > 2) {
    throw new Error("Expected at most an agent and a session ID.");
  }
  if (options.newSpace && options.space) {
    throw new Error("--new-space and --space cannot be used together.");
  }

  if (options.apiUrl) options.apiUrl = apiOrigin(options.apiUrl);

  return { agent: positionals[0], sessionId: positionals[1], options };
}

function assignValue(options, flag, value) {
  if (!value) throw new Error(`${flag} requires a value.`);
  if (flag === "--space") options.space = value;
  if (flag === "--api-url") options.apiUrl = value;
  if (flag === "--limit") {
    const limit = Number(value);
    if (!/^\d+$/.test(value) || !Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("--limit must be an integer between 1 and 500.");
    }
    options.limit = limit;
  }
}

export function apiOrigin(value) {
  let url;
  try { url = new URL(value); } catch { /* handled below */ }
  if (!url || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("--api-url must be an HTTPS origin or an HTTP loopback origin without a path, query, or credentials.");
  }
  return url.origin;
}
