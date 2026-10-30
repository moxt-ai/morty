/** Message column horizontal rhythm: 20px on mobile, 24px from `sm:` up. */
const chatSessionContentInsetClassName = "px-5 sm:px-6";

/** Morty thin scrollbar styling used on overflow scroll regions. */
export const mortyThinScrollbarClassName = "[scrollbar-color:#d4d7db_transparent] [scrollbar-width:thin]";

export const chatSessionColumnClassName = `mx-auto w-full min-w-0 max-w-[920px] ${chatSessionContentInsetClassName}`;

/** Interaction cards keep a 12px inset at every breakpoint. */
export const chatSessionInteractionColumnClassName = "mx-auto w-full min-w-0 max-w-[920px] px-3";

/**
 * `--composer-notice-tuck` sinks the message tail under the frosted composer
 * notice while one is up; the variable stays 0 otherwise.
 */
export const chatSessionMessageScrollClassName = `min-h-0 flex-1 overflow-y-auto pt-6 pb-[72px] -mb-4 [&>:last-child]:mb-[var(--composer-notice-tuck,0px)] ${mortyThinScrollbarClassName} sm:pt-10`;

export const chatSessionMessageColumnClassName = `${chatSessionColumnClassName} font-inter text-foreground`;

/**
 * Composer keeps 12px side gutters at every breakpoint (on `sm:` the width calc
 * provides them). The pane section uses `overflow-clip`, so a full-bleed card
 * would have its shadow clipped away at the section edge.
 *
 * The bottom margin clears the iOS home indicator. iOS keeps reporting the full
 * safe-area inset while the software keyboard covers the indicator, so on touch
 * devices a focused textarea drops back to the plain 12px gutter instead of
 * floating above the keyboard. Fine-pointer devices keep the inset because focus
 * there does not imply a software keyboard.
 */
export const chatSessionComposerClassName =
    "relative z-10 mx-auto w-full min-w-0 shrink-0 px-3 mb-[max(0.75rem,env(safe-area-inset-bottom))] pointer-coarse:has-[textarea:focus]:mb-3 sm:mt-0 sm:px-0 sm:w-[min(920px,calc(100%-24px))]";

/**
 * Fills the conversation card. Background, radius, and the outer inset stay on
 * the parent section so they are not painted twice.
 *
 * `overflow-clip` rather than `overflow-hidden`: a clipped box cannot hold a
 * scroll offset, so revealing a control deep in the pane (focus, find-in-page,
 * scrollIntoView) can never scroll the header and composer out of the card.
 */
export const chatSessionPaneFillClassName = "flex min-h-0 min-w-0 flex-1 flex-col overflow-clip";

/**
 * No backdrop-filter here. It would make this pane the backdrop root, and the
 * composer notice could no longer blur the messages scrolling behind it.
 *
 * Mobile sits flush to the viewport edges; only the desktop card keeps insets.
 */
export const chatSessionPaneSectionClassName = `relative z-20 ${chatSessionPaneFillClassName} sm:rounded-t-[20px] sm:rounded-b-[32px] sm:border-[1px] sm:border-white sm:bg-card/90 sm:shadow-module sm:my-2 sm:ml-0 sm:mr-2`;

/** One-time cloud module entrance on the session column; stays mounted across sends within a session. */
export const chatSessionPaneEnterClassName =
    "flex min-h-0 min-w-0 flex-1 flex-col motion-reduce:animate-none sm:animate-cloud-enter";

/** Session pane top bar: title on the left, execution controls on the right. */
export const chatSessionExecutionHeaderClassName = "flex h-12 shrink-0 items-center gap-4 px-4";

export const chatSessionMessageItemClassName = "mt-4 first:mt-0";

/**
 * Agent output for one user turn (text, tools, thinking, completion notices).
 * Children carry per-type vertical margins (see replyItemMarginClassName in
 * the session pane) instead of a uniform gap, so adjacent margins collapse to
 * the larger value. The 10px top margin keeps the reply tight under the strip
 * the user message reserves for its copy button; `pb-8` (12px while
 * generating) is the turn's bottom breathing room.
 */
export const chatSessionAgentReplyGroupClassName = "mt-2.5 first:mt-0 pb-8";
