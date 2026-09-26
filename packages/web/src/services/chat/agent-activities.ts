import type { MobiusAgentActivityEvent } from "@moxt-ai/mobius-sdk";

export interface RecordedAgentActivity {
    readonly activity: MobiusAgentActivityEvent;
}

export function agentActivityKey(activity: MobiusAgentActivityEvent): string {
    return JSON.stringify([activity.sessionId, activity.commandId, activity.activityId]);
}

export function activitiesForIds(
    activities: ReadonlyMap<string, RecordedAgentActivity>,
    activityIds: readonly string[],
): readonly MobiusAgentActivityEvent[] {
    return activityIds
        .flatMap((activityId) => {
            const recorded = activities.get(activityId);
            return recorded === undefined ? [] : [recorded.activity];
        })
        .sort((left, right) => left.sequence - right.sequence);
}
