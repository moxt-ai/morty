import {
    type SESSION_LIST_KIND,
    SESSION_LISTED_KIND,
    SESSION_QUERIED_KIND,
    type SESSION_QUERY_KIND,
} from "@morty-build/client/protocol";
import type { CommandHandler } from "../definition.ts";
import { reportOperationFailure, send } from "../transport.ts";

export const handleSessionList: CommandHandler<typeof SESSION_LIST_KIND> = (
    { nativeSessions, signal, socket },
    message,
): void => {
    void nativeSessions
        .listSessions(message.limit, signal)
        .then((entries) => {
            send(socket, { entries, kind: SESSION_LISTED_KIND, requestId: message.requestId });
        })
        .catch((error: unknown) => {
            reportOperationFailure(socket, message.requestId, undefined, error);
        });
};

export const handleSessionQuery: CommandHandler<typeof SESSION_QUERY_KIND> = (
    { nativeSessions, signal, socket },
    message,
): void => {
    void nativeSessions
        .querySessions(message.targets, signal)
        .then((entries) => {
            send(socket, { entries, kind: SESSION_QUERIED_KIND, requestId: message.requestId });
        })
        .catch((error: unknown) => {
            reportOperationFailure(socket, message.requestId, undefined, error);
        });
};
