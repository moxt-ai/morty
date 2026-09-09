import { useAuth } from "@clerk/react";
import { MobiusBotsManageView, MobiusSlackContext, SlackBotManageView } from "@moxt-ai/app-slack-web-core";
import { useCallback } from "react";
import { waitForClerk } from "../../view-models/workspaces/clerk-directory.ts";

function Management({ application }: { readonly application: "projects" | "slack" }) {
    const { isLoaded, orgId, getToken } = useAuth();
    const getSlackToken = useCallback((signal: AbortSignal) => waitForClerk(() => getToken(), signal), [getToken]);
    if (!isLoaded) {
        return <p role="status">Loading Slack integrations…</p>;
    }
    if (!orgId) {
        return <p role="alert">Select this workspace to manage Slack integrations.</p>;
    }
    return (
        <MobiusSlackContext context={{ mobiusUrl: window.location.origin, tenantId: orgId, getToken: getSlackToken }}>
            <div key={orgId} className="grid gap-8">
                {application === "projects" ? <MobiusBotsManageView /> : <SlackBotManageView />}
            </div>
        </MobiusSlackContext>
    );
}

export function SlackManagement() {
    return <Management application="slack" />;
}

export function ProjectBotManagement() {
    return <Management application="projects" />;
}
