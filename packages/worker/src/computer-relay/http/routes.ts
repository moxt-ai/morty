import { decodeFileReadCommand, MORTY_API_PREFIX } from "@morty-build/client/protocol";
import { Hono, type MiddlewareHandler } from "hono";
import * as v from "valibot";
import type { ComputerApplication } from "../../contracts/computer-application.ts";
import { COMPUTER_INTERNAL_PREFIX } from "../../contracts/computer-relay-http.ts";
import { validateIdentifier } from "../../contracts/relay/pairing.ts";
import { readJsonBody } from "../../http/body-parser.ts";
