import { createContext, type PropsWithChildren, useContext, useMemo } from "react";
import type { GetToken } from "@/services/slack/request";

export interface MobiusSlackContextValue {
    readonly mobiusUrl: string;
    readonly getToken: GetToken;
    readonly tenantId: string;
    readonly projectId: string;
}

type MobiusSlackUrlResolver = (path: string) => string;

const Context = createContext<MobiusSlackUrlResolver | null>(null);
const IdentityContext = createContext<MobiusSlackContextValue | null>(null);

export function MobiusSlackContext({
    children,
    context,
}: PropsWithChildren<{ readonly context: MobiusSlackContextValue }>) {
    const resolve = useMemo<MobiusSlackUrlResolver>(() => {
        const base = new URL(context.mobiusUrl);
        if ((base.protocol !== "http:" && base.protocol !== "https:") || base.username !== "" || base.password !== "") {
            throw new Error("Mobius Slack URL must be an HTTP origin");
        }
        return (path) => {
            const url = new URL(path, base.origin);
            url.searchParams.set("projectId", context.projectId);
            return url.toString();
        };
    }, [context.mobiusUrl, context.projectId]);
    return (
        <Context value={resolve}>
            <IdentityContext value={context}>{children}</IdentityContext>
        </Context>
    );
}

export function useMobiusSlackIdentity(): MobiusSlackContextValue {
    const identity = useContext(IdentityContext);
    if (identity === null) {
        throw new Error("MobiusSlackContext is required");
    }
    return identity;
}

export function useMobiusSlackUrl(): MobiusSlackUrlResolver {
    const resolve = useContext(Context);
    if (resolve === null) {
        throw new Error("MobiusSlackContext is required");
    }
    return resolve;
}
