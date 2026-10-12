# Dependency patches

## @shadcn/react 0.3.1

MessageScroller's content and viewport ResizeObservers defer `handleResize`
through requestAnimationFrame. ResizeObserver already runs before paint; this
extra frame lets growing workflow output paint at the old scroll position, then
jump back to the live edge. In the cancellation recording this occurs when the
tool-call section appears above an existing approval card.

Call the existing `handleResize` synchronously instead. Its existing follow,
manual-scroll, and message-anchor rules remain responsible for scroll behavior.
Both content and viewport resize callbacks use the same timing so a model-usage
header resize cannot produce the same delayed correction.

Regression coverage uses the real installed primitive (via the UI wrapper):
`pnpm --dir apps/desktop test src/components/message-scroller-timing.test.ts`.
It checks correction before the next animation frame and preservation of the
user's position after scrolling away from the live edge. Recheck this patch when
upgrading the dependency; remove it once upstream handles resize before paint.

The content MutationObserver also watches child-list changes throughout the
subtree and text-node updates. Tool results and streamed text update an existing
message rather than adding a direct child, so observing direct children alone
misses them. The same built-in `handleContentChange` now adjusts following or
anchoring before the next rendering opportunity. Resize handling remains for
CSS-only and viewport changes.
