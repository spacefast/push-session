# push-session

Share AI coding-agent sessions as private [Spacefast](https://spacefast.com)
links.

```bash
npx push-session
npx push-session claude
npx push-session codex <session-id>
npx push-session artifacts list
npx push-session artifacts export --all
npx push-session artifacts publish <artifact-id>
```

It discovers local Codex, Claude Code, Gemini CLI, Cursor Agent, and Pi sessions,
then asks which one to publish. The first run creates an anonymous Spacefast
space and remembers it in the user-global push-session config. Later runs reuse
that space from any working directory without adding project-local state. If
saved implicit state can no longer authorize the space, publishing continues in
a replacement space; an explicit `--space <id>` remains strict. Claim the space
to keep using it, or set `SPACEFAST_TOKEN` for owned publishing.

Sessions render as paginated, read-only transcripts with Markdown and tool
calls. Each share uses the session ID as its route and a scoped, unguessable
view-only access link. Claude sessions also recover and upload their published
HTML or Markdown artifacts automatically. The session page links each artifact,
and transcript references point at the recovered copy inside the same private
Spacefast share.

> Sessions may contain code, file paths, commands, or secrets. Review before
> sharing. Anyone with the generated link can view it.

Options: `--space <id>`, `--new-space`, `--limit <n>`, `--dry-run`, `--json`,
and `--api-url <url>`.

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

`export` refuses a non-empty output directory unless `--force` is present.
`publish --dry-run` reconstructs and renders without uploading. Artifact queries
match the Claude artifact ID or URL, session ID, title, and source path.

> Recovered artifacts can contain sensitive data. HTML artifacts are active
> pages: opening or publishing one runs its scripts. Review sources first.

The viewer directly vendors static components from MIT-licensed
[T3 Code](https://github.com/pingdotgg/t3code); its license and attribution are
included in [`vendor/t3code-viewer`](vendor/t3code-viewer).

## Development

```bash
npm install
npm run check
npm pack --dry-run
```

MIT © Spacefast
