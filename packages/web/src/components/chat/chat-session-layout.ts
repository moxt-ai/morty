/** Shared horizontal rhythm for the Mobius session pane (messages, composer, cards). */
const chatSessionContentInsetClassName = "px-3 sm:px-6";

export const chatSessionColumnClassName = `mx-auto w-full min-w-0 max-w-[920px] ${chatSessionContentInsetClassName}`;

export const chatSessionMessageScrollClassName =
    "min-h-0 flex-1 overflow-y-auto pt-6 pb-[72px] -mb-4 [scrollbar-color:#d4d7db_transparent] [scrollbar-width:thin] sm:pt-10";

export const chatSessionMessageColumnClassName = `${chatSessionColumnClassName} font-inter text-foreground`;

export const chatSessionComposerClassName =
    "relative z-10 m-0 w-full min-w-0 max-w-[920px] shrink-0 px-0 sm:mx-3 sm:mt-0 sm:mb-3 sm:w-[calc(100%-24px)]";

export const chatSessionPaneSectionClassName =
    "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden mb-2 ml-2 mr-2 mt-0 motion-reduce:animate-none sm:animate-cloud-enter sm:rounded-t-md sm:rounded-b-[32px] sm:border sm:border-white sm:bg-card/90 sm:shadow-module sm:backdrop-blur sm:my-2 sm:ml-0 sm:mr-2";

export const chatSessionMessageItemClassName = "mt-4 first:mt-0";
