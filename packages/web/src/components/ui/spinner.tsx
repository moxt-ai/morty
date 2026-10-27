import { LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";

const sizes = {
    default: "size-4",
    large: "size-[24px]",
};

export function Spinner({
    className = "",
    label,
    size = "default",
}: {
    readonly className?: string;
    readonly label: string;
    readonly size?: keyof typeof sizes;
}) {
    return (
        <span
            role="status"
            aria-label={label}
            className={cn("inline-flex shrink-0 items-center justify-center text-muted-foreground", className)}
        >
            <LoaderCircle aria-hidden="true" className={`${sizes[size]} animate-spin motion-reduce:animate-none`} />
        </span>
    );
}
