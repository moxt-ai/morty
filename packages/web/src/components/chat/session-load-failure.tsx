import { Unplug } from "lucide-react";

import { dataTestId } from "@/data-testid";
import { describeSessionFailureMessage } from "@/view-models/format-error";

export function SessionLoadFailure({ message }: Readonly<{ message: string }>) {
    const copy = describeSessionFailureMessage(message);

    if (copy.detail === undefined) {
        return (
            <p data-testid={dataTestId.sessionLoadFailure} role="alert">
                {copy.title}
            </p>
        );
    }

    return (
        <div
            className="grid max-w-lg justify-items-center gap-3 text-center"
            data-testid={dataTestId.sessionLoadFailure}
            role="alert"
        >
            <span className="flex size-14 items-center justify-center rounded-full bg-morty-fill-opacity-2 text-morty-text-3">
                <Unplug aria-hidden="true" className="size-6" />
            </span>
            <p className="text-[18px] leading-6 font-semibold tracking-[-0.025em]">{copy.title}</p>
            <p className="max-w-sm text-sm leading-6 text-muted-foreground">{copy.detail}</p>
        </div>
    );
}
