# T3 Code viewer attribution

This static transcript viewer directly vendors a static-viewer boundary from
[T3 Code](https://github.com/pingdotgg/t3code), revision
`5ca32661b7dc8d512305c3bb9237d994a41a1af5`:

- `apps/web/src/components/chat/MessagesTimeline.tsx`
- `apps/web/src/components/ChatMarkdown.tsx`
- `apps/web/src/session-logic.ts`
- `packages/contracts/src/providerRuntime.ts`

The vendored `t3/ChatMarkdown.jsx` and `t3/MessagesTimeline.jsx` components are
imported by the viewer entrypoint. App-only editor, server-state, preview,
virtual-list, checkpoint, and diff integrations are excluded at that explicit
boundary; the row components, interactions, tool vocabulary, Lucide icons, and
Markdown pipeline come from the files above. T3 Code
is Copyright (c) 2026 T3 Tools Inc. and licensed under the MIT License; see
`LICENSE` in this directory.

Published transcript pages use T3 Code's canonical provider-runtime item
vocabulary (`user_message`, `assistant_message`, `command_execution`,
`file_change`, `web_search`, and the other tool lifecycle item types).

The viewer is deliberately standalone and read-only.
