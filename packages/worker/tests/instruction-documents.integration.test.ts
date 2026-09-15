import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { expect, test } from "vitest";
import worker from "../src/application.ts";

test.each(["setup", "pair"])(
    "Given a configured Chat origin, When a user fetches %s instructions on another host, Then the instructions contain the configured URLs",
    async (name) => {
        const response = await worker.fetch(new Request(`https://preview.example/${name}.md?token=ticket`), {
            APP_ORIGIN: "https://chat.example",
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
        expect(response.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=300");
        const document = await response.text();
        expect(document).toContain('BASE_URL="https://chat.example"');
        expect(document).toContain("https://chat.example/setup.mjs");
        expect(document).not.toMatch(/\{\{.*\}\}|preview\.example|paradev\.biz|paraflow\.biz|token=ticket/);
    },
);

test("Given rendered pairing instructions at the edge, When users fetch different tickets, Then the CDN shares a token-free document cache", async () => {
    const bundle = await build({
        entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
        bundle: true,
        write: false,
        format: "esm",
        platform: "browser",
        target: "es2022",
        external: ["node:*", "cloudflare:*"],
        loader: { ".md": "text" },
    });
    const output = bundle.outputFiles[0];
    if (output === undefined) {
        throw new Error("Missing Worker bundle");
    }
    const runtime = new Miniflare(
        convertV4MiniflareOptions({
            modules: true,
            script: output.text,
            compatibilityDate: "2026-09-07",
            compatibilityFlags: ["nodejs_compat"],
            bindings: { APP_ORIGIN: "https://chat.example" },
        }),
    );
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

test.each(["https://custom.example", "http://localhost:5173"])(
    "Given no configured origin on %s, When a user fetches instructions, Then both documents use the request origin",
    async (origin) => {
        for (const name of ["setup", "pair"]) {
            const response = await worker.fetch(
                new Request(`${origin}/${name}.md`, { headers: { "X-Forwarded-Host": "other.example" } }),
                {},
            );
            expect(response.status).toBe(200);
            expect(await response.text()).toContain(`BASE_URL="${origin}"`);
        }
    },
);

test.each(["https://chat.example/path", "https://user:pass@chat.example", "javascript:alert(1)", "", 42])(
    "Given invalid origin configuration %s, When a user fetches instructions, Then the server rejects the configuration",
    async (origin) => {
        const response = await worker.fetch(new Request("https://preview.example/setup.md"), { APP_ORIGIN: origin });
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({
            error: { code: "INVALID_INSTRUCTION_ORIGIN", message: "The instruction origin is invalid." },
        });
    },
);
