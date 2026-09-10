import { useAuth } from "@clerk/react";
import { useCallback } from "react";
import { MobiusSlackContext } from "../../components/slack/mobius-slack-context.tsx";
import { SlackBotManageView } from "../../components/slack/slack-bot-manage-view.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { waitForClerk } from "../../view-models/authentication/session.ts";
import { useActiveIdentity } from "../authentication/identity-context.tsx";

export function SlackManagement({ userId }: { readonly userId: string }) {
    const { isLoaded, getToken } = useAuth();
    const identity = useActiveIdentity();
    const getSlackToken = useCallback((signal: AbortSignal) => waitForClerk(() => getToken(), signal), [getToken]);
    if (!isLoaded) {
        return <Spinner label="Loading Slack integrations" />;
    }
    if (identity.kind === "anonymous") {
        return (
            <div className="rounded-xl border border-border bg-card p-6">
                <h1 className="text-xl font-semibold">Sign in to use Slack</h1>
                <p className="mt-2 text-sm text-muted-foreground">Your bots and Chat remain available anonymously.</p>
                <Button asChild className="mt-5">
                    <a href="/login">Sign in</a>
                </Button>
            </div>
        );
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
