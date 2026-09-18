import { FakeClerk } from "@moxt-ai/mobius-test/clerk";

export const AUTH_TIME = new Date("2026-09-07T00:00:00.000Z");
export const APP_ORIGIN = "http://localhost:5173";
export const clerk = new FakeClerk({ issuer: "https://identity.clerk.accounts.dev" });
