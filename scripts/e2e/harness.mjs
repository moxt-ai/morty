import { execFile, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

function errorRecord(error) {
    if (!(error instanceof Error)) {
        return { message: String(error) };
    }
    return {
        message: error.message,
        name: error.name,
        ...(error.cause === undefined ? {} : { cause: errorRecord(error.cause) }),
    };
}

function observation(value) {
    if (value instanceof Error) {
        return errorRecord(value);
    }
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return String(value);
    }
}

class E2EHarness {
    static async create(name) {
        const configuredRoot = process.env.MOBIUS_E2E_ARTIFACT_ROOT;
        const parent = configuredRoot === undefined ? tmpdir() : resolve(configuredRoot);
        await mkdir(parent, { recursive: true });
        const rootDirectory = await mkdtemp(join(parent, `${name}-`));
        const artifactDirectory = join(rootDirectory, "artifacts");
        const workDirectory = join(rootDirectory, "work");
        await Promise.all([artifactDirectory, workDirectory].map((path) => mkdir(path, { recursive: true })));
        return new E2EHarness(name, rootDirectory, artifactDirectory, workDirectory, configuredRoot !== undefined);
    }

    constructor(name, rootDirectory, artifactDirectory, workDirectory, preserveArtifacts) {
        this.name = name;
        this.rootDirectory = rootDirectory;
        this.artifactDirectory = artifactDirectory;
        this.workDirectory = workDirectory;
        this.preserveArtifacts = preserveArtifacts || process.env.MOBIUS_E2E_KEEP_STATE === "1";
        this.timeoutMilliseconds = Number(process.env.MOBIUS_E2E_TIMEOUT_MS ?? 10 * 60 * 1_000);
        this.signal = AbortSignal.timeout(this.timeoutMilliseconds);
        this.startedAt = Date.now();
        this.children = [];
        this.stages = [];
        this.metadata = {};
        this.browserEvents = [];
        this.traceStarted = false;
    }

    log(message) {
        process.stdout.write(`[${this.name}] ${message}\n`);
    }

    record(name, value) {
        this.metadata[name] = value;
    }

    async stage(name, action) {
        const stage = { name, startedAt: new Date().toISOString(), startedMilliseconds: Date.now() };
        this.stages.push(stage);
        this.log(`START ${name}`);
        try {
            const result = await action();
            stage.status = "passed";
            return result;
        } catch (error) {
            stage.status = "failed";
            stage.error = errorRecord(error);
            throw new Error(`[${name}] ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        } finally {
            stage.durationMilliseconds = Date.now() - stage.startedMilliseconds;
            delete stage.startedMilliseconds;
            this.log(`${stage.status === "passed" ? "PASS" : "FAIL"} ${name} (${stage.durationMilliseconds}ms)`);
            await this.#writeRunRecord();
        }
    }

    async run(command, args, options = {}) {
        this.log(`RUN ${options.label ?? `${command} ${args.join(" ")}`}`);
        return await execute(command, args, {
            cwd: options.cwd,
            env: { ...process.env, ...options.env },
            maxBuffer: 16 * 1024 * 1024,
            signal: this.signal,
        });
    }

    async start(name, command, args, options = {}) {
        const logPath = join(this.artifactDirectory, `${name}.log`);
        const output = openSync(logPath, "a", 0o600);
        const child = spawn(command, args, {
            cwd: options.cwd,
            detached: true,
            env: { ...process.env, ...options.env },
            stdio: ["ignore", output, output],
        });
        const processRecord = { child, logPath, name, output };
        this.children.push(processRecord);
        await new Promise((resolveSpawn, reject) => {
            child.once("error", reject);
            child.once("spawn", resolveSpawn);
        });
        this.log(`STARTED ${name} pid=${child.pid}`);
        return child;
    }

    async waitFor(description, probe, accept, options = {}) {
        const timeout = AbortSignal.timeout(options.timeoutMilliseconds ?? 90_000);
        let lastObservation;
        while (!this.signal.aborted && !timeout.aborted) {
            await this.#assertProcessesRunning();
            try {
                lastObservation = await probe();
                if (accept(lastObservation)) {
                    return lastObservation;
                }
            } catch (error) {
                lastObservation = error;
            }
            await new Promise((resolveDelay) => setTimeout(resolveDelay, options.intervalMilliseconds ?? 500));
        }
        throw new Error(
            `Timed out waiting for ${description}; last observation: ${JSON.stringify(observation(lastObservation))}`,
        );
    }

    async waitForHttp(url, description, accept = (response) => response.ok) {
        return await this.waitFor(
            description,
            async () => {
                const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
                return { accepted: await accept(response), status: response.status };
            },
            (result) => result.accepted,
            { intervalMilliseconds: 250 },
        );
    }

    async attachBrowser(browser, context, page) {
        this.browser = browser;
        this.browserContext = context;
        this.page = page;
        page.on("console", (message) =>
            this.browserEvents.push({ type: "console", level: message.type(), text: message.text() }),
        );
        page.on("pageerror", (error) => this.browserEvents.push({ type: "pageerror", ...errorRecord(error) }));
        page.on("requestfailed", (request) =>
            this.browserEvents.push({
                type: "requestfailed",
                method: request.method(),
                url: request.url(),
                failure: request.failure(),
            }),
        );
        await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
        this.traceStarted = true;
    }

    async diagnose(error) {
        this.failure = errorRecord(error);
        const captures = [
            [
                "browser-events.json",
                () =>
                    writeFile(
                        join(this.artifactDirectory, "browser-events.json"),
                        `${JSON.stringify(this.browserEvents, null, 2)}\n`,
                    ),
            ],
            [
                "page.html",
                () => this.page?.content().then((html) => writeFile(join(this.artifactDirectory, "page.html"), html)),
            ],
            [
                "page.png",
                () => this.page?.screenshot({ path: join(this.artifactDirectory, "page.png"), fullPage: true }),
            ],
            [
                "playwright-trace.zip",
                async () => {
                    if (this.traceStarted) {
                        await this.browserContext.tracing.stop({
                            path: join(this.artifactDirectory, "playwright-trace.zip"),
                        });
                        this.traceStarted = false;
                    }
                },
            ],
        ];
        for (const [name, capture] of captures) {
            try {
                await capture();
            } catch (captureError) {
                this.log(`Could not capture ${name}: ${errorRecord(captureError).message}`);
            }
        }
        await this.#writeRunRecord();
        for (const { logPath, name } of this.children) {
            try {
                const contents = await readFile(logPath, "utf8");
                process.stderr.write(`\n--- ${name} (${logPath}) ---\n${contents.slice(-12_000)}\n`);
            } catch {
                // The process may have failed before its log was created.
            }
        }
        this.log(`diagnostics: ${this.artifactDirectory}`);
    }

    async close(success) {
        if (this.traceStarted) {
            try {
                await this.browserContext.tracing.stop();
            } catch (error) {
                this.log(`Could not stop browser tracing: ${errorRecord(error).message}`);
            }
            this.traceStarted = false;
        }
        try {
            await this.browser?.close();
        } catch (error) {
            this.log(`Could not close browser: ${errorRecord(error).message}`);
        }
        for (const processRecord of this.children.toReversed()) {
            await this.#stopProcess(processRecord);
        }
        this.finishedAt = Date.now();
        this.success = success;
        await this.#writeRunRecord();
        if (success && !this.preserveArtifacts) {
            await rm(this.rootDirectory, { recursive: true, force: true });
        } else {
            this.log(`kept diagnostics: ${this.artifactDirectory}`);
        }
    }

    async #assertProcessesRunning() {
        const exited = this.children.find(({ child }) => child.exitCode !== null || child.signalCode !== null);
        if (exited === undefined) {
            return;
        }
        const contents = await readFile(exited.logPath, "utf8");
        throw new Error(
            `${exited.name} exited with ${exited.child.exitCode ?? exited.child.signalCode}:\n${contents.slice(-4_000)}`,
        );
    }

    async #stopProcess({ child, name, output }) {
        try {
            if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
                process.kill(-child.pid, "SIGTERM");
                await Promise.race([
                    new Promise((resolveExit) => child.once("exit", resolveExit)),
                    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
                ]);
                if (child.exitCode === null && child.signalCode === null) {
                    process.kill(-child.pid, "SIGKILL");
                }
            }
        } catch (error) {
            if (error.code !== "ESRCH") {
                this.log(`Could not stop ${name}: ${errorRecord(error).message}`);
            }
        } finally {
            closeSync(output);
        }
    }

    async #writeRunRecord() {
        await writeFile(
            join(this.artifactDirectory, "run.json"),
            `${JSON.stringify(
                {
                    name: this.name,
                    status: this.failure === undefined ? (this.success === true ? "passed" : "running") : "failed",
                    startedAt: new Date(this.startedAt).toISOString(),
                    ...(this.finishedAt === undefined ? {} : { finishedAt: new Date(this.finishedAt).toISOString() }),
                    ...(this.finishedAt === undefined
                        ? {}
                        : { durationMilliseconds: this.finishedAt - this.startedAt }),
                    metadata: this.metadata,
                    stages: this.stages,
                    ...(this.failure === undefined ? {} : { failure: this.failure }),
                },
                null,
                2,
            )}\n`,
        );
    }
}

export async function runE2E(name, scenario) {
    const harness = await E2EHarness.create(name);
    try {
        await scenario(harness);
        await harness.close(true);
    } catch (error) {
        await harness.diagnose(error);
        await harness.close(false);
        throw error;
    }
}
