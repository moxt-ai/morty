import type { ManagedChatSession } from "../../services/chat/bot-chat-api.ts";

export interface ConversationGroup {
    readonly label: string;
    readonly sessions: readonly ManagedChatSession[];
}

const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;

export function localCalendarDay(date: Date): number {
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

function conversationGroupLabel(updatedAt: Date, calendarDay: number): string {
    const daysAgo = Math.floor((calendarDay - localCalendarDay(updatedAt)) / DAY_MILLISECONDS);
    if (daysAgo <= 0) {
        return "Today";
    }
    if (daysAgo === 1) {
        return "Yesterday";
    }
    if (daysAgo <= 7) {
        return "Previous 7 Days";
    }
    if (daysAgo <= 30) {
        return "Previous 30 Days";
    }
    return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(updatedAt);
}

export function groupConversationsByUpdatedAt(
    sessions: readonly ManagedChatSession[],
    calendarDay: number,
): readonly ConversationGroup[] {
    const groups: ConversationGroup[] = [];
    const sorted = sessions
        .map((session) => ({ session, updatedAt: new Date(session.updatedAt) }))
        .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
    for (const { session, updatedAt } of sorted) {
        const label = conversationGroupLabel(updatedAt, calendarDay);
        const previous = groups.at(-1);
        if (previous?.label === label) {
            groups[groups.length - 1] = { label, sessions: [...previous.sessions, session] };
        } else {
            groups.push({ label, sessions: [session] });
        }
    }
    return groups;
}
