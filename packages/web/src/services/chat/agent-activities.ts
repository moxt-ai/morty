import { MobiusAgentActivityEvent, type MobiusSessionEvent } from "@moxt-ai/mobius-sdk";

export interface RecordedAgentActivity {
    readonly sequence: bigint;
    readonly activity: MobiusAgentActivityEvent;
}

export function activitiesForTurn(
    activities: ReadonlyMap<string, RecordedAgentActivity>,
    sessionId: string,
    commandId: string,
): readonly MobiusAgentActivityEvent[] {
    return [...activities.values()]
        .map((record) => record.activity)
        .filter((activity) => activity.sessionId === sessionId && activity.commandId === commandId)
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
    const key = JSON.stringify([activity.sessionId, activity.commandId, activity.activityId]);
    const sequence = BigInt(event.sequence);
    const previous = current.get(key);
    if (previous !== undefined && previous.sequence >= sequence) {
        return current;
    }
    // Activity output is a cumulative snapshot, not a text delta.
    return new Map(current).set(key, { sequence, activity });
}
