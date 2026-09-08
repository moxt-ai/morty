import * as v from "valibot";
import type { CloudBindings } from "../gateway/business-gateway.ts";
import { type AuthenticationConfiguration, configurationSchema } from "./authentication-configuration.ts";

export class ConfigurationStorage {
    static readonly inject = ["bindings"] as const;

    private readonly bindings: CloudBindings;

    constructor(bindings: CloudBindings) {
        this.bindings = bindings;
    }

    readonly read = (): AuthenticationConfiguration | null => {
        const parsed = v.safeParse(configurationSchema, this.bindings);
        return parsed.success ? parsed.output : null;
    };
}
