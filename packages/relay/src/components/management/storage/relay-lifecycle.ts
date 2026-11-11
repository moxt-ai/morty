import { eq } from "drizzle-orm";
import { machineAccount } from "../../../schema/d1/index.ts";

export const projectServed = eq(machineAccount.lifecycle, "active");
