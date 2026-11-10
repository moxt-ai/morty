import { NativeSessionMap, NativeSessionSet } from "@morty-build/client/native-session";
import { type NativeSessionTarget, SESSION_CLOSED_ERROR_CODE } from "@morty-build/client/protocol";
import { AcpExecutionError } from "../../acp/acp-error.ts";

/** What preparing does with a closed Session: a prepare or restore reopens it, a read must keep it closed. */
export type ClosedSessionHandling = "reopen" | "keep-closed";

/** A closed Session is reopened by preparing it; an archived Session is no longer held, so nothing reopens it. */
export type SessionEnding = "close" | "archive";

/**
 * Where a Session stands in this Runtime apart from its Agent process. A Session without an entry is open, and so is
 * one no longer held: whether the Runtime holds a Session is the Session store's fact, so an archived Session leaves
 * no entry behind.
 */
type SessionLifecycle =
    /** A creation owns initialization and failure cleanup until `settled`, which never rejects. */
    | { readonly kind: "creating"; readonly settled: Promise<void> }
    /** Clients were told `reason`, and the Agent process is being released until `settled`. */
    | {
          readonly kind: "closing";
          readonly ending: SessionEnding;
          readonly reason: string;
          readonly settled: Promise<void>;
      }
    | { readonly kind: "closed"; readonly reason: string };

/** An operation the rule answers at once, so its check and the work that relies on it stay synchronous. */
export type ImmediateSessionOperation =
    /** Prepares a prompt's Agent: an open held Session, failing at once while it closes. */
    | { readonly kind: "prepare-execution" }
    /** Acts on the open Session's Agent. */
    | { readonly kind: "use" }
    /** Runs a prompt in the open Session, which must not write a native session another operation is managing. */
    | { readonly kind: "prompt" }
    /** Needs the native session to itself: no import, fork, or history read may be managing it. */
    | { readonly kind: "native-exclusive" };

/** An operation that waits out a creation or closing before it is decided. */
export type WaitingSessionOperation =
    /** Prepares the Session's Agent: a held Session no native operation manages, which a reopening preparation opens. */
    | { readonly kind: "prepare"; readonly closed: ClosedSessionHandling }
    /** Creates the Session with its initial settings, one creation at a time; a reopening creation opens it. */
    | { readonly kind: "create"; readonly closed: ClosedSessionHandling }
    /** Closes or archives the Session. */
    | { readonly kind: "end" }
    /** Imports the native session, which holds it again even when it was closed or archived. */
    | { readonly kind: "import" };

type ImmediateAdmission =
    | { readonly kind: "admitted" }
    | { readonly kind: "refused"; readonly error: AcpExecutionError };

type SessionAdmission =
    | ImmediateAdmission
    /** Decide again once `settled`; a rejection of it fails the operation. */
    | { readonly kind: "wait"; readonly settled: Promise<void> };

const admitted: ImmediateAdmission = { kind: "admitted" };

const refused = (message: string, code: string): ImmediateAdmission => ({
    kind: "refused",
    error: new AcpExecutionError(message, {}, code),
});

const closedRefusal = (reason: string): ImmediateAdmission => refused(reason, SESSION_CLOSED_ERROR_CODE);
const notFound = (): ImmediateAdmission => refused("The Session was not found", "session_not_found");
const managed = (): ImmediateAdmission => refused("The native session is being managed", "session_busy");

/** The admission rule for an operation answered at once, from the Session's lifecycle and the store's held fact. */
function admitNow(
    lifecycle: SessionLifecycle | undefined,
    nativeOperation: boolean,
    held: () => boolean,
    operation: ImmediateSessionOperation,
): ImmediateAdmission {
    const closed = lifecycle?.kind === "closing" || lifecycle?.kind === "closed" ? lifecycle.reason : undefined;
    switch (operation.kind) {
        case "prepare-execution":
            if (closed !== undefined) {
                return closedRefusal(closed);
            }
            return held() ? admitted : notFound();
        case "use":
            return closed === undefined ? admitted : closedRefusal(closed);
        case "prompt":
            if (closed !== undefined) {
                return closedRefusal(closed);
            }
            return nativeOperation ? managed() : admitted;
        case "native-exclusive":
            return nativeOperation ? managed() : admitted;
    }
}

/** The admission rule for an operation that waits out a creation or closing. */
function admitAfterTransitions(
    lifecycle: SessionLifecycle | undefined,
    nativeOperation: boolean,
    held: () => boolean,
    operation: WaitingSessionOperation,
): SessionAdmission {
    switch (operation.kind) {
        case "prepare":
            if (lifecycle?.kind === "closing") {
                return { kind: "wait", settled: lifecycle.settled };
            }
            if (!held()) {
                // A preparation that found the Session before it was archived must not revive it.
                return notFound();
            }
            if (lifecycle?.kind === "closed" && operation.closed === "keep-closed") {
                return closedRefusal(lifecycle.reason);
            }
            return nativeOperation ? managed() : admitted;
        case "create":
            if (lifecycle?.kind === "creating") {
                return refused("The Session is still being created; retry after it finishes", "session_busy");
            }
            if (lifecycle?.kind === "closing") {
                return { kind: "wait", settled: lifecycle.settled };
            }
            return lifecycle?.kind === "closed" && operation.closed === "keep-closed"
                ? closedRefusal(lifecycle.reason)
                : admitted;
        case "end":
            return lifecycle?.kind === "creating" || lifecycle?.kind === "closing"
                ? { kind: "wait", settled: lifecycle.settled }
                : admitted;
        case "import":
            if (lifecycle?.kind === "closing") {
                return { kind: "wait", settled: lifecycle.settled };
            }
            return nativeOperation ? managed() : admitted;
    }
}

/**
 * Every Session's lifecycle and the native sessions an import, fork, or history read manages. Each check and the
 * transition that relies on it are synchronous, so no other caller can act between them.
 */
export class SessionLifecycles {
    readonly #lifecycles = new NativeSessionMap<SessionLifecycle>();
    readonly #nativeOperations = new NativeSessionSet();

    /** Answers whether `operation` may act on the Session now. `held` reads the Session store when the rule needs it. */
    readonly admitNow = (
        target: NativeSessionTarget,
        operation: ImmediateSessionOperation,
        held: () => boolean,
    ): ImmediateAdmission =>
        admitNow(this.#lifecycles.get(target), this.#nativeOperations.has(target), held, operation);

    /** Answers whether `operation` may act on the Session, or which creation or closing it must wait out first. */
    readonly admit = (
        target: NativeSessionTarget,
        operation: WaitingSessionOperation,
        held: () => boolean,
    ): SessionAdmission =>
        admitAfterTransitions(this.#lifecycles.get(target), this.#nativeOperations.has(target), held, operation);

    /** Whether an import, fork, or history read is managing the native session, so no prompt may write it. */
    readonly managesNativeSession = (target: NativeSessionTarget): boolean => this.#nativeOperations.has(target);

    /** The reason clients were told when the Session closed, if it is closed. */
    readonly closedReason = (target: NativeSessionTarget): string | undefined => {
        const lifecycle = this.#lifecycles.get(target);
        return lifecycle?.kind === "closed" ? lifecycle.reason : undefined;
    };

    /** Preparing a closed Session, or importing it, opens it again. */
    readonly reopen = (target: NativeSessionTarget): void => {
        if (this.#lifecycles.get(target)?.kind === "closed") {
            this.#lifecycles.delete(target);
        }
    };

    /** A creation of an open or closed Session begins; a closed one is reopened by it. */
    readonly beginCreation = (target: NativeSessionTarget, settled: Promise<void>): void => {
        const lifecycle = this.#lifecycles.get(target);
        if (lifecycle?.kind === "creating" || lifecycle?.kind === "closing") {
            throw new Error("A Session that is being created or closed cannot begin another creation");
        }
        this.#lifecycles.set(target, { kind: "creating", settled });
    };

    readonly endCreation = (target: NativeSessionTarget, settled: Promise<void>): void => {
        const lifecycle = this.#lifecycles.get(target);
        if (lifecycle?.kind === "creating" && lifecycle.settled === settled) {
            this.#lifecycles.delete(target);
        }
    };

    /** An open or closed Session begins closing. */
    readonly beginClosing = (
        target: NativeSessionTarget,
        ending: SessionEnding,
        reason: string,
        settled: Promise<void>,
    ): void => {
        const lifecycle = this.#lifecycles.get(target);
        if (lifecycle?.kind === "creating" || lifecycle?.kind === "closing") {
            throw new Error("A Session that is being created or closed cannot begin closing");
        }
        this.#lifecycles.set(target, { kind: "closing", ending, reason, settled });
    };

    /** The Agent process was released: a closed Session stays closed, and an archived one is no longer held. */
    readonly endClosing = (target: NativeSessionTarget, settled: Promise<void>): void => {
        const lifecycle = this.#lifecycles.get(target);
        if (lifecycle?.kind !== "closing" || lifecycle.settled !== settled) {
            return;
        }
        if (lifecycle.ending === "archive") {
            this.#lifecycles.delete(target);
        } else {
            this.#lifecycles.set(target, { kind: "closed", reason: lifecycle.reason });
        }
    };

    readonly beginNativeOperation = (target: NativeSessionTarget): void => {
        this.#nativeOperations.add(target);
    };

    readonly endNativeOperation = (target: NativeSessionTarget): void => {
        this.#nativeOperations.delete(target);
    };

    /** The closings still releasing their Agent processes. */
    readonly closings = (): readonly Promise<void>[] =>
        [...this.#lifecycles.values()].flatMap((lifecycle) =>
            lifecycle.kind === "closing" ? [lifecycle.settled] : [],
        );
}
