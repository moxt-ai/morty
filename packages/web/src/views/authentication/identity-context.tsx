import { createContext, type ReactNode, useContext } from "react";

export type ActiveIdentity =
    | {
          readonly getToken: (signal: AbortSignal) => Promise<string | null>;
          readonly kind: "anonymous";
      }
    | {
          readonly getToken: (signal: AbortSignal) => Promise<string | null>;
          readonly kind: "clerk";
      };

const IdentityContext = createContext<ActiveIdentity | null>(null);

export function ActiveIdentityProvider({
    children,
    value,
}: {
    readonly children: ReactNode;
    readonly value: ActiveIdentity;
}) {
    return <IdentityContext value={value}>{children}</IdentityContext>;
}

export function useActiveIdentity(): ActiveIdentity {
    const identity = useContext(IdentityContext);
    if (identity === null) {
        throw new Error("Active identity is unavailable");
    }
    return identity;
}
