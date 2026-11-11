import type { AcpContentExternalizer } from "../../content/content-externalizer.ts";
import { type HarnessCallbackParams, HarnessClientEvents } from "../harness-client-events.ts";
import type { HarnessLifetime } from "../harness-session.ts";
import { fitCodexToolEvent, prepareCodexToolUpdate } from "./tool-event.ts";

/** Preserve Codex media extraction and payload bounds around shared ordered delivery. */
export function codexClientCallbacks(
    params: HarnessCallbackParams,
    externalizer: Pick<AcpContentExternalizer, "update">,
    lifetime: HarnessLifetime,
) {
    const events = new HarnessClientEvents(
        "codex",
        {
            ...params,
            externalizeUpdate: async (sessionId, update, signal) => {
                const prepared = prepareCodexToolUpdate(update);
                const result =
                    params.externalizeUpdate === undefined
                        ? await externalizer.update({ harness: "codex", sessionId }, prepared, signal)
                        : await params.externalizeUpdate(sessionId, prepared, signal);
                return { ...result, events: result.events.map(fitCodexToolEvent) };
            },
        },
        externalizer,
        lifetime,
    );
    return {
        onSessionUpdate: events.receive,
        interactions: { onPermission: events.permission, onElicitation: events.elicitation },
        drained: events.drained,
    };
}
