import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, test } from "vitest";
import { unstable_readConfig } from "wrangler";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const configuration = unstable_readConfig({ config: join(root, "wrangler.jsonc") });
const assets = configuration.assets;
if (assets === undefined) {
    throw new Error("Missing public assets configuration");
}
const directory = await mkdtemp(join(tmpdir(), "morty-web-pages-"));
await cp(join(root, "public"), directory, { recursive: true });
await cp(join(root, "index.html"), join(directory, "index.html"));
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
const runtime = new Miniflare(
    convertV4MiniflareOptions({
        modules: true,
        script: output.text,
        compatibilityDate: configuration.compatibility_date,
        compatibilityFlags: ["nodejs_compat"],
        assets: {
            directory,
            binding: assets.binding,
            run_worker_first: assets.run_worker_first,
            routerConfig: { has_user_worker: true },
            assetConfig: { not_found_handling: assets.not_found_handling },
        },
    }),
);

beforeAll(async () => {
    await runtime.ready;
});
afterAll(async () => {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
});

for (const navigation of [false, true]) {
    const headers = navigation ? { "Sec-Fetch-Mode": "navigate" } : {};
    test(`Given an unknown URL, When ${navigation ? "a browser navigates to" : "an agent fetches"} it, Then the server returns a real 404`, async () => {
        for (const path of [
            "/setpu.md",
            "/privacy",
            "/docs",
            "/sitemap.xml",
            "/unknown-page",
            "/assets/missing.js",
            "/chat/unknown",
            "/chatty",
            "/continue/unknown",
            "/continue/preview/ready/extra",
            "/playground/buttons/extra",
            "/morty/api/unknown",
        ]) {
            const response = await runtime.dispatchFetch(`https://morty.example${path}`, { headers });
            expect(response.status, path).toBe(404);
            expect(response.headers.get("content-type"), path).not.toContain("text/html");
            expect(await response.json(), path).toMatchObject({ error: { code: "NOT_FOUND" } });
        }
    });

    test(`Given an existing application route, When ${navigation ? "a browser opens" : "a client fetches"} it, Then its HTML loads without redirecting or exposing session data`, async () => {
        for (const path of [
            "/chat",
            "/chat/",
            "/continue",
            "/continue/",
            "/continue/preview",
            "/continue/preview/ready",
            "/playground",
            "/playground/buttons",
        ]) {
            const response = await runtime.dispatchFetch(
                `https://morty.example${path}?identity=private-identity&sessionId=private-session`,
                { headers, redirect: "manual" },
            );
            expect(response.status, path).toBe(200);
            expect(response.headers.get("content-type"), path).toContain("text/html");
            expect(response.headers.get("location"), path).toBeNull();
            expect(response.headers.get("x-robots-tag"), path).toBe("noindex");
            const html = await response.text();
            expect(html, path).toContain('<div id="root">');
            expect(html, path).not.toMatch(/private-identity|private-session/);
        }
    });
}

test("Given application routes, When a client sends HEAD or POST, Then only the supported document methods return the page", async () => {
    const head = await runtime.dispatchFetch("https://morty.example/chat?sessionId=private", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toContain("text/html");
    expect(head.headers.get("x-robots-tag")).toBe("noindex");
    expect(await head.text()).toBe("");
    const post = await runtime.dispatchFetch("https://morty.example/chat", { method: "POST" });
    expect(post.status).toBe(404);
});

test("Given the public home page, When a crawler fetches it without JavaScript, Then it receives product metadata, zoom permission and usable images", async () => {
    const response = await runtime.dispatchFetch("https://morty.example/");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-robots-tag")).toBeNull();
    const html = await response.text();
    expect(html).toContain('name="viewport" content="width=device-width, initial-scale=1.0"');
    expect(html).not.toMatch(/maximum-scale|user-scalable/);
    expect(html).toContain("<title>Morty — Continue your coding agent from any browser</title>");
    expect(html).toContain('name="description"');
    for (const property of [
        "title",
        "description",
        "type",
        "url",
        "image",
        "image:width",
        "image:height",
        "image:alt",
    ]) {
        expect(html).toContain(`property="og:${property}"`);
    }
    expect(html).toContain('content="https://morty.build/og-image.png"');
    expect(html).toContain('rel="icon"');

    for (const { path, type } of [
        { path: "/favicon.ico", type: "image/" },
        { path: "/og-image.png", type: "image/png" },
    ]) {
        const image = await runtime.dispatchFetch(`https://morty.example${path}`);
        expect(image.status).toBe(200);
        expect(image.headers.get("content-type")).toContain(type);
        expect(Buffer.from(await image.arrayBuffer())).toEqual(await readFile(join(directory, path.slice(1))));
    }
    const robots = await runtime.dispatchFetch("https://morty.example/robots.txt");
    expect(robots.status).toBe(200);
    expect(robots.headers.get("content-type")).toContain("text/plain");
    expect(await robots.text()).toBe("User-agent: *\nAllow: /\n");
});

test("Given a cached application page, When the browser revalidates it, Then the response retains its indexing policy", async () => {
    const first = await runtime.dispatchFetch("https://morty.example/chat");
    await first.text();
    const etag = first.headers.get("etag");
    expect(etag).not.toBeNull();
    if (etag === null) {
        throw new Error("The application page has no validator");
    }
    const cached = await runtime.dispatchFetch("https://morty.example/chat", { headers: { "If-None-Match": etag } });
    expect(cached.status).toBe(304);
    expect(cached.headers.get("x-robots-tag")).toBe("noindex");
    expect(await cached.text()).toBe("");
});

test("Given the asset router, When an agent requests installation resources, Then document and download handlers keep their HTTP contracts", async () => {
    for (const headers of [{}, { "Sec-Fetch-Mode": "navigate" }]) {
        const setup = await runtime.dispatchFetch("https://morty.example/setup.md", { headers });
        expect(setup.status).toBe(200);
        expect(setup.headers.get("content-type")).toContain("text/markdown");
        expect(await setup.text()).toMatch(/^# Set up Morty/);
        const download = await runtime.dispatchFetch("https://morty.example/setup.mjs", { headers });
        expect(download.status).toBe(503);
        expect(await download.json()).toMatchObject({ error: { code: "SETUP_ARTIFACT_UNAVAILABLE" } });
    }
});
