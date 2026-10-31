import { type Identifier, isIdentifier } from "@moxt-ai/mobius-sdk/protocol";
import * as v from "valibot";

/**
 * The anonymous identity scope a Morty page carries in its URL query string
 * (`identity=<botId>~<projectId>~<userId>`). The scope names which user,
 * Project, and Bot the page serves; the matching access token lives in local
 * storage. Every component is schema-validated before use; anything that does
 * not decode is treated as absent.
 */

const projectIdSchema = v.pipe(v.string(), v.regex(/^prj_(wn|en|sa|we|ee|ap|an|as|oc|af|me)_01_[A-Za-z0-9_-]{24}$/u));
const userIdSchema = v.pipe(v.string(), v.minLength(8), v.maxLength(128));

export const identityScopeSchema = v.pipe(
    v.object({
        botId: v.custom<Identifier>(isIdentifier),
        projectId: projectIdSchema,
        userId: userIdSchema,
    }),
    v.readonly(),
);

export type IdentityScope = v.InferOutput<typeof identityScopeSchema>;

const scopeSchema = v.tuple([v.custom<Identifier>(isIdentifier), projectIdSchema, userIdSchema]);

/** Serializes a scope into its URL query value, validating it first; components cannot contain `~`. */
export function encodeIdentityScope(scope: {
    readonly botId: string;
    readonly projectId: string;
    readonly userId: string;
}): string {
    const parsed = v.parse(identityScopeSchema, scope);
    return [parsed.botId, parsed.projectId, parsed.userId].map((part) => encodeURIComponent(part)).join("~");
}

/** Parses a query value back into a scope, or null when it cannot represent one. */
function decodeIdentityScope(value: string): IdentityScope | null {
    const parts = value.split("~");
    if (parts.length !== 3) {
        return null;
    }
    let decoded: readonly unknown[];
    try {
        decoded = parts.map((part) => decodeURIComponent(part));
    } catch {
        return null;
    }
    const parsed = v.safeParse(scopeSchema, decoded);
    return parsed.success ? { botId: parsed.output[0], projectId: parsed.output[1], userId: parsed.output[2] } : null;
}

export function hasIdentityScope(): boolean {
    return new URLSearchParams(window.location.search).has("identity");
}

/** Reads the scope of the page's current URL; null when absent or invalid. */
export function readIdentityScope(): IdentityScope | null {
    const value = new URLSearchParams(window.location.search).get("identity");
    return value === null ? null : decodeIdentityScope(value);
}

function withIdentitySearch(modify: (parameters: URLSearchParams) => void): void {
    const url = new URL(window.location.href);
    modify(url.searchParams);
    window.history.replaceState(window.history.state, "", url);
}

/** Persists the scope into the current URL without adding a history entry. */
export function writeIdentityScope(scope: IdentityScope): void {
    withIdentitySearch((parameters) => {
        parameters.set("identity", encodeIdentityScope(scope));
    });
}

/** Leaves the address of a computer whose access ended for the plain chat address, without adding a history entry. */
export function leaveComputerAddress(): void {
    const destination = new URL(window.location.href);
    destination.pathname = "/chat";
    destination.searchParams.delete("identity");
    destination.searchParams.delete("sessionId");
    destination.hash = "";
    window.history.replaceState(window.history.state, "", destination);
}
