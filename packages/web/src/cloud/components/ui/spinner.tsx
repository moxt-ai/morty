import { LoaderCircle } from "lucide-react";

export function Spinner({ label }: { readonly label: string }) {
    return (
        <span
            role="status"
            aria-label={label}
            className="inline-flex shrink-0 items-center justify-center text-muted-foreground"
        >
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
        </span>
    );
}
