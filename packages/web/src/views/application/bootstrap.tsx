import { ApiTransportProvider } from "../../services/api/api-transport-context.tsx";
import type { MortyApplication } from "../../view-models/morty-application.ts";
import { SessionApplication } from "../authentication/session-application.tsx";
import { MortyApplicationProvider } from "./application-context.tsx";

export function Bootstrap({ application }: { readonly application: MortyApplication }) {
    return (
        <ApiTransportProvider transport={application.transport}>
            <MortyApplicationProvider application={application}>
                <SessionApplication application={application} />
            </MortyApplicationProvider>
        </ApiTransportProvider>
    );
}
