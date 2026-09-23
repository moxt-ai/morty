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
    loader: { ".md": "text", ".sql": "text" },
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

test("Given setup and pairing documents, When users fetch them from configured and standalone origins, Then every rendered command is safe and current", async () => {
    const documents = new Map<string, string>();
    for (const name of ["setup", "pair"]) {
        const response = await worker.fetch(new Request(`https://preview.example/${name}.md?token=ticket`), {
            APP_ORIGIN: "https://chat.example",
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
        expect(response.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=300");
        const document = await response.text();
        documents.set(name, document);
        expect(document).toContain('BASE_URL="https://chat.example"');
        expect(document).toContain('BASE_URL="https://chat.example"\n');
        expect(document).not.toMatch(/^BASE_URL=.*\bnode\b/mu);
        expect(document).toContain("https://chat.example/setup.mjs");
        expect(document).not.toMatch(/\{\{.*\}\}|preview\.example|paradev\.biz|paraflow\.biz|token=ticket/);
    }
    expect(documents.get("pair")).toContain("existing user, Bot, and workspace");
    expect(documents.get("pair")).toContain('TOKEN="<one-use token from the supplied URL>"');
    expect(documents.get("pair")).toContain('node "$SCRIPT_DIR/setup.mjs" pair --base-url "$BASE_URL"');
    expect(documents.get("pair")).toContain("Mobius owns Runtime connection state and identifiers");
    expect(documents.get("setup")).toContain('SESSION_ID="<current harness session ID>"');
    expect(documents.get("setup")).toContain('node "$SCRIPT_DIR/setup.mjs" setup --base-url "$BASE_URL"');
    expect(documents.get("setup")).toContain("first reconnects a Mobius-managed");
    expect(documents.get("setup")).toContain("Do not retain or back up App");

    for (const origin of ["https://custom.example", "http://localhost:5173"]) {
        for (const name of ["setup", "pair"]) {
            const response = await worker.fetch(
                new Request(`${origin}/${name}.md`, { headers: { "X-Forwarded-Host": "other.example" } }),
                {},
            );
            expect(response.status).toBe(200);
            expect(await response.text()).toContain(`BASE_URL="${origin}"`);
        }
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

test("Given rendered pairing instructions at the edge, When users fetch different tickets, Then the CDN shares a token-free document cache", async () => {
    const runtime = createRuntime({ appOrigin: "https://chat.example" });
    try {
        const first = await runtime.dispatchFetch("https://preview.example/pair.md?token=first");
        expect(first.status).toBe(200);
        expect(first.headers.get("X-Instruction-Cache")).toBe("MISS");
        const document = await first.text();

        const second = await runtime.dispatchFetch("https://preview.example/pair.md?token=second");
        expect(second.headers.get("X-Instruction-Cache")).toBe("HIT");
        expect(await second.text()).toBe(document);
        expect(document).toContain('BASE_URL="https://chat.example"');
        expect(document).not.toMatch(/token=first|token=second/);

        const otherHost = await runtime.dispatchFetch("https://other.example/pair.md?token=third");
        expect(otherHost.headers.get("X-Instruction-Cache")).toBe("MISS");
    } finally {
        await runtime.dispose();
    }
});
