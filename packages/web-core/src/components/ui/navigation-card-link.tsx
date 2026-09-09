import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";

export function NavigationCardLink({
    to,
    search = {},
    label,
    className,
    children,
}: {
    readonly to: string;
    readonly search?: Readonly<Record<string, string>>;
    readonly label: string;
    readonly className: string;
    readonly children: (pending: boolean) => ReactNode;
}) {
    const router = useRouter();
    const destination = router.buildLocation({ to, search });
    const pending = useRouterState({
        select: (state) => state.status === "pending" && state.location.href === destination.href,
    });
    return (
        <Link
            to={to}
            search={search}
            aria-label={label}
            aria-busy={pending}
            aria-disabled={pending}
            onClick={(event) => {
                if (pending) {
                    event.preventDefault();
                }
            }}
            className={`${className} aria-busy:cursor-progress aria-busy:bg-muted aria-busy:text-muted-foreground`}
        >
            {children(pending)}
        </Link>
    );
}
