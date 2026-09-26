import {
    MobiusAgentActivityEvent,
    MobiusAgentActivityNarrationEvent,
    type MobiusSessionEvent,
} from "@moxt-ai/mobius-sdk";

export interface RecordedAgentActivity {
    readonly sequence: bigint;
    readonly activity: MobiusAgentActivityEvent;
}

export function agentActivityKey(activity: MobiusAgentActivityEvent): string {
    return JSON.stringify([activity.sessionId, activity.commandId, activity.activityId]);
}

export function agentNarrationKey(activity: MobiusAgentActivityNarrationEvent): string {
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
    const previous = current.get(key);
    if (event.sequence === "") {
        // Runtime Session events currently arrive without committed envelope metadata.
        // Their transport order is authoritative, while activity.sequence identifies
        // the activity's position and remains constant across its status updates.
        return new Map(current).set(key, {
            sequence: previous?.sequence ?? BigInt(activity.sequence),
            activity,
        });
    }
    const sequence = BigInt(event.sequence);
    if (previous !== undefined && previous.sequence >= sequence) {
        return current;
    }
    // Activity output is a cumulative snapshot, not a text delta.
    return new Map(current).set(key, { sequence, activity });
}

export function recordAgentNarration(
    current: ReadonlyMap<string, RecordedAgentActivity>,
    event: MobiusSessionEvent,
): ReadonlyMap<string, RecordedAgentActivity> {
    const narration = event.payload;
    if (!(narration instanceof MobiusAgentActivityNarrationEvent)) {
        return current;
    }
    const key = agentNarrationKey(narration);
    const previous = current.get(key);
    const sequence =
        event.sequence === "" ? (previous?.sequence ?? BigInt(narration.sequence)) : BigInt(event.sequence);
    if (event.sequence !== "" && previous !== undefined && previous.sequence >= sequence) {
        return current;
    }
    const activity = new MobiusAgentActivityEvent({
        activityId: narration.activityId,
        activityType: narration.activityType,
        commandId: narration.commandId,
        content: previous?.activity.content ?? [],
        detail: { kind: "unrecorded" },
        input: previous?.activity.input ?? "",
        kind: "agent.activity",
        locations: previous?.activity.locations ?? [],
        name: previous?.activity.name ?? "",
        output: `${previous?.activity.output ?? ""}${narration.text}`,
        sequence: narration.sequence,
        sessionId: narration.sessionId,
        status: "running",
        title: previous?.activity.title ?? (narration.activityType === "reasoning" ? "Reasoning" : "Progress update"),
        toolKind: previous?.activity.toolKind ?? "",
    });
    return new Map(current).set(key, { sequence, activity });
}
