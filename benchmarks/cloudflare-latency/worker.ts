interface BenchmarkBindings {
    readonly BENCHMARK_TOKEN?: string;
    readonly BUCKET: R2Bucket;
    readonly DATABASE: D1Database;
    readonly PROBE_NAME: string;
    readonly TARGET_URL?: string;
}

async function measureR2(bindings: BenchmarkBindings): Promise<Response> {
    const started = performance.now();
    await bindings.BUCKET.list({ limit: 1 });
    const durationMilliseconds = performance.now() - started;
    return json({ probe: bindings.PROBE_NAME, durationMilliseconds });
}

const json = (body: unknown, status = 200): Response =>
    Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

function authorized(request: Request, token: string | undefined): boolean {
    return token !== undefined && request.headers.get("Authorization") === `Bearer ${token}`;
}

async function measureD1(bindings: BenchmarkBindings): Promise<Response> {
    const started = performance.now();
    const result = await bindings.DATABASE.prepare("SELECT 1 AS value").run<{ readonly value: number }>();
    const durationMilliseconds = performance.now() - started;
    if (!result.success || result.results[0]?.value !== 1) {
        return json({ code: "D1_PROBE_FAILED", message: "The D1 probe did not return the expected value" }, 502);
    }
    return json({
        probe: bindings.PROBE_NAME,
        durationMilliseconds,
        sqlDurationMilliseconds: result.meta.timings?.sql_duration_ms,
    });
}

async function measurePlatform(bindings: BenchmarkBindings): Promise<Response> {
    if (bindings.TARGET_URL === undefined) {
        return json({ code: "TARGET_NOT_CONFIGURED", message: "This probe has no Worker target" }, 404);
    }
    let target: URL;
    try {
        target = new URL(bindings.TARGET_URL);
    } catch {
        return json({ code: "TARGET_INVALID", message: "The configured Worker target is invalid" }, 500);
    }
    if (target.protocol !== "https:" || target.username !== "" || target.password !== "") {
        return json({ code: "TARGET_INVALID", message: "The configured Worker target is invalid" }, 500);
    }
    const started = performance.now();
    const response = await fetch(target, {
        headers: { Accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
    });
    await response.arrayBuffer();
    const durationMilliseconds = performance.now() - started;
    if (!response.ok) {
        return json({ code: "TARGET_PROBE_FAILED", message: "The Worker target rejected the probe" }, 502);
    }
    return json({ probe: bindings.PROBE_NAME, durationMilliseconds, target: target.origin });
}

export default {
    async fetch(request: Request, bindings: BenchmarkBindings): Promise<Response> {
        if (!authorized(request, bindings.BENCHMARK_TOKEN)) {
            return json({ code: "UNAUTHORIZED", message: "A valid benchmark token is required" }, 401);
        }
        if (request.method !== "POST") {
            return json({ code: "METHOD_NOT_ALLOWED", message: "Use POST for benchmark probes" }, 405);
        }
        const pathname = new URL(request.url).pathname;
        try {
            if (pathname === "/measure/d1") {
                return await measureD1(bindings);
            }
            if (pathname === "/measure/r2") {
                return await measureR2(bindings);
            }
            if (pathname === "/measure/platform") {
                return await measurePlatform(bindings);
            }
            return json({ code: "NOT_FOUND", message: "The benchmark probe was not found" }, 404);
        } catch (cause) {
            if (cause instanceof DOMException && cause.name === "TimeoutError") {
                return json({ code: "PROBE_TIMEOUT", message: "The benchmark probe timed out" }, 504);
            }
            console.error("Latency probe failed", cause);
            return json({ code: "PROBE_FAILED", message: "The benchmark probe failed" }, 502);
        }
    },
} satisfies ExportedHandler<BenchmarkBindings>;
