/** Shared horizontal rhythm for the Mobius session pane (messages, composer, cards). */
const chatSessionContentInsetClassName = "px-3 sm:px-6";

/** Morty thin scrollbar styling used on overflow scroll regions. */
export const mortyThinScrollbarClassName = "[scrollbar-color:#d4d7db_transparent] [scrollbar-width:thin]";

export const chatSessionColumnClassName = `mx-auto w-full min-w-0 max-w-[920px] ${chatSessionContentInsetClassName}`;

/** Interaction cards keep a 12px inset at every breakpoint. */
export const chatSessionInteractionColumnClassName = "mx-auto w-full min-w-0 max-w-[920px] px-3";

export const chatSessionMessageScrollClassName = `min-h-0 flex-1 overflow-y-auto pt-6 pb-[calc(72px+var(--composer-overlay-block,0px))] -mb-4 ${mortyThinScrollbarClassName} sm:pt-10`;

export const chatSessionMessageColumnClassName = `${chatSessionColumnClassName} font-inter text-foreground`;

/** Desktop composer keeps 12px side gutters. Mobile is full width. */
export const chatSessionComposerClassName =
    "relative z-10 mx-auto w-full min-w-0 shrink-0 px-0 mb-3 sm:mt-0 sm:w-[min(920px,calc(100%-24px))]";

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
 */
export const chatSessionPaneSectionClassName = `relative z-20 ${chatSessionPaneFillClassName} mb-2 ml-2 mr-2 mt-0 sm:rounded-t-[20px] sm:rounded-b-[32px] sm:border-[1px] sm:border-white sm:bg-card/90 sm:shadow-module sm:my-2 sm:ml-0 sm:mr-2`;

/** One-time cloud module entrance on the session column; stays mounted across sends within a session. */
export const chatSessionPaneEnterClassName =
    "flex min-h-0 min-w-0 flex-1 flex-col motion-reduce:animate-none sm:animate-cloud-enter";

/** Session pane top bar: title on the left, execution controls on the right. */
export const chatSessionExecutionHeaderClassName = "flex h-12 shrink-0 items-center gap-4 px-4";

export const chatSessionMessageItemClassName = "mt-4 first:mt-0";

/** Agent output for one user turn (text, tools, thinking, completion notices). */
export const chatSessionAgentReplyGroupClassName = `${chatSessionMessageItemClassName} space-y-4 pb-8`;
