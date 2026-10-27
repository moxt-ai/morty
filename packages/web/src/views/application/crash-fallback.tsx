import type { BugReportDialogStore } from "../../view-models/bug-report-dialog-store.ts";
import { BugReportButton, BugReportDialogHost } from "../diagnostics/bug-report-button.tsx";
import {
    SetupCardDescription,
    SetupCardFailureIcon,
    SetupCardShell,
    SetupCardTitle,
} from "../setup/setup-card-shell.tsx";

/** The document-level fallback shown when rendering the application throws. */
export function MortyCrashFallback({ dialog }: { readonly dialog: BugReportDialogStore }) {
    return (
        <>
            <SetupCardShell
                cardClassName="pb-10"
                cardLeading={<SetupCardFailureIcon />}
                showPageHeader
                titleId="crash-title"
            >
                <div role="alert">
                    <SetupCardTitle id="crash-title">Morty encountered an error</SetupCardTitle>
                    <SetupCardDescription>Please reload to try again.</SetupCardDescription>
                </div>
            </SetupCardShell>
            <BugReportButton appearance="floating" dialog={dialog} />
            <BugReportDialogHost dialog={dialog} />
        </>
    );
}
