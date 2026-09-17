import { createMiddleware } from "hono/factory";
import type { OperationTiming } from "../../../infra/operation-timing.ts";
import type { ChatHttpEnvironment } from "./chat-http-environment.ts";

type TimingMetric = {
    readonly name: string;
    readonly description: string;
    readonly durationMilliseconds: number;
    readonly count?: number;
};

function duration(startedAt: number): number {
    return Math.max(0, performance.now() - startedAt);
}

function headerMetric(metric: TimingMetric): string {
    return `${metric.name};dur=${metric.durationMilliseconds.toFixed(1)};desc="${metric.description}"${metric.count === undefined ? "" : `;count=${metric.count}`}`;
}

export const serverTiming = createMiddleware<ChatHttpEnvironment>(async (context, next) => {
    const startedAt = performance.now();
    const metrics: TimingMetric[] = [];
    let mobiusDurationMilliseconds = 0;
    let mobiusCount = 0;
    const operationTiming: OperationTiming = {
        measure: async (name, description, operation) => {
            const operationStartedAt = performance.now();
            try {
                return await operation();
            } finally {
                metrics.push({ name, description, durationMilliseconds: duration(operationStartedAt) });
            }
        },
        record: (name, description, durationMilliseconds) => {
            if (name === "mobius") {
                mobiusDurationMilliseconds += durationMilliseconds;
                mobiusCount += 1;
            } else {
                metrics.push({ name, description, durationMilliseconds });
            }
        },
    };
    context.set("operationTiming", operationTiming);
    await next();
    const total: TimingMetric = {
        name: "total",
        description: "Total response time",
        durationMilliseconds: duration(startedAt),
    };
    const completed = [
        total,
        ...metrics,
        {
            name: "mobius",
            description: "Mobius access",
            durationMilliseconds: mobiusDurationMilliseconds,
            count: mobiusCount,
        },
    ];
    context.header("Server-Timing", completed.map(headerMetric).join(","));
    context.env.logger.info(
        {
            event: "chat-request-timing",
            method: context.req.method,
            path: context.req.path,
            status: context.res.status,
            timings: Object.fromEntries(completed.map((metric) => [metric.name, metric.durationMilliseconds])),
        },
        "Chat request timing",
    );
});
