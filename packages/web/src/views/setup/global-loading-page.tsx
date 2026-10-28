import { LoadingWave } from "../../components/ui/loading-wave.tsx";
import { SetupPageWithHeader } from "./setup-card-shell.tsx";

/** One whole-document loading surface for every application entry point. */
export function GlobalLoadingPage({ label }: { readonly label: string }) {
    return (
        <SetupPageWithHeader>
            <span role="status" aria-label={label}>
                <LoadingWave size="lg" />
            </span>
        </SetupPageWithHeader>
    );
}
