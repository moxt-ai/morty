/** Shared horizontal rhythm for the Mobius session pane (messages, composer, cards). */
export const chatSessionContentInsetClassName = "px-3 sm:px-6";

export const chatSessionColumnClassName = `mx-auto w-full min-w-0 max-w-[920px] ${chatSessionContentInsetClassName}`;

export const chatSessionMessageScrollClassName =
    "min-h-0 flex-1 overflow-y-auto py-6 [scrollbar-color:#d4d7db_transparent] [scrollbar-width:thin] sm:py-10";

export const chatSessionMessageColumnClassName = `${chatSessionColumnClassName} font-inter text-foreground`;

export const chatSessionComposerClassName =
    "mx-auto mt-0 mb-0 w-full min-w-0 max-w-[920px] shrink-0 px-0 sm:mb-4 sm:px-4";

export const chatSessionPaneSectionClassName =
    "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden mb-2 ml-2 mr-2 mt-0 motion-reduce:animate-none sm:animate-cloud-enter sm:rounded-t-md sm:rounded-b-[32px] sm:border sm:border-white sm:bg-card/90 sm:shadow-module sm:backdrop-blur sm:my-2 sm:ml-0 sm:mr-2";

export const chatSessionMessageItemClassName = "my-8 first:mt-0 last:mb-0";
