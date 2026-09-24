import { MobiusAgentActivityEvent, type MobiusSessionEvent } from "@moxt-ai/mobius-sdk";

export interface RecordedAgentActivity {
    readonly sequence: bigint;
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

export function recordAgentActivity(
    current: ReadonlyMap<string, RecordedAgentActivity>,
    event: MobiusSessionEvent,
): ReadonlyMap<string, RecordedAgentActivity> {
    const activity = event.payload;
    if (!(activity instanceof MobiusAgentActivityEvent)) {
        return current;
    }
    const key = agentActivityKey(activity);
    const sequence = BigInt(event.sequence);
    const previous = current.get(key);
    if (previous !== undefined && previous.sequence >= sequence) {
        return current;
    }
    // Activity output is a cumulative snapshot, not a text delta.
    return new Map(current).set(key, { sequence, activity });
}
