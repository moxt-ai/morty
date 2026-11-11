import { z } from "zod";
import { MAX_WORKSPACE_PATH_LENGTH } from "../../shared/directory.ts";

import { identifierStringSchema as IDENTIFIER } from "../../shared/identifier.ts";
import { decodeZodMessage as decode, encodeZodMessage as encode } from "../../shared/message-codec.ts";
import { sessionConfigOptionsSchema, sessionConfigurationSelectionsSchema } from "../configuration/index.ts";
import {
    DIRECTORY_PATH,
    sessionCapabilitiesSchema,
    sessionCommandSchema,
    sessionStatusSchema,
} from "../shared/index.ts";
import { nativeSessionTargetSchema } from "../shared/native-session-target.ts";

export const SESSION_PREPARE_KIND = "session.prepare";
export const SESSION_CREATE_KIND = "session.create";
export const SESSION_CREATION_READ_KIND = "session.creation.read";
export const SESSION_READY_KIND = "session.ready";
export const SESSION_LIST_KIND = "session.list";
export const SESSION_LISTED_KIND = "session.listed";
export const SESSION_QUERY_KIND = "session.query";
export const SESSION_QUERIED_KIND = "session.queried";
export const SESSION_RESTORE_KIND = "session.restore";
export const SESSION_RESTORED_KIND = "session.restored";
export const SESSION_CLOSE_KIND = "session.close";
export const SESSION_CLOSED_KIND = "session.closed";
export const SESSION_CLOSE_NOTICE_KIND = "session.close.notice";
export const SESSION_ARCHIVE_KIND = "session.archive";
export const SESSION_ARCHIVED_KIND = "session.archived";
/** Failure code of an operation that needs a Session the Computer has closed and nobody has reopened. */
export const SESSION_CLOSED_ERROR_CODE = "session_closed";
export const SESSION_STATUS_CHANGED_KIND = "session.status.changed";
export const SESSION_COMMANDS_UPDATED_KIND = "session.commands.updated";
export const SESSION_INFO_UPDATED_KIND = "session.info.updated";
export const SESSION_OPERATION_FAILED_KIND = "session.operation.failed";
export const SESSION_PROMPT_ACCEPTED_KIND = "session.prompt.accepted";

const sessionStatusChangedEventSchema = z
    .object({
        kind: z.literal(SESSION_STATUS_CHANGED_KIND),
        target: nativeSessionTargetSchema,
        status: sessionStatusSchema,
    })
    .readonly();

export type SessionStatusChangedEvent = z.infer<typeof sessionStatusChangedEventSchema>;

const sessionMetadataSchema = z
    .object({
        harness: IDENTIFIER,
        directory: DIRECTORY_PATH,
        directoryLabel: z.string().min(1).max(MAX_WORKSPACE_PATH_LENGTH),
        prompted: z.boolean(),
        sessionId: IDENTIFIER,
        target: nativeSessionTargetSchema,
        status: sessionStatusSchema,
        title: z.string().max(500),
        updatedAt: z.iso.datetime({ offset: true }),
    })
    .refine((entry) => entry.harness === entry.target.harness && entry.sessionId === entry.target.sessionId, {
        message: "Session metadata must describe its native pair",
    })
    .readonly();

export type SessionMetadata = z.infer<typeof sessionMetadataSchema>;

const sessionListCommandSchema = z
    .object({
        kind: z.literal(SESSION_LIST_KIND),
        limit: z.number().int().positive().max(500),
        requestId: IDENTIFIER,
    })
    .readonly();

export type SessionListCommand = z.infer<typeof sessionListCommandSchema>;

const sessionsListedEventSchema = z
    .object({
        entries: z.array(sessionMetadataSchema).max(500).readonly(),
        kind: z.literal(SESSION_LISTED_KIND),
        requestId: IDENTIFIER,
    })
    .readonly();

export type SessionsListedEvent = z.infer<typeof sessionsListedEventSchema>;

const sessionQueryCommandSchema = z
    .object({
        kind: z.literal(SESSION_QUERY_KIND),
        requestId: IDENTIFIER,
        targets: z.array(nativeSessionTargetSchema).min(1).max(500).readonly(),
    })
    .readonly();

export type SessionQueryCommand = z.infer<typeof sessionQueryCommandSchema>;

const sessionsQueriedEventSchema = z
    .object({
        entries: z.array(sessionMetadataSchema).max(500).readonly(),
        kind: z.literal(SESSION_QUERIED_KIND),
        requestId: IDENTIFIER,
    })
    .readonly();

export type SessionsQueriedEvent = z.infer<typeof sessionsQueriedEventSchema>;

const sessionRestoreCommandSchema = z
    .object({
        kind: z.literal(SESSION_RESTORE_KIND),
        requestId: IDENTIFIER,
        target: nativeSessionTargetSchema,
    })
    .readonly();

export type SessionRestoreCommand = z.infer<typeof sessionRestoreCommandSchema>;

const sessionCloseCommandSchema = z
    .object({
        kind: z.literal(SESSION_CLOSE_KIND),
        requestId: IDENTIFIER,
        target: nativeSessionTargetSchema,
    })
    .readonly();

export type SessionCloseCommand = z.infer<typeof sessionCloseCommandSchema>;

/**
 * Removes a Session from the Sessions this Computer holds, which are Morty's directory of Sessions on the computer. The
 * Computer closes the Session if it is open, then forgets its record; the Agent's own history of the Session stays, so
 * opening it from the Agent's sessions brings it back. Archiving a Session the Computer does not hold succeeds: the
 * Session is absent afterwards, as asked, so a retry after a lost answer succeeds too.
 */
const sessionArchiveCommandSchema = z
    .object({
        kind: z.literal(SESSION_ARCHIVE_KIND),
        requestId: IDENTIFIER,
        target: nativeSessionTargetSchema,
    })
    .readonly();

export type SessionArchiveCommand = z.infer<typeof sessionArchiveCommandSchema>;

/** Opens an existing Session with the Agent and directory the Computer holds it with. */
const sessionPrepareCommandSchema = z
    .object({
        /**
         * The complete settings a new Session starts with. The Computer applies them in dependency order as part of
         * creating the Session: it answers only once every selection holds, and otherwise creates nothing.
         */
        configurations: sessionConfigurationSelectionsSchema.optional(),
        kind: z.literal(SESSION_PREPARE_KIND),
        requestId: IDENTIFIER,
        sessionState: z.literal("provisioned").optional(),
        target: nativeSessionTargetSchema,
        /** Marks an inspection-only Session preparation. */
        transient: z.boolean().optional(),
    })
    .superRefine((command, context) => {
        if (command.transient === true && command.sessionState === "provisioned") {
            context.addIssue({
                code: "custom",
                message: "A transient Session cannot already be provisioned",
                path: ["sessionState"],
            });
        }
        if (
            command.configurations !== undefined &&
            (command.transient === true || command.sessionState !== undefined)
        ) {
            context.addIssue({
                code: "custom",
                message: "Only a Session being created states its initial settings",
                path: ["configurations"],
            });
        }
    })
    .readonly();

export type SessionPrepareCommand = z.infer<typeof sessionPrepareCommandSchema>;

const sessionCreateCommandSchema = z
    .object({
        kind: z.literal(SESSION_CREATE_KIND),
        requestId: IDENTIFIER,
        operationId: IDENTIFIER,
        harness: IDENTIFIER,
        directory: DIRECTORY_PATH,
        configurations: sessionConfigurationSelectionsSchema,
    })
    .readonly();

export type SessionCreateCommand = z.infer<typeof sessionCreateCommandSchema>;
export const decodeSessionCreateCommand = (encoded: string): SessionCreateCommand =>
    decode(encoded, sessionCreateCommandSchema);
export const encodeSessionCreateCommand = (message: SessionCreateCommand): string =>
    encode(message, sessionCreateCommandSchema);

const sessionCreationReadCommandSchema = z
    .object({
        kind: z.literal(SESSION_CREATION_READ_KIND),
        requestId: IDENTIFIER,
        operationId: IDENTIFIER,
    })
    .readonly();
export type SessionCreationReadCommand = z.infer<typeof sessionCreationReadCommandSchema>;
export const decodeSessionCreationReadCommand = (encoded: string): SessionCreationReadCommand =>
    decode(encoded, sessionCreationReadCommandSchema);
export const encodeSessionCreationReadCommand = (message: SessionCreationReadCommand): string =>
    encode(message, sessionCreationReadCommandSchema);

const computerTimingsSchema = z
    .array(
        z
            .object({
                durationMilliseconds: z.number().finite().nonnegative().max(120_000),
                name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
            })
            .readonly(),
    )
    .max(16)
    .readonly();

export const sessionReadyEventSchema = z
    .object({
        harness: IDENTIFIER,
        agentName: z.string().max(255),
        agentVersion: z.string().max(128),
        capabilities: sessionCapabilitiesSchema,
        commands: z.array(sessionCommandSchema).max(500).readonly(),
        configOptions: sessionConfigOptionsSchema,
        configurationRevision: IDENTIFIER,
        directory: DIRECTORY_PATH,
        directoryLabel: z.string().min(1).max(MAX_WORKSPACE_PATH_LENGTH),
        kind: z.literal(SESSION_READY_KIND),
        requestId: IDENTIFIER,
        restored: z.boolean(),
        computerTimings: computerTimingsSchema.optional(),
        target: nativeSessionTargetSchema,
    })
    .readonly();

export type SessionReadyEvent = z.infer<typeof sessionReadyEventSchema>;

const sessionRestoredEventSchema = z
    .object({
        entry: sessionMetadataSchema,
        target: nativeSessionTargetSchema,
        kind: z.literal(SESSION_RESTORED_KIND),
        ready: sessionReadyEventSchema,
        requestId: IDENTIFIER,
    })
    .readonly();

export type SessionRestoredEvent = z.infer<typeof sessionRestoredEventSchema>;

const sessionClosedEventSchema = z
    .object({
        kind: z.literal(SESSION_CLOSED_KIND),
        requestId: IDENTIFIER,
        target: nativeSessionTargetSchema,
    })
    .readonly();

export type SessionClosedEvent = z.infer<typeof sessionClosedEventSchema>;

/** Answers `session.archive` once the Computer no longer holds the Session. */
const sessionArchivedEventSchema = z
    .object({
        kind: z.literal(SESSION_ARCHIVED_KIND),
        requestId: IDENTIFIER,
        target: nativeSessionTargetSchema,
    })
    .readonly();

export type SessionArchivedEvent = z.infer<typeof sessionArchivedEventSchema>;

/**
 * Tells every observer that the Computer closed a Session. Unlike `session.closed`, which answers one
 * `session.close` request, a notice is not tied to a request, so it also reaches clients that did not ask.
 * `reason` is a sentence a client can show its user as is, such as "This Session was closed on request.".
 * Show it as plain text and don't branch on it: its wording can change between Computer versions.
 */
const sessionCloseNoticeEventSchema = z
    .object({
        kind: z.literal(SESSION_CLOSE_NOTICE_KIND),
        reason: z.string().min(1).max(500),
        target: nativeSessionTargetSchema,
    })
    .readonly();

export type SessionCloseNoticeEvent = z.infer<typeof sessionCloseNoticeEventSchema>;

const sessionCommandsUpdatedEventSchema = z
    .object({
        commands: z.array(sessionCommandSchema).max(500).readonly(),
        kind: z.literal(SESSION_COMMANDS_UPDATED_KIND),
        target: nativeSessionTargetSchema,
    })
    .readonly();

export type SessionCommandsUpdatedEvent = z.infer<typeof sessionCommandsUpdatedEventSchema>;

const sessionInfoUpdatedEventSchema = z
    .object({
        kind: z.literal(SESSION_INFO_UPDATED_KIND),
        computerId: IDENTIFIER.optional(),
        target: nativeSessionTargetSchema,
        title: z.string().max(500).nullable(),
        updatedAt: z.string().max(128),
    })
    .readonly();

export type SessionInfoUpdatedEvent = z.infer<typeof sessionInfoUpdatedEventSchema>;

const sessionOperationFailedEventSchema = z
    .object({
        code: IDENTIFIER,
        kind: z.literal(SESSION_OPERATION_FAILED_KIND),
        message: z.string().min(1).max(500),
        requestId: IDENTIFIER,
        computerTimings: computerTimingsSchema.optional(),
        target: nativeSessionTargetSchema.optional(),
    })
    .readonly();

export type SessionOperationFailedEvent = z.infer<typeof sessionOperationFailedEventSchema>;

/**
 * Answers a prompt: it entered the Session's queue, started running, or had already settled before it started (for
 * example when it was withdrawn, or when a retry finds it settled). A prompt is its own request, so `requestId` is
 * the prompt's command identifier. A prompt that failed before it started is answered by `session.operation.failed`.
 */
const sessionPromptAcceptedEventSchema = z
    .object({
        kind: z.literal(SESSION_PROMPT_ACCEPTED_KIND),
        requestId: IDENTIFIER,
        target: nativeSessionTargetSchema,
        state: z.enum(["queued", "running", "settled"]),
    })
    .readonly();

export type SessionPromptAcceptedEvent = z.infer<typeof sessionPromptAcceptedEventSchema>;

export const decodeSessionListCommand = (encoded: string): SessionListCommand =>
    decode(encoded, sessionListCommandSchema);
export const encodeSessionListCommand = (message: SessionListCommand): string =>
    encode(message, sessionListCommandSchema);
export const decodeSessionsListedEvent = (encoded: string): SessionsListedEvent =>
    decode(encoded, sessionsListedEventSchema);
export const encodeSessionsListedEvent = (message: SessionsListedEvent): string =>
    encode(message, sessionsListedEventSchema);
export const decodeSessionQueryCommand = (encoded: string): SessionQueryCommand =>
    decode(encoded, sessionQueryCommandSchema);
export const encodeSessionQueryCommand = (message: SessionQueryCommand): string =>
    encode(message, sessionQueryCommandSchema);
export const decodeSessionsQueriedEvent = (encoded: string): SessionsQueriedEvent =>
    decode(encoded, sessionsQueriedEventSchema);
export const encodeSessionsQueriedEvent = (message: SessionsQueriedEvent): string =>
    encode(message, sessionsQueriedEventSchema);
export const decodeSessionRestoreCommand = (encoded: string): SessionRestoreCommand =>
    decode(encoded, sessionRestoreCommandSchema);
export const encodeSessionRestoreCommand = (message: SessionRestoreCommand): string =>
    encode(message, sessionRestoreCommandSchema);
export const decodeSessionRestoredEvent = (encoded: string): SessionRestoredEvent =>
    decode(encoded, sessionRestoredEventSchema);
export const encodeSessionRestoredEvent = (message: SessionRestoredEvent): string =>
    encode(message, sessionRestoredEventSchema);
export const decodeSessionCloseCommand = (encoded: string): SessionCloseCommand =>
    decode(encoded, sessionCloseCommandSchema);
export const encodeSessionCloseCommand = (message: SessionCloseCommand): string =>
    encode(message, sessionCloseCommandSchema);
export const decodeSessionClosedEvent = (encoded: string): SessionClosedEvent =>
    decode(encoded, sessionClosedEventSchema);
export const encodeSessionClosedEvent = (message: SessionClosedEvent): string =>
    encode(message, sessionClosedEventSchema);
export const decodeSessionArchiveCommand = (encoded: string): SessionArchiveCommand =>
    decode(encoded, sessionArchiveCommandSchema);
export const encodeSessionArchiveCommand = (message: SessionArchiveCommand): string =>
    encode(message, sessionArchiveCommandSchema);
export const decodeSessionArchivedEvent = (encoded: string): SessionArchivedEvent =>
    decode(encoded, sessionArchivedEventSchema);
export const encodeSessionArchivedEvent = (message: SessionArchivedEvent): string =>
    encode(message, sessionArchivedEventSchema);
export const decodeSessionCloseNoticeEvent = (encoded: string): SessionCloseNoticeEvent =>
    decode(encoded, sessionCloseNoticeEventSchema);
export const encodeSessionCloseNoticeEvent = (message: SessionCloseNoticeEvent): string =>
    encode(message, sessionCloseNoticeEventSchema);
export const decodeSessionStatusChangedEvent = (encoded: string): SessionStatusChangedEvent =>
    decode(encoded, sessionStatusChangedEventSchema);
export const encodeSessionStatusChangedEvent = (message: SessionStatusChangedEvent): string =>
    encode(message, sessionStatusChangedEventSchema);
export const decodeSessionPrepareCommand = (encoded: string): SessionPrepareCommand =>
    decode(encoded, sessionPrepareCommandSchema);
export const encodeSessionPrepareCommand = (message: SessionPrepareCommand): string =>
    encode(message, sessionPrepareCommandSchema);
export const decodeSessionReadyEvent = (encoded: string): SessionReadyEvent => decode(encoded, sessionReadyEventSchema);
export const encodeSessionReadyEvent = (message: SessionReadyEvent): string => encode(message, sessionReadyEventSchema);
export const decodeSessionCommandsUpdatedEvent = (encoded: string): SessionCommandsUpdatedEvent =>
    decode(encoded, sessionCommandsUpdatedEventSchema);
export const encodeSessionCommandsUpdatedEvent = (message: SessionCommandsUpdatedEvent): string =>
    encode(message, sessionCommandsUpdatedEventSchema);
export const decodeSessionInfoUpdatedEvent = (encoded: string): SessionInfoUpdatedEvent =>
    decode(encoded, sessionInfoUpdatedEventSchema);
export const encodeSessionInfoUpdatedEvent = (message: SessionInfoUpdatedEvent): string =>
    encode(message, sessionInfoUpdatedEventSchema);
export const decodeSessionOperationFailedEvent = (encoded: string): SessionOperationFailedEvent =>
    decode(encoded, sessionOperationFailedEventSchema);
export const encodeSessionOperationFailedEvent = (message: SessionOperationFailedEvent): string =>
    encode(message, sessionOperationFailedEventSchema);
export const decodeSessionPromptAcceptedEvent = (encoded: string): SessionPromptAcceptedEvent =>
    decode(encoded, sessionPromptAcceptedEventSchema);
export const encodeSessionPromptAcceptedEvent = (message: SessionPromptAcceptedEvent): string =>
    encode(message, sessionPromptAcceptedEventSchema);
