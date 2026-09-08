import * as v from "valibot";
import type { CloudBindings } from "../gateway/business-gateway.ts";
import { type AuthenticationConfiguration, configurationSchema } from "./authentication-configuration.ts";

export class ConfigurationStorage {
    private readonly bindings: CloudBindings;

    constructor(cx: { readonly config: { readonly bindings: CloudBindings } }) {
        this.bindings = cx.config.bindings;
    }

    readonly read = (): AuthenticationConfiguration | null => {
        const parsed = v.safeParse(configurationSchema, this.bindings);
        return parsed.success ? parsed.output : null;
    };
}
