# push-session

Share AI coding-agent sessions as private [Spacefast](https://spacefast.com)
links.

```bash
npx push-session
npx push-session claude
npx push-session codex <session-id>
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
view-only access link.

> Sessions may contain code, file paths, commands, or secrets. Review before
> sharing. Anyone with the generated link can view it.

Options: `--space <id>`, `--new-space`, `--limit <n>`, `--dry-run`, `--json`,
and `--api-url <url>`.

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
