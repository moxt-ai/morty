import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { DurableObjectSqlDatabase } from "@morty-build/relay-core";
import { applyDurableObjectMigrations } from "@morty-build/relay-core/durable-object-migrations";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { runtimeConnectionDurableObjectMigrations } from "../../relay-core/src/generated/runtime-connection-do-migrations.ts";
import { NativeSessionForkStorage } from "../../relay-core/src/storage/native-session-fork-storage.ts";

afterEach(() => vi.useRealTimers());
afterAll(async () => await abortAllDurableObjects());

it("Given pre-recovery Fork receipts, When upgraded and written by either deployment, Then completed results and unknown attempts retain their meaning", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-28T02:00:00Z"), toFake: ["Date"] });
    await runInDurableObject(
        env.COMPUTER_RELAY.getByName(`fork-migration-${crypto.randomUUID()}`),
        async (_instance, state) => {
            // Retained 7110e99 schema and read/write contract, independent of the current Drizzle model.
            await state.storage.deleteAll();
            const retained = runtimeConnectionDurableObjectMigrations.findIndex(
                (migration) => migration.name === "0005_glamorous_stick.sql",
            );
            applyDurableObjectMigrations(
                state.storage,
                runtimeConnectionDurableObjectMigrations.slice(0, retained + 1),
                "connections/",
            );
            const oldWrite = (id: string, result: string | null) =>
                state.storage.sql.exec(
                    "INSERT INTO native_session_forks (project_id, operation_id, request_hash, result_json) VALUES (?, ?, ?, ?)",
                    "project",
                    id,
                    "hash",
                    result,
                );
            const oldRead = (id: string) =>
                state.storage.sql
                    .exec(
                        "SELECT request_hash, result_json FROM native_session_forks WHERE project_id = ? AND operation_id = ?",
                        "project",
                        id,
                    )
                    .one();
            const completed = JSON.stringify({ source: "original source", result: "original result" });
            oldWrite("old-completed", completed);
            oldWrite("old-unknown", null);
            applyDurableObjectMigrations(state.storage, runtimeConnectionDurableObjectMigrations, "connections/");
            const receipts = new NativeSessionForkStorage(new DurableObjectSqlDatabase(state.storage));
            expect(receipts.read("project", "old-completed")).toEqual({
                requestHash: "hash",
                resultJson: completed,
                attemptJson: null,
            });
            expect(receipts.read("project", "old-unknown")).toEqual({
                requestHash: "hash",
                resultJson: null,
                attemptJson: null,
            });
            const attempt = JSON.stringify({ source: "resolved source", targetSessionId: "first-target" });
            receipts.start("project", "new", "hash", attempt);
            expect(oldRead("new")).toEqual({ request_hash: "hash", result_json: null });
            expect(receipts.read("project", "new")?.attemptJson).toBe(attempt);
            receipts.complete("project", "new", completed);
            expect(oldRead("new")).toEqual({ request_hash: "hash", result_json: completed });
            expect(receipts.read("project", "new")?.attemptJson).toBeNull();
            oldWrite("rollback-unknown", null);
            expect(receipts.read("project", "rollback-unknown")).toEqual({
                requestHash: "hash",
                resultJson: null,
                attemptJson: null,
            });
        },
    );
});
