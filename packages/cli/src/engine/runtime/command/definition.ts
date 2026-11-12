import type { ServiceToDaemonRequest } from "@morty-build/client/protocol";
import type { CommandContext } from "./context.ts";

/** The request of one kind the Relay sends this Computer. */
export type CommandMessage<K extends ServiceToDaemonRequest["kind"]> = Extract<
    ServiceToDaemonRequest,
    { readonly kind: K }
>;

/** Answers one kind of request the Relay sends this Computer. */
export type CommandHandler<K extends ServiceToDaemonRequest["kind"]> = (
    context: CommandContext,
    message: CommandMessage<K>,
) => void;
