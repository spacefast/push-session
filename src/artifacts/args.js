import { apiOrigin } from "../args.js";

const COMMANDS = new Set(["list", "export", "publish"]);
const VALUE_FLAGS = new Set(["--api-url", "--output", "--route", "--space"]);

export function parseArtifactArgs(argv, env = process.env) {
  const options = {
    all: false,
    allVersions: false,
    apiUrl: env.SPACEFAST_API_URL,
    dryRun: false,
    force: false,
    help: false,
    json: false,
    newSpace: false,
    output: "claude-artifacts-export",
    route: undefined,
    space: undefined,
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
    else if (value === "--all") options.all = true;
    else if (value === "--versions") options.allVersions = true;
    else if (value === "--dry-run") options.dryRun = true;
    else if (value === "--force") options.force = true;
    else if (value === "--json") options.json = true;
    else if (value === "--new-space") options.newSpace = true;
    else if (value.includes("=")) {
      const [flag, ...rest] = value.split("=");
      if (!VALUE_FLAGS.has(flag)) throw new Error(`Unknown artifact option: ${flag}`);
      assignValue(options, flag, rest.join("="));
    } else if (VALUE_FLAGS.has(value)) {
      const next = argv[index + 1];
      if (!next || next.startsWith("-")) throw new Error(`${value} requires a value.`);
      assignValue(options, value, next);
      index += 1;
    } else {
      throw new Error(`Unknown artifact option: ${value}`);
    }
  }

  const command = positionals[0] || "list";
  const query = positionals[1];
  if (!COMMANDS.has(command)) throw new Error(`Unknown artifact command: ${command}`);
  if (positionals.length > 2) throw new Error("Expected an artifact command and at most one artifact query.");
  if (options.all && query) throw new Error("Use an artifact query or --all, not both.");
  if (options.newSpace && options.space) throw new Error("--new-space and --space cannot be used together.");
  if (options.apiUrl) options.apiUrl = apiOrigin(options.apiUrl);
  return { command, query, options };
}

function assignValue(options, flag, value) {
  if (!value) throw new Error(`${flag} requires a value.`);
  if (flag === "--space") options.space = value;
  if (flag === "--output") options.output = value;
  if (flag === "--route") options.route = value;
  if (flag === "--api-url") options.apiUrl = value;
}
