import { isIdentifier, PROJECT_PERMISSION_NAMES } from "@morty-build/client/protocol";
import { MortyProtocolError, MortyValidationError } from "./errors.ts";
import type { MortyCredentialProvider } from "./service-client.ts";

export const MORTY_PROJECT_PERMISSIONS: readonly string[] = PROJECT_PERMISSION_NAMES;

function text(value: Readonly<Record<string, unknown>>, key: string, name: string, allowEmpty = false): string {
    const field = value[key];
    if (typeof field !== "string" || (!allowEmpty && field.length === 0)) {
        throw new MortyProtocolError(`The service returned an invalid ${name}`);
    }
    return field;
}

function optionalIdentifierField(value: Readonly<Record<string, unknown>>, key: string, name: string): string {
    const field = text(value, key, name, true);
    if (field.length > 0 && !isIdentifier(field)) {
        throw new MortyProtocolError(`The service returned an invalid ${name}`);
    }
    return field;
}

function timestamp(value: Readonly<Record<string, unknown>>, key: string, name: string, allowEmpty = false): string {
    const field = text(value, key, name, allowEmpty);
    if (field.length > 0 && Number.isNaN(Date.parse(field))) {
        throw new MortyProtocolError(`The service returned an invalid ${name}`);
    }
    return field;
}

function _booleanField(value: Readonly<Record<string, unknown>>, key: string, name: string): boolean {
    const field = value[key];
    if (typeof field !== "boolean") {
        throw new MortyProtocolError(`The service returned an invalid ${name}`);
    }
    return field;
}

function hasControlCharacters(value: string): boolean {
    for (const character of value) {
        const codePoint = character.codePointAt(0) ?? 0;
        if (codePoint <= 31 || codePoint === 127) {
            return true;
        }
    }
    return false;
}

function credential(value: string): string {
    if (value.length === 0 || value.length > 16 * 1024 || hasControlCharacters(value)) {
        throw new MortyValidationError("The credential is invalid");
    }
    return value;
}

export class MortyCredentialLifecycle {
    static readonly Current = new MortyCredentialLifecycle("current");
    static readonly Replaced = new MortyCredentialLifecycle("replaced");
    static readonly Revoked = new MortyCredentialLifecycle("revoked");

    readonly value: string;

    private constructor(value: string) {
        this.value = value;
    }

    readonly toJSON = (): string => this.value;
}

export abstract class MortyCredentialReplacement {
    abstract readonly exists: boolean;
}

export class MortyNoCredentialReplacement extends MortyCredentialReplacement {
    readonly exists = false;
}

export class MortyRecordedCredentialReplacement extends MortyCredentialReplacement {
    readonly credentialId: string;
    readonly exists = true;
    readonly overlapEndsAt: string;

    constructor(credentialId: string, overlapEndsAt: string) {
        super();
        this.credentialId = credentialId;
        this.overlapEndsAt = overlapEndsAt;
    }
}

export abstract class MortyCredentialState {
    abstract readonly lifecycle: MortyCredentialLifecycle;
}

export class MortyCurrentCredentialState extends MortyCredentialState {
    readonly lifecycle = MortyCredentialLifecycle.Current;
}

export class MortyReplacedCredentialState extends MortyCredentialState {
    readonly lifecycle = MortyCredentialLifecycle.Replaced;
    readonly replacement: MortyRecordedCredentialReplacement;

    constructor(replacement: MortyRecordedCredentialReplacement) {
        super();
        this.replacement = replacement;
    }
}

export class MortyRevokedCredentialState extends MortyCredentialState {
    readonly lifecycle = MortyCredentialLifecycle.Revoked;
    readonly replacement: MortyCredentialReplacement;
    readonly revokedAt: string;

    constructor(revokedAt: string, replacement: MortyCredentialReplacement) {
        super();
        this.revokedAt = revokedAt;
        this.replacement = replacement;
    }
}

function _credentialState(value: Readonly<Record<string, unknown>>, name: string): MortyCredentialState {
    const overlapEndsAt = timestamp(value, "overlapEndsAt", name, true);
    const replacementCredentialId = optionalIdentifierField(value, "replacedByCredentialId", name);
    const revokedAt = timestamp(value, "revokedAt", name, true);
    if ((overlapEndsAt.length === 0) !== (replacementCredentialId.length === 0)) {
        throw new MortyProtocolError(`The service returned an invalid ${name}`);
    }
    const replacement =
        replacementCredentialId.length === 0
            ? new MortyNoCredentialReplacement()
            : new MortyRecordedCredentialReplacement(replacementCredentialId, overlapEndsAt);
    if (revokedAt.length > 0) {
        return new MortyRevokedCredentialState(revokedAt, replacement);
    }
    if (replacement instanceof MortyRecordedCredentialReplacement) {
        return new MortyReplacedCredentialState(replacement);
    }
    return new MortyCurrentCredentialState();
}

export class RotatingMortyCredentialProvider implements MortyCredentialProvider {
    #credential: string;

    constructor(initialCredential: string) {
        this.#credential = credential(initialCredential);
    }

    readonly credential = async (signal: AbortSignal): Promise<string> => {
        signal.throwIfAborted();
        return this.#credential;
    };

    readonly replace = (replacement: { readonly credential: string }): void => {
        this.#credential = credential(replacement.credential);
    };
}
