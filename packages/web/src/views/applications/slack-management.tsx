import { useAuth } from "@clerk/react";
import { useCallback } from "react";
import { MobiusSlackContext } from "../../components/slack/mobius-slack-context.tsx";
import { SlackBotManageView } from "../../components/slack/slack-bot-manage-view.tsx";
import { waitForClerk } from "../../view-models/authentication/session.ts";

export function SlackManagement({ userId }: { readonly userId: string }) {
    const { isLoaded, getToken } = useAuth();
    const getSlackToken = useCallback((signal: AbortSignal) => waitForClerk(() => getToken(), signal), [getToken]);
    if (!isLoaded) {
        return <Spinner label="Loading Slack integrations" />;
    }
    return (
        <MobiusSlackContext context={{ mobiusUrl: window.location.origin, tenantId: userId, getToken: getSlackToken }}>
            <div key={userId} className="grid gap-8">
                <SlackBotManageView />
            </div>
        </MobiusSlackContext>
    );
}

import { Spinner } from "../../components/ui/spinner.tsx";
