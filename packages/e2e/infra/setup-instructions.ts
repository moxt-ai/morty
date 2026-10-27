import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SetupHost, SetupRuntime, runSetup as setup } from "../../setup/src/setup.ts";
import { object, text } from "./chat-api.ts";

function isSetupModule(value: unknown): value is { readonly runSetup: typeof setup } {
    return value !== null && typeof value === "object" && "runSetup" in value && typeof value.runSetup === "function";
}

export async function followSetupInstructions(options: {
    readonly clock?: SetupHost["clock"];
    readonly cwd: string;
    readonly documents: string;
    readonly state: string;
    readonly harness: string;
    readonly instructionUrl: string;
    readonly runtime: SetupRuntime;
    /** The user explicitly approved replacing this Project and revoking its shared access. */
    readonly replaceProject?: string;
    /** The calling agent's shell environment, where its harness exposes the current session. */
    readonly agentEnvironment: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
}) {
    const url = new URL(options.instructionUrl);
    const document = await fetch(url, { signal: options.signal, redirect: "error" });
    assert.equal(document.status, 200);
    const markdown = await document.text();
    assert.ok(markdown.includes(`Chat origin: ${url.origin}`));
    const command = markdown.match(/^node <downloaded-setup\.mjs> (.+)$/mu)?.[1];
    assert.ok(command);
    const args = command.split(/\s+/u).map((argument) =>
        argument
            .replaceAll('"', "")
            .replaceAll("<absolute-current-working-directory>", options.cwd)
            .replaceAll("<own-harness-id>", options.harness)
            .replaceAll("<one-use-ticket>", url.searchParams.get("token") ?? ""),
    );
    const download = markdown.match(/https?:\/\/[^\s`]+\/setup\.mjs/u)?.[0];
    assert.ok(download);
    const response = await fetch(download, { signal: options.signal, redirect: "error" });
    assert.equal(response.status, 200);
    const script = join(options.documents, "setup.mjs");
    await writeFile(script, await response.text(), { mode: 0o600 });
    const bundle: unknown = await import(pathToFileURL(script).href);
    assert.ok(isSetupModule(bundle));
    const events: Readonly<Record<string, unknown>>[] = [];
    const exitCode = await bundle.runSetup(
        [...args, ...(options.replaceProject === undefined ? [] : ["--replace-project", options.replaceProject])],
        {
            ...(options.clock === undefined ? {} : { clock: options.clock }),
            state: options.state,
            documents: options.documents,
            agentEnvironment: options.agentEnvironment,
            emit: (event) => events.push(event),
            runtime: options.runtime,
            signal: options.signal,
        },
    );
    assert.equal(exitCode, 0, JSON.stringify(events));
    const ready = events.find((event) => event["status"] === "ready");
    assert.ok(ready);
    const configuration = object(
        JSON.parse(await readFile(join(options.state, "config.json"), "utf8")),
        "local configuration",
    );
    return {
        configuration,
        events,
        ready,
        identity: {
            botId: text(configuration["bot_id"], "saved Bot"),
            projectId: text(configuration["project_id"], "saved project"),
            userId: text(configuration["user_id"], "saved user"),
        },
    };
}
