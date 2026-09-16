export class RequestAccessMetrics {
    readonly #startedAt = performance.now();
    #d1Count = 0;
    #d1DurationMilliseconds = 0;
    #mobiusCount = 0;
    #mobiusDurationMilliseconds = 0;

    readonly measureD1 = async <T>(operation: () => Promise<T>): Promise<T> => {
        const startedAt = performance.now();
        this.#d1Count += 1;
        try {
            return await operation();
        } finally {
            this.#d1DurationMilliseconds += Math.max(0, performance.now() - startedAt);
        }
    };

    readonly recordMobiusServerTiming = (encoded: string | null): void => {
        const match = /(?:^|,)\s*total;dur=(\d+(?:\.\d+)?)(?:;|,|$)/u.exec(encoded ?? "");
        const durationMilliseconds = Number(match?.[1]);
        if (Number.isFinite(durationMilliseconds) && durationMilliseconds >= 0 && durationMilliseconds <= 120_000) {
            this.#mobiusCount += 1;
            this.#mobiusDurationMilliseconds += durationMilliseconds;
        }
    };

    readonly appendServerTiming = (response: Response): Response => {
        if (response.status === 101) {
            return response;
        }
        const existing = response.headers.get("server-timing") ?? "";
        const headers = new Headers(response.headers);
        const additions: string[] = [];
        if (!/(?:^|,)\s*total;/u.test(existing)) {
            additions.push(
                `total;dur=${Math.max(0, performance.now() - this.#startedAt).toFixed(1)};desc="Total response time"`,
            );
        }
        if (!/(?:^|,)\s*mobius;/u.test(existing)) {
            additions.push(
                `mobius;dur=${this.#mobiusDurationMilliseconds.toFixed(1)};desc="Mobius access";count=${this.#mobiusCount}`,
            );
        }
        if (!/(?:^|,)\s*d1;/u.test(existing)) {
            additions.push(`d1;dur=${this.#d1DurationMilliseconds.toFixed(1)};desc="D1 access";count=${this.#d1Count}`);
        }
        if (additions.length > 0) {
            headers.append("Server-Timing", additions.join(","));
        }
        return new Response(response.body, { headers, status: response.status, statusText: response.statusText });
    };
}

const sources = new WeakMap<object, unknown>();

function wrappedSource(value: unknown): unknown {
    return typeof value === "object" && value !== null ? (sources.get(value) ?? value) : value;
}

function instrumentStatement(value: unknown, metrics: RequestAccessMetrics): unknown {
    if (typeof value !== "object" || value === null) {
        return value;
    }
    const wrapped = new Proxy(value, {
        get(target, property, receiver) {
            const member = Reflect.get(target, property, receiver);
            if (typeof member !== "function") {
                return member;
            }
            if (property === "bind") {
                return (...values: readonly unknown[]) =>
                    instrumentStatement(Reflect.apply(member, target, values), metrics);
            }
            if (property === "first" || property === "all" || property === "run" || property === "raw") {
                return (...parameters: readonly unknown[]) =>
                    metrics.measureD1(async () => await Reflect.apply(member, target, parameters));
            }
            return member.bind(target);
        },
    });
    sources.set(wrapped, value);
    return wrapped;
}

function instrumentSession(value: unknown, metrics: RequestAccessMetrics): unknown {
    if (typeof value !== "object" || value === null) {
        return value;
    }
    return new Proxy(value, {
        get(target, property, receiver) {
            const member = Reflect.get(target, property, receiver);
            if (typeof member !== "function") {
                return member;
            }
            if (property === "prepare") {
                return (...parameters: readonly unknown[]) =>
                    instrumentStatement(Reflect.apply(member, target, parameters), metrics);
            }
            if (property === "batch") {
                return (statements: readonly unknown[]) =>
                    metrics.measureD1(async () => await Reflect.apply(member, target, [statements.map(wrappedSource)]));
            }
            return member.bind(target);
        },
    });
}

export function instrumentD1Database(value: unknown, metrics: RequestAccessMetrics): unknown {
    if (typeof value !== "object" || value === null || !("prepare" in value) || typeof value.prepare !== "function") {
        return value;
    }
    return new Proxy(value, {
        get(target, property, receiver) {
            const member = Reflect.get(target, property, receiver);
            if (typeof member !== "function") {
                return member;
            }
            if (property === "prepare") {
                return (...parameters: readonly unknown[]) =>
                    instrumentStatement(Reflect.apply(member, target, parameters), metrics);
            }
            if (property === "batch") {
                return (statements: readonly unknown[]) =>
                    metrics.measureD1(async () => await Reflect.apply(member, target, [statements.map(wrappedSource)]));
            }
            if (property === "exec" || property === "dump") {
                return (...parameters: readonly unknown[]) =>
                    metrics.measureD1(async () => await Reflect.apply(member, target, parameters));
            }
            if (property === "withSession") {
                return (...parameters: readonly unknown[]) =>
                    instrumentSession(Reflect.apply(member, target, parameters), metrics);
            }
            return member.bind(target);
        },
    });
}
