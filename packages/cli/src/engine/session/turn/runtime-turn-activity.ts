import type { BackgroundActivity } from "../../acp/agent/in-process-endpoint.ts";
import type { ActiveRuntimeTurn } from "./active-turn.ts";

/** Tracks foreground and native background work for idle observations. */
export class RuntimeTurnActivity {
    readonly #turns = new Set<ActiveRuntimeTurn>();
    readonly #backgroundSources = new Map<object, Exclude<BackgroundActivity, "none">>();
    readonly #idleWaiters = new Set<() => void>();

    readonly count = (): number => this.#turns.size + this.#backgroundSources.size;

    readonly setBackgroundActivity = (source: object, activity: BackgroundActivity): void => {
        // Agents repeat unchanged reports; only a transition counts as activity.
        if (activity === (this.#backgroundSources.get(source) ?? "none")) {
            return;
        }
        if (activity === "none") {
            this.#backgroundSources.delete(source);
        } else {
            this.#backgroundSources.set(source, activity);
        }
        this.#changed();
    };

    readonly start = (turn: ActiveRuntimeTurn): void => {
        this.#turns.add(turn);
        this.#changed();
    };

    readonly finish = (turn: ActiveRuntimeTurn): void => {
        this.#turns.delete(turn);
        this.#changed();
    };

    #changed(): void {
        if (this.count() === 0) {
            for (const resolve of this.#idleWaiters) {
                resolve();
            }
            this.#idleWaiters.clear();
        }
    }

    readonly whenIdle = (signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        if (this.count() === 0) {
            return Promise.resolve();
        }
        return new Promise<void>((resolve, reject) => {
            const abort = (): void => {
                this.#idleWaiters.delete(idle);
                reject(signal.reason);
            };
            const idle = (): void => {
                signal.removeEventListener("abort", abort);
                resolve();
            };
            this.#idleWaiters.add(idle);
            signal.addEventListener("abort", abort, { once: true });
        });
    };
}
