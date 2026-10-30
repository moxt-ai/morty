import { CircleAlert, CircleCheck, Info, type LucideIcon, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const alertChrome = "flex gap-2 rounded-[20px] border-[0.5px] px-4 py-3 [overflow-wrap:anywhere]";

const alertTones = {
    error: {
        icon: CircleAlert,
        role: "alert",
        iconClassName: undefined,
        surface: "items-start border-destructive/20 bg-[oklch(0.97_0.02_27/0.6)] text-destructive backdrop-blur-[80px]",
    },
    warning: {
        icon: TriangleAlert,
        role: "alert",
        iconClassName: undefined,
        surface:
            "items-start border-[oklch(0.62_0.14_75/0.28)] bg-[oklch(0.98_0.03_85/0.6)] text-[oklch(0.52_0.13_70)] backdrop-blur-[80px]",
    },
    success: {
        icon: CircleCheck,
        role: "status",
        iconClassName: undefined,
        surface: "items-start border-success/20 bg-[oklch(0.97_0.025_163/0.6)] text-success backdrop-blur-[80px]",
    },
    info: {
        icon: Info,
        role: "status",
        iconClassName: undefined,
        surface:
            "items-start border-[oklch(0.55_0.1_250/0.28)] bg-[oklch(0.97_0.02_250/0.6)] text-[oklch(0.45_0.12_255)] backdrop-blur-[80px]",
    },
    neutral: {
        icon: null,
        // Neutral headlines render muted, so a passed icon matches them instead of the surface ink.
        iconClassName: "text-muted-foreground",
        role: "status",
        surface: "items-start border-border bg-surface-elevated text-foreground",
    },
} as const satisfies Record<
    string,
    {
        readonly icon: LucideIcon | null;
        readonly iconClassName?: string | undefined;
        readonly role: "alert" | "status";
        readonly surface: string;
    }
>;

export type MortyAlertTone = keyof typeof alertTones;

export function MortyAlert({
    children,
    className,
    description,
    icon,
    testId,
    tone = "error",
}: {
    readonly children: ReactNode;
    readonly className?: string | undefined;
    readonly description?: ReactNode;
    readonly icon?: LucideIcon | undefined;
    /** Identifies the notice as a whole for interaction tests, headline included. */
    readonly testId?: string | undefined;
    readonly tone?: MortyAlertTone;
}) {
    const selected = alertTones[tone];
    const Icon = icon ?? selected.icon;
    return (
        <div className={cn(alertChrome, selected.surface, className)} data-testid={testId} role={selected.role}>
            {Icon !== null && (
                <Icon aria-hidden="true" className={cn("mt-1 size-3.5 shrink-0", selected.iconClassName)} />
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-1 text-13">
                <div className="min-w-0 font-medium">{children}</div>
                {description !== undefined && <div className="text-12 text-muted-foreground">{description}</div>}
            </div>
        </div>
    );
}
