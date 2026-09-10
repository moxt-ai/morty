import { DurableObject } from "cloudflare:workers";
import * as v from "valibot";

const WINDOW_MILLISECONDS = 60 * 60 * 1_000;
const MAX_TRIGGERS_PER_WINDOW = 20;

const windowStateSchema = v.pipe(
    v.object({
        count: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
        windowStartedAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    }),
    v.readonly(),
    v.transform((value) => Object.freeze(value)),
);

export class BotTriggerRateLimiter extends DurableObject {
    readonly admit = async (nowEpochMilliseconds: number): Promise<boolean> =>
        await this.ctx.storage.transaction(async (transaction) => {
            const persisted: unknown = await transaction.get("window");
            const parsed = v.safeParse(windowStateSchema, persisted);
            const windowExpired =
                !parsed.success || nowEpochMilliseconds - parsed.output.windowStartedAt >= WINDOW_MILLISECONDS;
            if (windowExpired) {
                await transaction.put("window", {
                    count: 1,
                    windowStartedAt: nowEpochMilliseconds,
                });
                return true;
            }
            if (parsed.output.count >= MAX_TRIGGERS_PER_WINDOW) {
                return false;
            }
            await transaction.put("window", {
                count: parsed.output.count + 1,
                windowStartedAt: parsed.output.windowStartedAt,
            });
            return true;
        });
}
