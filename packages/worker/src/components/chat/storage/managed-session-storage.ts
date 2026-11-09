import { nativeSessionKey } from "@morty-build/client/native-session";
import { decodeNativeSessionTarget, type NativeSessionTarget } from "@morty-build/client/protocol";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import * as v from "valibot";
import { createDatabase, type Database } from "../../../schema/project-do/database.ts";
import { chatManagedSession } from "../../../schema/project-do/index.ts";
import { PlatformProjectError, platformIdentifier } from "../../management/entity/platform-project.ts";

const summarySchema = v.pipe(
    v.object({
        createdAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
        computerId: platformIdentifier,
        userId: platformIdentifier,
        harness: platformIdentifier,
        sessionId: platformIdentifier,
    }),
    v.readonly(),
);

export class ManagedSessionStorage {
    readonly #database: unknown;
    constructor(database: unknown) {
        this.#database = database;
    }

    readonly #requireDatabase = (): Database => {
        const database = createDatabase(this.#database);
        if (database === null) {
            throw new PlatformProjectError("DATABASE_UNAVAILABLE", "Chat storage is unavailable.", 503);
        }
        return database;
    };

    readonly list = async (computerId: string, userId: string, signal: AbortSignal) => {
        signal.throwIfAborted();
        const result = await this.#requireDatabase()
            .select({
                createdAt: chatManagedSession.createdAt,
                computerId: chatManagedSession.computerId,
                userId: chatManagedSession.userId,
                harness: chatManagedSession.harness,
                sessionId: chatManagedSession.sessionId,
            })
            .from(chatManagedSession)
            .where(
                and(
                    eq(chatManagedSession.computerId, computerId),
                    eq(chatManagedSession.userId, userId),
                    eq(chatManagedSession.state, "active"),
                    isNotNull(chatManagedSession.harness),
                    isNotNull(chatManagedSession.sessionId),
                ),
            )
            .orderBy(desc(chatManagedSession.createdAt), chatManagedSession.resourceId);
        signal.throwIfAborted();
        return v.parse(v.array(summarySchema), result).map(({ harness, sessionId, ...summary }) => ({
            ...summary,
            target: { harness, sessionId },
        }));
    };

    /** A historical creation receipt never reopens a later archival. */
    readonly recordCreated = async (
        computerId: string,
        userId: string,
        target: NativeSessionTarget,
        signal: AbortSignal,
    ) => {
        await this.#write(computerId, userId, target, "created", signal);
    };

    /** An explicit import grants access again to an archived native Session. */
    readonly include = async (computerId: string, userId: string, target: NativeSessionTarget, signal: AbortSignal) => {
        await this.#write(computerId, userId, target, "imported", signal);
    };

    readonly #write = async (
        computerId: string,
        userId: string,
        target: NativeSessionTarget,
        origin: "created" | "imported",
        signal: AbortSignal,
    ) => {
        const value = v.parse(summarySchema, {
            ...decodeNativeSessionTarget(target),
            createdAt: Date.now(),
            computerId,
            userId,
        });
        signal.throwIfAborted();
        const insertion = this.#requireDatabase()
            .insert(chatManagedSession)
            .values({
                computerId: value.computerId,
                userId: value.userId,
                resourceId: nativeSessionKey(target),
                harness: value.harness,
                sessionId: value.sessionId,
                createdAt: value.createdAt,
            });
        if (origin === "created") {
            await insertion.onConflictDoNothing().run();
        } else {
            await insertion
                .onConflictDoUpdate({
                    target: [chatManagedSession.computerId, chatManagedSession.userId, chatManagedSession.resourceId],
                    set: { state: "active" },
                })
                .run();
        }
        signal.throwIfAborted();
    };

    readonly ownsSession = async (
        computerId: string,
        userId: string,
        target: NativeSessionTarget,
        signal: AbortSignal,
    ): Promise<boolean> => {
        signal.throwIfAborted();
        const result = await this.#requireDatabase()
            .select({ id: chatManagedSession.resourceId })
            .from(chatManagedSession)
            .where(
                and(
                    eq(chatManagedSession.computerId, computerId),
                    eq(chatManagedSession.userId, userId),
                    eq(chatManagedSession.state, "active"),
                    eq(chatManagedSession.harness, decodeNativeSessionTarget(target).harness),
                    eq(chatManagedSession.sessionId, target.sessionId),
                ),
            )
            .get();
        signal.throwIfAborted();
        return result !== undefined;
    };

    readonly findNative = async (
        projectId: string,
        userId: string,
        target: NativeSessionTarget,
        signal: AbortSignal,
    ): Promise<NativeSessionTarget | null> => {
        signal.throwIfAborted();
        const found = await this.#requireDatabase()
            .select({ id: chatManagedSession.resourceId })
            .from(chatManagedSession)
            .where(
                and(
                    eq(chatManagedSession.computerId, projectId),
                    eq(chatManagedSession.userId, userId),
                    eq(chatManagedSession.state, "active"),
                    eq(chatManagedSession.harness, target.harness),
                    eq(chatManagedSession.sessionId, target.sessionId),
                ),
            )
            .get();
        signal.throwIfAborted();
        return found === undefined ? null : decodeNativeSessionTarget(target);
    };

    readonly archive = async (
        computerId: string,
        userId: string,
        target: NativeSessionTarget,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        await this.#requireDatabase()
            .update(chatManagedSession)
            .set({ state: "archived" })
            .where(
                and(
                    eq(chatManagedSession.computerId, computerId),
                    eq(chatManagedSession.userId, userId),
                    eq(chatManagedSession.state, "active"),
                    eq(chatManagedSession.harness, decodeNativeSessionTarget(target).harness),
                    eq(chatManagedSession.sessionId, target.sessionId),
                ),
            )
            .run();
        signal.throwIfAborted();
    };
}
