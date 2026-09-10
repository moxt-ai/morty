import { type ChannelConnection, MobiusChat, readChannelConnection } from "../../../mobius/index.ts";
import { type ApplicationConnectionProps, BrowserChannelConnection } from "../../view-models/channel-connection.ts";
import { type ChatApplicationProps, MobiusApplications } from "./application-navigation.tsx";
import { ProjectBotManagement } from "./project-bot-management.tsx";
import { SlackManagement } from "./slack-management.tsx";

function ChatApplication({ connection }: ChatApplicationProps<ChannelConnection>) {
    return <MobiusChat connection={connection} />;
}

function SlackApplication({ userId }: { readonly userId: string }) {
    return <SlackManagement userId={userId} />;
}

export function userBotConnection(userId: string) {
    return new BrowserChannelConnection(userId, window.localStorage, readChannelConnection);
}

export function MobiusManagement(props: ApplicationConnectionProps<ChannelConnection>) {
    return (
        <MobiusApplications
            {...props}
            ChatApplication={ChatApplication}
            SlackApplication={SlackApplication}
            ProjectsApplication={ProjectBotManagement}
        />
    );
}
