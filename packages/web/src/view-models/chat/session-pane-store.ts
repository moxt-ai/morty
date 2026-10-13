import type { OpenMobiusSession } from "./open-session.ts";
import { createSessionPaneModel as createSessionPaneModelV2 } from "./session-pane-store-v2.ts";
import {
    createSessionPaneModel as createSessionPaneModelV3,
    sessionPanePresentation,
} from "./session-pane-store-v3.ts";

type SessionPaneModelOptions = Parameters<typeof createSessionPaneModelV3>[0];

export { sessionPanePresentation };

export function createSessionPaneModel(options: SessionPaneModelOptions) {
    return sessionProtocolVersion(options.session) === 3
        ? createSessionPaneModelV3(options)
        : createSessionPaneModelV2(options);
}

function sessionProtocolVersion(session: OpenMobiusSession): 2 | 3 {
    return session.result.ready.sessionProtocolVersion === 3 ? 3 : 2;
}
