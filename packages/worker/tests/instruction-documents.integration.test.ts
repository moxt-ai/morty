import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { expect, test } from "vitest";
import worker from "../src/application.ts";

const bundle = await build({
    entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["node:*", "cloudflare:*"],
    loader: { ".txt": "text", ".sql": "text" },
});
const output = bundle.outputFiles[0];
if (output === undefined) {
    throw new Error("Missing Worker bundle");
}
const workerScript = output.text;

function createRuntime(options: { readonly appOrigin?: string; readonly attachments?: boolean } = {}) {
    return new Miniflare(
        convertV4MiniflareOptions({
            modules: true,
            script: workerScript,
            compatibilityDate: "2026-09-07",
            compatibilityFlags: ["nodejs_compat"],
            ...(options.appOrigin === undefined ? {} : { bindings: { APP_ORIGIN: options.appOrigin } }),
            ...(options.attachments ? { r2Buckets: ["CHAT_ATTACHMENTS_APAC"] } : {}),
        }),
    );
}

test("Given a published setup artifact, When a user downloads the setup URL, Then the Worker serves the current R2 JavaScript", async () => {
    const runtime = createRuntime({ attachments: true });
    try {
        const missing = await runtime.dispatchFetch("https://chat.example/setup.mjs");
        expect(missing.status).toBe(503);
        expect(await missing.json()).toMatchObject({ error: { code: "SETUP_ARTIFACT_UNAVAILABLE" } });

        const bucket = await runtime.getR2Bucket("CHAT_ATTACHMENTS_APAC");
        const artifact = "console.log('published setup');\n";
        await bucket.put("artifacts/setup.mjs", artifact);
        const response = await runtime.dispatchFetch("https://chat.example/setup.mjs?token=ignored");
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
        expect(await response.text()).toBe(artifact);
    } finally {
        await runtime.dispose();
    }
});

test("Given the setup document, When users fetch it from configured and standalone origins, Then the rendered command is safe and current", async () => {
    const response = await worker.fetch(new Request("https://preview.example/setup.md?token=ticket"), {
        APP_ORIGIN: "https://chat.example",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=300");
    const document = await response.text();
    expect(document).toMatch(/^# Set up Morty\n/);
    expect(document).not.toContain("change-policy");
    expect(document).toContain("Chat origin: https://chat.example");
    expect(document).toContain("https://chat.example/setup.mjs");
    expect(document).not.toContain("/setup-help/");
    expect(document).toContain("local\napplication data directory");
    expect(document).not.toContain("Documents");
    expect(document).not.toContain("DOCUMENT_DIR");
    expect(document).not.toContain("MORTY_STATE_DIRECTORY");
    expect(document).not.toContain("```powershell");
    expect(document).not.toContain("```sh");
    expect(document).not.toMatch(/\{\{.*\}\}|preview\.example|paradev\.biz|paraflow\.biz|token=ticket/);
    expect(document).toContain("--harness <own-harness-id>");
    expect(document).toContain("never substitute another harness");

    for (const origin of ["https://custom.example", "http://localhost:5173"]) {
        const response = await worker.fetch(
            new Request(`${origin}/setup.md`, { headers: { "X-Forwarded-Host": "other.example" } }),
            {},
        );
        expect(response.status).toBe(200);
        expect(await response.text()).toContain(`Chat origin: ${origin}`);
    }

    for (const appOrigin of [
        "https://chat.example/path",
        "https://user:pass@chat.example",
        "javascript:alert(1)",
        "",
        42,
    ]) {
        const response = await worker.fetch(new Request("https://preview.example/setup.md"), {
            APP_ORIGIN: appOrigin,
        });
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({
            error: { code: "INVALID_INSTRUCTION_ORIGIN", message: "The instruction origin is invalid." },
        });
    }
});

test("Given rendered setup instructions at the edge, When users fetch different query strings, Then the CDN shares a query-free document cache", async () => {
    const runtime = createRuntime({ appOrigin: "https://chat.example" });
    try {
        const first = await runtime.dispatchFetch("https://preview.example/setup.md?token=first");
        expect(first.status).toBe(200);
        expect(first.headers.get("X-Instruction-Cache")).toBe("MISS");
        const document = await first.text();

        const second = await runtime.dispatchFetch("https://preview.example/setup.md?token=second");
        expect(second.headers.get("X-Instruction-Cache")).toBe("HIT");
        expect(await second.text()).toBe(document);
        expect(document).toContain("Chat origin: https://chat.example");
        expect(document).not.toMatch(/token=first|token=second/);

        const otherHost = await runtime.dispatchFetch("https://other.example/setup.md?token=third");
        expect(otherHost.headers.get("X-Instruction-Cache")).toBe("MISS");
    } finally {
        await runtime.dispose();
    }
});

test("Given setup replaced this computer's Project, When an agent follows the setup document, Then it tells the user that earlier links stopped working", async () => {
    const response = await worker.fetch(new Request("https://preview.example/setup.md"), {
        APP_ORIGIN: "https://chat.example",
    });
    const document = (await response.text()).replaceAll("\n", " ");

    expect(document).toContain('When `project` is `"replaced"`');
    expect(document).toContain("links and browsers from this computer's earlier Morty setup stopped working");
});

test("Given a missing saved connection, When an agent follows setup instructions, Then it asks before replacing and reports revoked or uncertain access even on failure", async () => {
    const response = await worker.fetch(new Request("https://preview.example/setup.md"), {
        APP_ORIGIN: "https://chat.example",
    });
    const document = (await response.text()).replaceAll("\n", " ");

    expect(document).toContain("PROJECT_REPLACEMENT_REQUIRED");
    expect(document).toContain("Merely asking to run setup or reconnect is not approval.");
    expect(document).toContain("--replace-project <projectId>");
    expect(document).toContain("Do not retry with this option automatically");
    expect(document).toContain("Do not wait for ready to report this access change.");
    expect(document).toContain("error.replacementAccess.message");
    expect(document).toContain("never say the old links are still valid");
});

test("Given the setup document, When an agent follows it, Then it neither passes nor asks the user for a session ID", async () => {
    const response = await worker.fetch(new Request("https://preview.example/setup.md"), {
        APP_ORIGIN: "https://chat.example",
    });
    const document = await response.text();
    const command = document.match(/^node <downloaded-setup\.mjs> (.+)$/mu)?.[1];

    expect(command).toContain("--harness <own-harness-id>");
    expect(command).not.toContain("--session-id");
    expect(document.replaceAll("\n", " ")).not.toMatch(/ask the user for (it|the session)/u);
});

test("Given Morty owns local Agent sessions, When the user asks to return to the computer, Then the setup document tells the Agent how to release every session", async () => {
    const response = await worker.fetch(new Request("https://preview.example/setup.md"), {
        APP_ORIGIN: "https://chat.example",
    });
    const document = (await response.text()).replaceAll("\n", " ");

    expect(document).toContain("run `mobius quit`");
    expect(document).toContain("Before running the command");
    expect(document).toContain("Codex: `codex resume`");
    expect(document).toContain("Claude Code: `claude --resume`");
    expect(document).toContain("Pi: `pi --resume`");
    expect(document).toContain("`mobius start`");
    expect(document).toContain("do not report that the command completed after invoking it");
});
