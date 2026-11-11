import { eq } from "drizzle-orm";
import { computerAccount } from "../../../schema/d1/index.ts";

export const projectServed = eq(computerAccount.lifecycle, "active");
