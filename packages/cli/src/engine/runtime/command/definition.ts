import type { ServiceToDaemonMessage } from "@morty-build/client/protocol";
import type { CommandContext } from "./context.ts";

export interface RuntimeCommand {
    readonly kind: ServiceToDaemonMessage["kind"];
    readonly handle: (context: CommandContext, message: ServiceToDaemonMessage) => void;
    readonly settle?: () => Promise<void>;
}
