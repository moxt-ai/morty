import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const accountId = "95af7a3d67be8c49b1619544e3ce53c0";
const warmupSamples = 5;
const measuredSamples = 100;
const mode = process.argv[2] ?? "all";
if (mode !== "all" && mode !== "chat-to-platform") {
    throw new Error("Usage: run.mjs [chat-to-platform]");
}
const allTargets = [
    { name: "chat-apac", config: "chat-apac.jsonc", paths: ["d1", "r2", "platform"] },
    { name: "chat-wnam", config: "chat-wnam.jsonc", paths: ["d1", "r2", "platform"] },
    { name: "platform-apac-01", config: "mobius-apac.jsonc", paths: ["d1", "r2"] },
    { name: "platform-apac-02", config: "mobius-apac-02.jsonc", paths: ["d1"] },
    { name: "platform-wnam-01", config: "mobius-wnam.jsonc", paths: ["d1", "r2"] },
    { name: "platform-wnam-02", config: "mobius-wnam-02.jsonc", paths: ["d1"] },
];
const targets =
    mode === "chat-to-platform"
        ? allTargets.slice(0, 2).map((target) => ({ ...target, paths: ["platform"] }))
        : allTargets;

function runWrangler(arguments_) {
    const result = spawnSync("pnpm", ["exec", "wrangler", ...arguments_], {
        cwd: directory,
        encoding: "utf8",
        env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
        timeout: 120_000,
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (result.error !== undefined || result.status !== 0) {
        throw new Error(`Wrangler failed (${arguments_.join(" ")}):\n${output}`, { cause: result.error });
    }
    return output;
}

function workerUrl(output) {
    const match = output.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/);
    if (match === null) {
        throw new Error("Wrangler did not report a workers.dev URL");
    }
    return new URL(match[0]);
}

function requireMeasurement(value) {
    if (
        typeof value !== "object" ||
        value === null ||
        !("durationMilliseconds" in value) ||
        typeof value.durationMilliseconds !== "number"
    ) {
        throw new Error("The probe returned an invalid measurement");
    }
    const sqlDurationMilliseconds =
        "sqlDurationMilliseconds" in value && typeof value.sqlDurationMilliseconds === "number"
            ? value.sqlDurationMilliseconds
            : undefined;
    return { durationMilliseconds: value.durationMilliseconds, sqlDurationMilliseconds };
}

async function requestMeasurement(url, path, token) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
            const response = await fetch(new URL(`/measure/${path}`, url), {
                method: "POST",
                headers: { Authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(60_000),
            });
            const body = await response.json();
            if (!response.ok) {
                throw new Error(`Probe ${url} failed with HTTP ${response.status}: ${JSON.stringify(body)}`);
            }
            return requireMeasurement(body);
        } catch (cause) {
            if (attempt === 3 || (cause instanceof Error && cause.message.startsWith("Probe "))) {
                throw cause;
            }
        }
    }
    throw new Error("The probe exhausted its collection attempts");
}

function percentile(sorted, fraction) {
    return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function summary(values) {
    const sorted = values.toSorted((left, right) => left - right);
    const rounded = (value) => Math.round(value * 1_000) / 1_000;
    return {
        samples: sorted.length,
        minimum: rounded(sorted[0]),
        p50: rounded(percentile(sorted, 0.5)),
        p95: rounded(percentile(sorted, 0.95)),
        p99: rounded(percentile(sorted, 0.99)),
        maximum: rounded(sorted.at(-1)),
        mean: rounded(sorted.reduce((total, value) => total + value, 0) / sorted.length),
    };
}

async function benchmark(url, path, token) {
    for (let index = 0; index < warmupSamples; index += 1) {
        await requestMeasurement(url, path, token);
    }
    const wall = [];
    const sql = [];
    for (let index = 0; index < measuredSamples; index += 1) {
        const measurement = await requestMeasurement(url, path, token);
        wall.push(measurement.durationMilliseconds);
        if (measurement.sqlDurationMilliseconds !== undefined) {
            sql.push(measurement.sqlDurationMilliseconds);
        }
    }
    return {
        wallMilliseconds: summary(wall),
        ...(sql.length === measuredSamples ? { sqlMilliseconds: summary(sql) } : {}),
    };
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-latency-"));
const token = randomBytes(32).toString("base64url");
const secretFile = join(temporaryDirectory, "secrets.json");
await writeFile(secretFile, JSON.stringify({ BENCHMARK_TOKEN: token }), { mode: 0o600 });
const deployed = [];

try {
    for (const target of targets) {
        const workerName = `mobius-latency-${target.name}-${randomUUID().slice(0, 8)}`;
        const output = runWrangler([
            "deploy",
            "--config",
            join(directory, target.config),
            "--name",
            workerName,
            "--secrets-file",
            secretFile,
        ]);
        deployed.push({ ...target, workerName, url: workerUrl(output) });
    }

    const measurements = {};
    for (const target of deployed) {
        for (const path of target.paths) {
            console.error(`Measuring ${target.name}-${path}`);
            measurements[`${target.name}-${path}`] = await benchmark(target.url, path, token);
        }
    }
    console.log(
        JSON.stringify(
            {
                measuredAt: new Date().toISOString(),
                scenario: mode,
                chatWorkerEnvironment: "staging",
                platformEnvironment: "production",
                warmupSamples,
                measuredSamples,
                measurements,
            },
            null,
            2,
        ),
    );
} finally {
    for (const target of deployed.reverse()) {
        try {
            runWrangler(["delete", target.workerName, "--force"]);
        } catch (cause) {
            console.error(`Failed to delete temporary Worker ${target.workerName}`, cause);
        }
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
}
