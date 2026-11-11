import { eq } from "drizzle-orm";
import { machineAccount } from "../schema/d1/index.ts";

export const computerServed = eq(machineAccount.lifecycle, "active");
