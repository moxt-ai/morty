import type { NativeSessionTarget } from "./protocol/session/shared/native-session-target.ts";

/** A serialization for application indexes, never a caller-assigned conversation identity. */
export const nativeSessionKey = (target: NativeSessionTarget): string =>
    JSON.stringify([target.harness, target.sessionId]);

export const sameNativeSession = (left: NativeSessionTarget, right: NativeSessionTarget): boolean =>
    left.harness === right.harness && left.sessionId === right.sessionId;

/** Indexes state by the full native pair; the serialization never leaves this index. */
export class NativeSessionMap<Value> {
    readonly #entries = new Map<string, { readonly target: NativeSessionTarget; readonly value: Value }>();
    constructor(entries: Iterable<readonly [NativeSessionTarget, Value]> = []) {
        for (const [target, value] of entries) {
            this.set(target, value);
        }
    }
    get size(): number {
        return this.#entries.size;
    }
    readonly get = (target: NativeSessionTarget): Value | undefined =>
        this.#entries.get(nativeSessionKey(target))?.value;
    readonly has = (target: NativeSessionTarget): boolean => this.#entries.has(nativeSessionKey(target));
    readonly set = (target: NativeSessionTarget, value: Value): this => {
        this.#entries.set(nativeSessionKey(target), { target, value });
        return this;
    };
    readonly delete = (target: NativeSessionTarget): boolean => this.#entries.delete(nativeSessionKey(target));
    readonly clear = (): void => this.#entries.clear();
    *entries(): IterableIterator<readonly [NativeSessionTarget, Value]> {
        for (const entry of this.#entries.values()) {
            yield [entry.target, entry.value];
        }
    }
    *values(): IterableIterator<Value> {
        for (const entry of this.#entries.values()) {
            yield entry.value;
        }
    }
    *keys(): IterableIterator<NativeSessionTarget> {
        for (const entry of this.#entries.values()) {
            yield entry.target;
        }
    }
    [Symbol.iterator](): IterableIterator<readonly [NativeSessionTarget, Value]> {
        return this.entries();
    }
}

export class NativeSessionSet {
    readonly #entries = new NativeSessionMap<true>();
    get size(): number {
        return this.#entries.size;
    }
    readonly has = (target: NativeSessionTarget): boolean => this.#entries.has(target);
    readonly add = (target: NativeSessionTarget): this => {
        this.#entries.set(target, true);
        return this;
    };
    readonly delete = (target: NativeSessionTarget): boolean => this.#entries.delete(target);
    readonly clear = (): void => this.#entries.clear();
}
