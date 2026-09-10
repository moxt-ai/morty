import { useMemo } from "react";
import * as v from "valibot";
import { useMobiusSlackIdentity } from "../mobius-slack-context";
import { RequestError } from "./request/request";

export const projectCredentialSchema = v.pipe(
    v.object({
        projectId: v.string(),
        channelId: v.string(),
        tenantId: v.string(),
        hostToken: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{32,256}$/u)),
    }),
    v.readonly(),
);
type ProjectCredential = v.InferOutput<typeof projectCredentialSchema>;

class ProjectAccessError extends RequestError {
    readonly code = "PROJECT_ACCESS_REQUIRED";
}

export class BrowserProjectCredentials {
    readonly #namespace: string;
    constructor(namespace: string) {
        this.#namespace = namespace;
    }
    readonly #key = (projectId: string) =>
        `mobius:project-credential:${this.#namespace}:${encodeURIComponent(projectId)}`;
    readonly read = (projectId: string): ProjectCredential | null => {
        try {
            const encoded = window.localStorage.getItem(this.#key(projectId));
            if (encoded === null) {
                for (let index = 0; index < window.localStorage.length; index += 1) {
                    const key = window.localStorage.key(index);
                    if (key === null || !key.startsWith("mobius:channel-credential:")) {
                        continue;
                    }
                    const native: unknown = JSON.parse(window.localStorage.getItem(key) ?? "null");
                    const parsed = v.safeParse(
                        v.object({
                            projectId: v.string(),
                            tenantId: v.string(),
                            hostToken: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{32,256}$/u)),
                        }),
                        native,
                    );
                    if (parsed.success && parsed.output.projectId === projectId) {
                        return { ...parsed.output, channelId: key.slice("mobius:channel-credential:".length) };
                    }
                }
                return null;
            }
            const value: unknown = JSON.parse(encoded);
            const parsed = v.safeParse(projectCredentialSchema, value);
            return parsed.success && parsed.output.projectId === projectId ? parsed.output : null;
        } catch {
            return null;
        }
    };
    readonly require = (projectId: string): string => {
        const saved = this.read(projectId);
        if (saved === null) {
            throw new ProjectAccessError(
                "Open this project in the browser that created its pairing. This browser has no saved owner access.",
            );
        }
        return saved.hostToken;
    };
    readonly save = (credential: ProjectCredential): void => {
        const value = v.parse(projectCredentialSchema, credential);
        try {
            window.localStorage.setItem(this.#key(value.projectId), JSON.stringify(value));
        } catch (cause) {
            throw new ProjectAccessError(
                "This browser could not save project access. Enable browser storage and try again.",
                { cause },
            );
        }
    };
}

export function useProjectCredentials(): BrowserProjectCredentials {
    const { mobiusUrl, tenantId } = useMobiusSlackIdentity();
    return useMemo(
        () =>
            new BrowserProjectCredentials(
                `${encodeURIComponent(new URL(mobiusUrl).origin)}:${encodeURIComponent(tenantId)}`,
            ),
        [mobiusUrl, tenantId],
    );
}
