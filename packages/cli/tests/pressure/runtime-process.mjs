import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const [state, computerId, relay, runtimeCredential, control, sourceRoot] = process.argv.slice(2);
const { AcpAgentDefinition } = await import(
    pathToFileURL(join(sourceRoot, "packages/cli/src/engine/acp/agent/agent-definition.ts"))
);
const { createRuntimeConfig, RuntimeLocalContext } = await import(
    pathToFileURL(join(sourceRoot, "packages/cli/src/engine/runtime/config.ts"))
);
const { RuntimeLoop } = await import(
    pathToFileURL(join(sourceRoot, "packages/cli/src/engine/runtime/runtime-loop.ts"))
);
const { memoryRuntimeCredentials } = await import(
    pathToFileURL(join(sourceRoot, "packages/cli/tests/support/runtime-credentials.ts"))
);
const { ControlledAcpConnection } = await import(
    pathToFileURL(join(sourceRoot, "packages/cli/tests/support/agents/controlled-acp-connection.ts"))
);
const agent = new AcpAgentDefinition(
    "pressure-agent",
    "Pressure Agent",
    process.execPath,
    (options) =>
        new ControlledAcpConnection(
            {
                harness: "pressure-agent",
                adapterPath: process.execPath,
                arguments: [new URL("./output-peer.mjs", import.meta.url).pathname],
                environment: options.environment,
            },
            options,
        ),
    { MORTY_TEST_OUTPUT_CONTROL_PATH: control },
    "1.0.0",
    undefined,
    undefined,
    "1.0.0",
);
const config = createRuntimeConfig(
    {
        computerId,
        defaultWorkspace: join(state, "workspace"),
        relayUrl: new URL(relay),
        credentials: memoryRuntimeCredentials(runtimeCredential),
    },
    [agent],
    new RuntimeLocalContext(state, { PATH: process.env.PATH, HOME: join(state, "home") }),
);
const cancellation = new AbortController();
const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
process.on("message", (message) => {
    if (message === "stop") {
        cancellation.abort();
    }
});
process.on("disconnect", () => cancellation.abort());
try {
    await new RuntimeLoop(async () => config, {
        onConnectionStatus: (status) => process.send?.({ kind: "connection", status }),
    }).run(cancellation.signal);
} finally {
    process.send?.({
        kind: "metrics",
        rssBytes: process.memoryUsage().rss,
        loopDelayMilliseconds: {
            p95: delay.percentile(95) / 1e6,
            p99: delay.percentile(99) / 1e6,
            max: delay.max / 1e6,
        },
    });
    delay.disable();
    process.disconnect();
}
