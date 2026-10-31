# T3 Code viewer attribution

This static transcript viewer vendors a read-only extraction of
[T3 Code](https://github.com/pingdotgg/t3code), revision
`d2d1e4f50ef856f940d91858915368500657b0b7` (2026-10-30). Earlier releases
vendored revision `5ca32661b7dc8d512305c3bb9237d994a41a1af5`.

Upstream sources:

- `apps/web/src/components/chat/MessagesTimeline.tsx` and `MessagesTimeline.logic.ts`
  (row derivation: work bursts, user-message bursts, assistant meta placement)
- `apps/web/src/components/chat/TimelineUserMessageRow.tsx`
- `apps/web/src/components/chat/TimelineAssistantRows.tsx`
- `apps/web/src/components/chat/TimelineWorkGroupRows.tsx`, `TimelineWorkEntryRow.tsx`,
  `TimelineWorkEntryRow.logic.ts`, `TimelineToolActivityIcon.tsx`,
  `TimelineRowParts.tsx`, and `WorkLog.tsx`
- `apps/web/src/components/ChatMarkdown.tsx` and `apps/web/src/components/chat/MarkdownTable.tsx`
- `apps/web/src/index.css` (theme tokens, chat-markdown and table rules)
- `packages/client-runtime/src/work-log/presentation.ts` (`toolGroupAction`,
  `summarizeToolGroup`, `toolGroupSummaryKind`) and `commandLabel.ts`
  (`commandDisplayText`)
- `packages/shared/src/toolActivity.ts` (`classifyToolActivity`,
  `formatSearchToolLabel`, `formatReadToolLabel`, `dynamicToolTitle`)
- `packages/contracts/src/providerRuntime.ts` (item and status vocabulary)

The extraction lives in `t3/MessagesTimeline.jsx`, `t3/ChatMarkdown.jsx`, and
`t3/workLogPresentation.js`, and is imported by the viewer entrypoint. App-only
state, virtualization, approvals, rewind, diff panels, syntax highlighting, and
math rendering are excluded at that boundary.

Published transcript pages use T3 Code's provider-runtime item vocabulary
(`user_message`, `assistant_message`, `command_execution`, `file_change`,
`web_search`, and the other tool lifecycle item types).

T3 Code is Copyright (c) 2026 T3 Tools Inc. and licensed under the MIT License;
see `LICENSE` in this directory.
