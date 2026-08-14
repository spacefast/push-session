const VALUE_FLAGS = new Set(["--space", "--api-url", "--limit"]);

export function parseArgs(argv) {
  const options = {
    apiUrl: process.env.SPACEFAST_API_URL,
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

  return { agent: positionals[0], sessionId: positionals[1], options };
}

function assignValue(options, flag, value) {
  if (flag === "--space") options.space = value;
  if (flag === "--api-url") options.apiUrl = value.replace(/\/$/, "");
  if (flag === "--limit") {
    const limit = Number.parseInt(value, 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("--limit must be an integer between 1 and 500.");
    }
    options.limit = limit;
  }
}
