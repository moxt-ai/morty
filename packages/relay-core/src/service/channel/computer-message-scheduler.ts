const DEFAULT_CONCURRENCY = 8;
const DEFAULT_PENDING_LIMIT = 512;

export class ComputerMessageSchedulerCapacityError extends Error {
    readonly code = "computer_message_queue_full";

    constructor(limit: number) {
        super(`Computer message queue reached its limit of ${limit}`);
        this.name = "ComputerMessageSchedulerCapacityError";
    }
}

class ComputerMessageSlot {
    readonly #releaseSlot: () => void;
    #released = false;

    constructor(releaseSlot: () => void) {
        this.#releaseSlot = releaseSlot;
    }

    readonly release = (): void => {
        if (this.#released) {
            return;
        }
        this.#released = true;
        this.#releaseSlot();
    };
}

class ComputerMessageSlotWaiter {
    readonly completion = Promise.withResolvers<ComputerMessageSlot>();
    readonly signal: AbortSignal;

    constructor(signal: AbortSignal) {
        this.signal = signal;
    }

    readonly cancel = (): void => {
        this.completion.reject(this.signal.reason);
    };
}

class ComputerMessageConcurrency {
    readonly #limit: number;
    #active = 0;
    readonly #waiters: ComputerMessageSlotWaiter[] = [];

    constructor(limit: number) {
        if (!Number.isSafeInteger(limit) || limit < 1) {
            throw new Error("Computer message concurrency must be a positive safe integer");
        }
        this.#limit = limit;
    }

    readonly acquire = async (signal: AbortSignal): Promise<ComputerMessageSlot> => {
        signal.throwIfAborted();
        if (this.#active < this.#limit) {
            this.#active += 1;
            return new ComputerMessageSlot(this.#release);
        }

        const waiter = new ComputerMessageSlotWaiter(signal);
        this.#waiters.push(waiter);
        signal.addEventListener("abort", waiter.cancel, { once: true });
        try {
            return await waiter.completion.promise;
        } finally {
            signal.removeEventListener("abort", waiter.cancel);
            const waitingIndex = this.#waiters.indexOf(waiter);
            if (waitingIndex >= 0) {
                this.#waiters.splice(waitingIndex, 1);
            }
        }
    };

    readonly #release = (): void => {
        while (this.#waiters.length > 0) {
            const waiter = this.#waiters.shift();
            if (waiter === undefined || waiter.signal.aborted) {
                continue;
            }
            waiter.completion.resolve(new ComputerMessageSlot(this.#release));
            return;
        }
        this.#active -= 1;
    };
}

function waitForComputerMessage(completion: Promise<void>, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const result = Promise.withResolvers<void>();
    const cancel = (): void => result.reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    void completion.then(
        () => {
            signal.removeEventListener("abort", cancel);
            result.resolve();
        },
        (error: unknown) => {
            signal.removeEventListener("abort", cancel);
            result.reject(error);
        },
    );
    return result.promise;
}

export class ComputerMessageScheduler {
    readonly #concurrency: ComputerMessageConcurrency;
    readonly #pendingLimit: number;
    readonly #lanes = new Map<string, Promise<void>>();
    readonly #operations = new Set<Promise<void>>();
    #pending = 0;

    constructor(concurrency = DEFAULT_CONCURRENCY, pendingLimit = DEFAULT_PENDING_LIMIT) {
        if (!Number.isSafeInteger(pendingLimit) || pendingLimit < concurrency) {
            throw new Error("Computer message pending limit must cover the concurrency limit");
        }
        this.#concurrency = new ComputerMessageConcurrency(concurrency);
        this.#pendingLimit = pendingLimit;
    }

    /**
     * Runs `task` after every earlier task that shares one of its lanes, so tasks on a lane run in the order
     * they were scheduled. A task on several lanes keeps its place in each of them.
     */
    readonly run = async (lanes: readonly string[], signal: AbortSignal, task: () => Promise<void>): Promise<void> => {
        signal.throwIfAborted();
        if (this.#pending >= this.#pendingLimit) {
            throw new ComputerMessageSchedulerCapacityError(this.#pendingLimit);
        }
        this.#pending += 1;

        const previous = Promise.all(lanes.map((lane) => this.#lanes.get(lane))).then(() => undefined);
        const operation = (async (): Promise<void> => {
            await waitForComputerMessage(previous, signal);
            const slot = await this.#concurrency.acquire(signal);
            try {
                signal.throwIfAborted();
                await task();
            } finally {
                slot.release();
            }
        })();
        const tail = operation.catch(() => undefined);
        for (const lane of lanes) {
            this.#lanes.set(lane, tail);
        }
        this.#operations.add(tail);

        try {
            await operation;
        } finally {
            this.#pending -= 1;
            this.#operations.delete(tail);
            for (const lane of lanes) {
                if (this.#lanes.get(lane) === tail) {
                    this.#lanes.delete(lane);
                }
            }
        }
    };

    readonly idle = async (signal: AbortSignal): Promise<void> => {
        while (this.#operations.size > 0) {
            await waitForComputerMessage(
                Promise.all(this.#operations).then(() => undefined),
                signal,
            );
        }
    };
}
