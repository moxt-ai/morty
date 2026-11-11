import * as v from "valibot";
import { ComputerManagementError } from "../../contracts/relay/computer-management.ts";

function decodeStorageRecord<TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
    schema: TSchema,
    record: unknown,
): v.InferOutput<TSchema> {
    const result = v.safeParse(schema, record);
    if (!result.success) {
        throw new ComputerManagementError(
            "relay_record_invalid",
            "The Relay database returned an invalid record",
            500,
            { cause: new v.ValiError(result.issues) },
        );
    }
    return result.output;
}

export function decodeOptionalStorageRecord<TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
    schema: TSchema,
    record: unknown,
): v.InferOutput<TSchema> | null {
    return record === null ? null : decodeStorageRecord(schema, record);
}
