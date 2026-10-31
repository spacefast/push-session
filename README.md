# push-session

Share an AI coding-agent session as a private [Spacefast](https://spacefast.com)
link. One command, no setup.

```bash
npx push-session                 # pick any session from any agent
npx push-session claude          # pick from one agent
npx push-session codex <id>      # share that one, no questions
```

It finds your local Codex, Claude Code, Gemini CLI, Cursor Agent, and Pi
sessions and puts them in one searchable list, newest first. Titles come from
the agent itself: your rename first, then the agent's own title, then your first
real prompt. Subagent and sidechain transcripts stay out of the list.

## Where your sessions go

**Signed in** (`sf login`, or `SPACEFAST_TOKEN`): the first run asks which of
your Spaces should hold your sessions, or makes a new private one called
"AI sessions". That choice is remembered. Every later run publishes straight
there.

```bash
npx push-session --pick-space    # choose a different Space and remember it
npx push-session --space <id>    # publish to another Space once
npx push-session --new-space     # fresh "AI sessions" Space, now the default
```

In more than one team? You'll be asked which team owns a new Space, or pass
`--team <slug>`. With no terminal attached (agents, `--json`), push-session
reuses your Space titled "AI sessions", or creates it.

**Signed out:** sessions go to a claimable Space that lives on this machine.
Claim it to keep the links, or run `sf login` to publish into your own Space.

Each session gets its own route and a view-only share link scoped to it. Nobody
can browse the rest of the Space with it.

> Sessions can contain code, file paths, commands, and secrets. Review before
> sharing. Anyone with the link can read it.

Options: `--pick-space`, `--space <id>`, `--new-space`, `--team <slug>`,
`--limit <n>`, `--dry-run`, `--json`, and `--api-url <url>`.

## What the page shows

A paginated, read-only transcript: your messages, the agent's replies in
Markdown, and its tool calls folded into readable groups ("Ran 3 commands and
changed 2 files"). Light and dark. Claude sessions also bring along the HTML and
Markdown artifacts they published, and Codex sessions bring the ChatGPT Sites
they built (details below).

## Recover Claude Code artifacts

Claude Code writes artifact sources to local HTML or Markdown files before it
publishes them. The transcript retains the source path, publish URL, `Write` and
`Edit` operations, and file-history references even after a temporary source
file disappears. `push-session artifacts` rebuilds those sources and versions:

```bash
# Inventory every locally recorded Claude artifact and its recovery status.
npx push-session artifacts list

# Export a self-contained HTML gallery plus the original sources.
npx push-session artifacts export --all --versions --output ./claude-artifacts

# Republish one recovered artifact, or the complete gallery, through Spacefast.
npx push-session artifacts publish <artifact-id>
npx push-session artifacts publish --all --versions
```

`export` refuses a non-empty output directory unless `--force` is present,
and refuses to write through symlinks even with `--force`. New export files
and directories are private to the current user by default.
`publish --dry-run` reconstructs and renders without uploading. Artifact queries
match the Claude artifact ID or URL, session ID, title, and source path.

> Recovered artifacts can contain sensitive data. HTML artifacts are active
> pages: opening or publishing one runs its scripts. Review sources first.

## Recover ChatGPT Sites

No separate command is needed. Publish the Codex session that created or
updated the Site:

```bash
npx push-session codex <session-id>
```

The exporter reads recorded Sites save and deploy calls, finds the matching
`.openai/hosting.json` at the saved Git commit, and uploads that Site source
under the session route. Tracked environment files, private keys, credential
files, oversized files, and files beyond the recovery size limit are omitted
and listed on the version page. If the original temporary deployment archive
still exists, the version page includes it as a download.
Archives that belong to a different Site or contain files with sensitive
names are left out. Review the transcript, source, and any remaining archive
before sharing; embedded secrets in code cannot be detected reliably.

## Credits

The transcript viewer is built from [T3 Code](https://github.com/pingdotgg/t3code)
by T3 Tools Inc. We vendor its timeline rows, tool-call presentation, and
Markdown rendering, and session discovery follows its agent-session importer.
T3 Code is MIT-licensed; its license and the exact upstream revision and files
are in [`vendor/t3code-viewer`](vendor/t3code-viewer). Thank you, T3 team.

## Development

```bash
npm install
npm run check
npm pack --dry-run
```

MIT © Spacefast
