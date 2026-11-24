# push-session

Share an AI coding-agent session as a private [Spacefast](https://spacefast.com)
link. One command, no setup.

```bash
npx push-session                 # pick any session from any agent
npx push-session t3 <id>         # share a T3 Code thread
npx push-session claude          # pick from one agent
npx push-session codex <id>      # share that one, no questions
```

It finds your local Codex, Claude Code, Gemini CLI, Cursor Agent, Pi, and T3 Code
sessions and puts them in one searchable list, newest first. Titles come from
the agent itself: your rename first, then the agent's own title, then your first
real prompt. Subagent and sidechain transcripts stay out of the list.

The picker is one list of every session. Type to search all of them by title,
project, agent or ID, or press Tab to show one agent's sessions; the line under
the list says which. Each row starts with its agent's logo, or a text mark where
the terminal cannot draw images. `--limit <n>` changes how many are shown at a time; it does
not hide older sessions.

Prefer a page? `npx push-session web` opens a picker in your browser: search,
filter by agent, tick the sessions to publish, choose private or public, and
publish them in one go. Ctrl+X in the terminal list switches to it. The page is
served from this machine only, to the address the command prints; it takes the
same publishing options (`--team`, `--space`, `--no-redact`), plus `--port <n>`
and `--no-open`.

T3 Code threads are read from `~/.t3/userdata/statev2.sqlite`, falling back to
`state.sqlite` for V1 installations. `T3CODE_HOME` changes the base directory;
`T3CODE_STATE_DIR` overrides the state directory directly. Reading T3 sessions requires
Node 22.13+ or the `sqlite3` command on older Node releases.

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

Each session gets its own route. Signed in, you choose who can open it:

| Flag | Who can open the session |
|---|---|
| `--private` (default) | Your team, plus anyone with its view-only share link |
| `--public` | Anyone with the address, no link needed |

A share link is scoped to one session, so nobody can browse the rest of the
Space with it. Signed in, a session's address is a random ID, not the agent's
session ID, so a public session cannot be found by guessing. Publishing a session again without a flag keeps what it had; a
flag changes it. Signed out, sessions are always private.

The Space also gets a sessions page at its root, and at `/sessions/`. Your team
sees every session there. Everyone else sees only the public ones, and nothing at
all while no session is public. A Space that already has its own home page keeps
it: the sessions page is then at `/sessions/` only.

A private session cannot go into a Space that is public as a whole, since anyone
could open it there. Publish it with `--public`, or pick a private Space.

> Sessions can contain code, file paths, commands, and secrets. Review before
> sharing. Anyone with the link can read it.

Keys, tokens, passwords and private keys in well-known formats are masked as
`[redacted]` before upload: API keys (Anthropic, OpenAI, GitHub, GitLab, Slack,
Stripe live keys, AWS access key IDs, Google, npm), private-key blocks,
`Authorization` values, URL passwords, and assignments to names such as
`API_KEY`, `token` or `password`. The count is reported with a breakdown by
kind; `--json` has it as `redacted` and `redactionCounts`. Masking is pattern
based, so it can miss a secret; `--no-redact` turns it off. A session picked
from the list asks who can open it before it is published.

Options: `--pick-space`, `--space <id>`, `--new-space`, `--team <slug>`,
`--limit <n>`, `--public`, `--private`, `--no-redact`, `--dry-run`, `--json`, and `--api-url <url>`.

## Manage what you've shared

`list` shows the sessions in your Space: the agent, the title, who can open
each one, when it was last active, and the address that opens it. In a terminal
the list is also where you change one: move to a session with ↑/↓ and press a
key. Enter opens it in your browser, `c` makes it public or private, `u`
publishes it again from this machine to the same address, and `d` deletes it.
Escape leaves the list. `--json` only lists.

```bash
npx push-session list
npx push-session list --json
npx push-session delete <session-id|route|url>
npx push-session delete <session-id> --yes
npx push-session unshare <session-id> --keep-files
```

`delete` takes a session back. It ends every share link scoped to that session
and its public access, removes its files from the live Space (transcript pages
and recovered artifacts included), and takes it off the sessions page. It asks
for confirmation first. Use `--yes` to skip the prompt, or `--json` for a
non-interactive result. Without a terminal, one of those flags is required.
`unshare` does the same. With `--keep-files` it ends the links and public
access but leaves the files, so the session stays on the list for your team as
a private one.
These commands accept `--space <id>` to manage another Space once. A signed-out
Space has to be claimed before it can be managed.

File removal affects the live version. Earlier immutable versions, downloaded
copies, and broader Space access are not removed by `delete` or `unshare`.

## What the page shows

A paginated, read-only transcript: your messages, the agent's replies in
Markdown, and its tool calls folded into readable groups ("Ran 3 commands and
changed 2 files"). Previous/Next and a page-number field navigate the transcript.
The URL remembers the page, browser Back/Forward works, and only the selected
page loads and renders. Failed requests can be retried. Long messages and tool
output can continue on the next page. Light and dark. Claude sessions also bring
along the HTML and Markdown artifacts they published, and Codex sessions bring
the ChatGPT Sites they built (details below).

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
