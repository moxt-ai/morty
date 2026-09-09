import { useAuth } from "@clerk/react";
import { MobiusSlackContext, SlackBotManageView } from "@moxt-ai/app-slack-web-core";
import { useCallback } from "react";
import { waitForClerk } from "../../view-models/workspaces/clerk-directory.ts";

export function SlackManagement() {
    const { isLoaded, orgId, getToken } = useAuth();
    const getSlackToken = useCallback((signal: AbortSignal) => waitForClerk(() => getToken(), signal), [getToken]);
    if (!isLoaded) {
        return <Spinner label="Loading Slack integrations" />;
    }
    if (!orgId) {
        return <p role="alert">Select this workspace to manage Slack integrations.</p>;
    }
    return (
        <MobiusSlackContext context={{ mobiusUrl: window.location.origin, tenantId: orgId, getToken: getSlackToken }}>
            <div key={orgId} className="grid gap-8">
                <SlackBotManageView />
            </div>
        </MobiusSlackContext>
    );
}

import { Spinner } from "../../components/ui/spinner.tsx";
