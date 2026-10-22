import { LoaderCircle } from "lucide-react";

const sizes = {
    default: "size-4",
    large: "size-[24px]",
};

export function Spinner({ label, size = "default" }: { readonly label: string; readonly size?: keyof typeof sizes }) {
    return (
        <span
            role="status"
            aria-label={label}
            className="inline-flex shrink-0 items-center justify-center text-muted-foreground"
        >
            <LoaderCircle aria-hidden="true" className={`${sizes[size]} animate-spin motion-reduce:animate-none`} />
        </span>
    );
}
