import { describe, expect, expectTypeOf, it } from "vitest";
import {
    COMPUTER_LOCATION_HINTS,
    type ComputerLocationHint,
    isComputerLocationHint,
} from "../../src/protocol/index.ts";

describe("Computer location protocol contract", () => {
    it("Given Computer location values, When they are checked, Then only the published location hints are accepted", () => {
        expect(COMPUTER_LOCATION_HINTS).toEqual([
            "wnam",
            "enam",
            "sam",
            "weur",
            "eeur",
            "apac",
            "apac-ne",
            "apac-se",
            "oc",
            "afr",
            "me",
        ]);
        expect(COMPUTER_LOCATION_HINTS.every(isComputerLocationHint)).toBe(true);
        expect(isComputerLocationHint("moon")).toBe(false);
        expect(isComputerLocationHint(null)).toBe(false);
        expectTypeOf<(typeof COMPUTER_LOCATION_HINTS)[number]>().toEqualTypeOf<ComputerLocationHint>();
    });
});
