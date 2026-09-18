import type { NativeSessionEntry, NativeSessionResult, SessionReadyEvent } from "@moxt-ai/mobius-sdk/channel";

export interface OpenMobiusSession {
    readonly agentRef: string;
    readonly result:
        | Extract<NativeSessionResult, { readonly ready: unknown }>
        | {
              readonly action: "conversation";
              readonly ready: SessionReadyEvent;
              readonly targetSessionId: string;
              readonly history: { readonly status: "unavailable" };
          };
    readonly entry: NativeSessionEntry;
}
