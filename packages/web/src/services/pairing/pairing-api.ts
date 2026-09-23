import {
    decodeMobiusAgentCapabilities,
    decodeRecordedAgentContentValue,
    MobiusApiError,
    MobiusClient,
    MobiusError,
    MobiusPageRequest,
    type MobiusRuntimeDescriptor,
    type MobiusRuntimePairing,
    MobiusRuntimePairingRequest,
    type MobiusRuntimePairingStatus,
    type MobiusSession,
    mobiusApiUrl,
    StaticMobiusCredentialProvider,
} from "@moxt-ai/mobius-sdk";
import { centralLocalStorage, channelCredentialEntry } from "@/services/local-storage/central-local-storage";
import {
    AgentIntegrationOption,
    AgentOption,
    type BrowserPairingStatus,
    ChannelConnection,
    ChannelHistory,
    ConnectedBrowserPairingStatus,
    CreatedChannelAccessGrant,
    CreatedPairing,
    ExpiredBrowserPairingStatus,
    type InstallableAgentOption,
    isIdentifier,
    isPairingCode,
    isToken,
    LinkedChannelDevice,
    MissingAgentOption,
    PairingApiError,
    RecordedSession,
    type RecordedTurn,
    WaitingBrowserPairingStatus,
} from "@/view-models/chat/channel";

const REQUEST_TIMEOUT_MILLISECONDS = 20_000;

export type ActivityDetailResult =
    | {
          readonly artifactId: string;
          readonly content: readonly ReturnType<typeof decodeRecordedAgentContentValue>[];
          readonly input: string;
          readonly kind: "available";
          readonly output: string;
          readonly storage: "archive" | "hot";
      }
    | {
          readonly capturedBytes: number;
          readonly kind: "truncated";
          readonly originalBytes: number;
      }
    | { readonly kind: "unrecorded" }
    | { readonly deletedAt: Date; readonly kind: "deleted" };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function requestJson(
    url: URL,
    init: RequestInit,
    signal: AbortSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
): Promise<unknown> {
    let response: Response;
    try {
        response = await fetch(url, {
            ...init,
            signal,
        });
    } catch (error) {
        if (signal.aborted) {
            throw error;
        }
        throw new PairingApiError("relay_unavailable", "The pairing relay could not be reached.", { cause: error });
    }

    let value: unknown;
    try {
        value = await response.json();
    } catch (error) {
        if (signal.aborted) {
            throw error;
        }
        throw new PairingApiError("invalid_relay_response", "The pairing relay returned an invalid response.", {
            cause: error,
        });
    }
    if (!response.ok) {
        if (isRecord(value) && isRecord(value["error"])) {
            const code = value["error"]["code"];
            const message = value["error"]["message"];
            if (typeof code === "string" && typeof message === "string") {
                throw new PairingApiError(code, message);
            }
        }
        throw new PairingApiError("pairing_failed", "The pairing relay rejected the request.");
    }
    return value;
}

async function requestEmpty(
    url: URL,
    init: RequestInit,
    signal: AbortSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
): Promise<void> {
    let response: Response;
    try {
        response = await fetch(url, { ...init, signal });
    } catch (error) {
        if (signal.aborted) {
            throw error;
        }
        throw new PairingApiError("relay_unavailable", "The pairing relay could not be reached.", { cause: error });
    }
    if (response.ok) {
        return;
    }
    let value: unknown;
    try {
        value = await response.json();
    } catch (error) {
        throw new PairingApiError("invalid_relay_response", "The pairing relay returned an invalid response.", {
            cause: error,
        });
    }
    if (isRecord(value) && isRecord(value["error"])) {
        const code = value["error"]["code"];
        const message = value["error"]["message"];
        if (typeof code === "string" && typeof message === "string") {
            throw new PairingApiError(code, message);
        }
    }
    throw new PairingApiError("pairing_failed", "The pairing relay rejected the request.");
}

function readDate(value: unknown, field: string): Date {
    if (typeof value !== "string") {
        throw new PairingApiError("invalid_relay_response", `The relay returned an invalid ${field}.`);
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw new PairingApiError("invalid_relay_response", `The relay returned an invalid ${field}.`);
    }
    return date;
}

function readString(value: unknown, field: string, maximumLength: number): string {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > maximumLength) {
        throw new PairingApiError("invalid_relay_response", `The relay returned an invalid ${field}.`);
    }
    return value;
}

function readText(value: unknown, field: string, maximumLength: number): string {
    if (typeof value !== "string" || value.length > maximumLength) {
        throw new PairingApiError("invalid_relay_response", `The relay returned an invalid ${field}.`);
    }
    return value;
}

function readIdentifier(value: unknown, field: string): string {
    if (typeof value !== "string" || !isIdentifier(value)) {
        throw new PairingApiError("invalid_relay_response", `The relay returned an invalid ${field}.`);
    }
    return value;
}

function decodeAgents(value: unknown): readonly AgentOption[] {
    if (!Array.isArray(value) || value.length > 8) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid agent directory.");
    }
    const agents: AgentOption[] = [];
    const identifiers = new Set<string>();
    for (const candidate of value) {
        if (
            !isRecord(candidate) ||
            (Object.keys(candidate).length !== 5 &&
                Object.keys(candidate).length !== 6 &&
                Object.keys(candidate).length !== 7) ||
            !Object.hasOwn(candidate, "agentPath") ||
            !Object.hasOwn(candidate, "agentVersion") ||
            !Object.hasOwn(candidate, "capabilities") ||
            !Object.hasOwn(candidate, "id") ||
            !Object.hasOwn(candidate, "label") ||
            Object.keys(candidate).some(
                (key) =>
                    key !== "agentPath" &&
                    key !== "agentVersion" &&
                    key !== "agentSettingsDiscovery" &&
                    key !== "botSessionConfiguration" &&
                    key !== "capabilities" &&
                    key !== "id" &&
                    key !== "label",
            ) ||
            (Object.hasOwn(candidate, "botSessionConfiguration") &&
                typeof candidate["botSessionConfiguration"] !== "boolean") ||
            (Object.hasOwn(candidate, "agentSettingsDiscovery") &&
                typeof candidate["agentSettingsDiscovery"] !== "boolean")
        ) {
            throw new PairingApiError("invalid_relay_response", "The relay returned an invalid agent directory.");
        }
        const capabilities = decodeMobiusAgentCapabilities(candidate["capabilities"]);
        const id = candidate["id"];
        const label = candidate["label"];
        const agentPath = candidate["agentPath"];
        const agentVersion = candidate["agentVersion"];
        if (
            typeof agentPath !== "string" ||
            agentPath.trim().length === 0 ||
            agentPath.length > 4_096 ||
            typeof agentVersion !== "string" ||
            agentVersion.trim().length === 0 ||
            agentVersion.length > 128 ||
            typeof id !== "string" ||
            !isIdentifier(id) ||
            identifiers.has(id) ||
            typeof label !== "string" ||
            label.trim().length === 0 ||
            label.length > 80
        ) {
            throw new PairingApiError("invalid_relay_response", "The relay returned an invalid agent directory.");
        }
        identifiers.add(id);
        agents.push(
            new AgentOption(
                id,
                label.trim(),
                agentPath,
                agentVersion.trim(),
                capabilities,
                candidate["agentSettingsDiscovery"] === true,
            ),
        );
    }
    return agents;
}

function decodeInstallableAgents(value: unknown): readonly InstallableAgentOption[] {
    if (!Array.isArray(value) || value.length > 8) {
        throw new PairingApiError(
            "invalid_relay_response",
            "The relay returned an invalid installable Agent directory.",
        );
    }
    const agents: InstallableAgentOption[] = [];
    const identifiers = new Set<string>();
    for (const candidate of value) {
        if (!isRecord(candidate)) {
            throw new PairingApiError(
                "invalid_relay_response",
                "The relay returned an invalid installable Agent directory.",
            );
        }
        const id = candidate["id"];
        const label = candidate["label"];
        if (
            typeof id !== "string" ||
            !isIdentifier(id) ||
            identifiers.has(id) ||
            typeof label !== "string" ||
            label.trim().length === 0 ||
            label.length > 80
        ) {
            throw new PairingApiError(
                "invalid_relay_response",
                "The relay returned an invalid installable Agent directory.",
            );
        }
        identifiers.add(id);
        const status = candidate["status"];
        if (
            status === "agent_not_installed" &&
            Object.keys(candidate).length === 3 &&
            Object.hasOwn(candidate, "id") &&
            Object.hasOwn(candidate, "label") &&
            Object.hasOwn(candidate, "status")
        ) {
            agents.push(new MissingAgentOption(id, label.trim()));
            continue;
        }
        if (
            status === "integration_not_installed" &&
            Object.keys(candidate).length === 5 &&
            Object.hasOwn(candidate, "agentPath") &&
            Object.hasOwn(candidate, "agentVersion") &&
            Object.hasOwn(candidate, "id") &&
            Object.hasOwn(candidate, "label") &&
            Object.hasOwn(candidate, "status")
        ) {
            const agentPath = candidate["agentPath"];
            const agentVersion = candidate["agentVersion"];
            if (
                typeof agentPath !== "string" ||
                agentPath.trim().length === 0 ||
                agentPath.length > 4_096 ||
                typeof agentVersion !== "string" ||
                agentVersion.trim().length === 0 ||
                agentVersion.length > 128
            ) {
                throw new PairingApiError(
                    "invalid_relay_response",
                    "The relay returned an invalid installable Agent directory.",
                );
            }
            agents.push(new AgentIntegrationOption(id, label.trim(), agentPath, agentVersion.trim()));
            continue;
        }
        throw new PairingApiError(
            "invalid_relay_response",
            "The relay returned an invalid installable Agent directory.",
        );
    }
    return agents;
}

function decodeCreatedPairing(value: unknown): CreatedPairing {
    if (!isRecord(value)) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid pairing request.");
    }
    const appId = value["appId"] ?? import.meta.env.VITE_MOBIUS_APP_ID;
    const pairingId = value["pairingId"];
    const pairingCode = value["pairingCode"];
    const pollToken = value["pollToken"];
    const channelId = value["channelId"];
    const hostToken = value["hostToken"];
    const tenantId = value["tenantId"];
    const projectId = value["projectId"];
    const runtimeId = value["runtimeId"];
    if (
        typeof appId !== "string" ||
        !isIdentifier(appId) ||
        typeof pairingId !== "string" ||
        !isIdentifier(pairingId) ||
        typeof pairingCode !== "string" ||
        !isPairingCode(pairingCode) ||
        typeof pollToken !== "string" ||
        !isToken(pollToken) ||
        typeof channelId !== "string" ||
        !isIdentifier(channelId) ||
        typeof hostToken !== "string" ||
        !isToken(hostToken) ||
        typeof tenantId !== "string" ||
        !isIdentifier(tenantId) ||
        typeof projectId !== "string" ||
        !isIdentifier(projectId) ||
        typeof runtimeId !== "string" ||
        !isIdentifier(runtimeId)
    ) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid pairing request.");
    }
    return new CreatedPairing(
        appId,
        pairingId,
        pairingCode,
        pollToken,
        channelId,
        readDate(value["expiresAt"], "expiry time"),
        hostToken,
        tenantId,
        projectId,
        runtimeId,
    );
}

abstract class BrowserChannelCredential {
    abstract readonly authority: string;
    readonly hostToken: string;
    readonly projectId: string;
    readonly tenantId: string;

    constructor(hostToken: string, projectId: string, tenantId: string) {
        this.hostToken = hostToken;
        this.projectId = projectId;
        this.tenantId = tenantId;
    }
}

class OwnerBrowserChannelCredential extends BrowserChannelCredential {
    readonly authority = "owner";
}

class LinkedBrowserChannelCredential extends BrowserChannelCredential {
    readonly authority = "linked";
}

class LegacyBrowserChannelCredential extends BrowserChannelCredential {
    readonly authority = "legacy";
}

export abstract class RuntimeManagementAccess {}

export class OwnerRuntimeManagementAccess extends RuntimeManagementAccess {}

class ReadOnlyRuntimeManagementAccess extends RuntimeManagementAccess {}

function saveBrowserChannelCredential(channelId: string, credential: BrowserChannelCredential): void {
    centralLocalStorage.write(channelCredentialEntry(channelId), {
        ...(credential.authority === "owner" || credential.authority === "linked"
            ? { authority: credential.authority }
            : {}),
        hostToken: credential.hostToken,
        projectId: credential.projectId,
        tenantId: credential.tenantId,
    });
}

function saveChannelCredential(pairing: CreatedPairing): void {
    saveBrowserChannelCredential(
        pairing.channelId,
        new OwnerBrowserChannelCredential(pairing.hostToken, pairing.projectId, pairing.tenantId),
    );
}

function readChannelCredential(channelId: string): BrowserChannelCredential {
    const value = centralLocalStorage.read(channelCredentialEntry(channelId));
    if (value === null) {
        throw new PairingApiError("channel_credential_missing", "This browser does not have access to the channel.");
    }
    const hostToken = value.hostToken;
    const tenantId = value.tenantId;
    const projectId = value.projectId;
    const authority = value.authority;
    if (
        typeof hostToken !== "string" ||
        !isToken(hostToken) ||
        typeof tenantId !== "string" ||
        !isIdentifier(tenantId) ||
        typeof projectId !== "string" ||
        !isIdentifier(projectId)
    ) {
        throw new PairingApiError("channel_credential_invalid", "The saved channel credential is invalid.");
    }
    if (authority === "owner") {
        return new OwnerBrowserChannelCredential(hostToken, projectId, tenantId);
    }
    if (authority === "linked") {
        return new LinkedBrowserChannelCredential(hostToken, projectId, tenantId);
    }
    if (authority === undefined) {
        return new LegacyBrowserChannelCredential(hostToken, projectId, tenantId);
    }
    throw new PairingApiError("channel_credential_invalid", "The saved channel credential is invalid.");
}

function decodeCreatedChannelAccessGrant(value: unknown): CreatedChannelAccessGrant {
    if (!isRecord(value)) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid access link.");
    }
    const grantId = value["grantId"];
    const grantSecret = value["grantSecret"];
    if (
        typeof grantId !== "string" ||
        !isIdentifier(grantId) ||
        typeof grantSecret !== "string" ||
        !isToken(grantSecret)
    ) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid access link.");
    }
    return new CreatedChannelAccessGrant(grantId, grantSecret, readDate(value["expiresAt"], "access link expiry time"));
}

function decodeLinkedChannelDevices(value: unknown): readonly LinkedChannelDevice[] {
    if (!isRecord(value) || !Array.isArray(value["devices"])) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid linked device list.");
    }
    const devices: LinkedChannelDevice[] = [];
    const credentialIds = new Set<string>();
    for (const candidate of value["devices"]) {
        if (!isRecord(candidate)) {
            throw new PairingApiError("invalid_relay_response", "The relay returned an invalid linked device.");
        }
        const credentialId = candidate["credentialId"];
        if (typeof credentialId !== "string" || !isIdentifier(credentialId) || credentialIds.has(credentialId)) {
            throw new PairingApiError("invalid_relay_response", "The relay returned an invalid linked device.");
        }
        credentialIds.add(credentialId);
        devices.push(
            new LinkedChannelDevice(
                credentialId,
                readDate(candidate["createdAt"], "linked device creation time"),
                readDate(candidate["lastUsedAt"], "linked device activity time"),
            ),
        );
    }
    return devices;
}

function decodeRedeemedChannelCredential(value: unknown, expectedChannelId: string): BrowserChannelCredential {
    if (!isRecord(value) || value["channelId"] !== expectedChannelId) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid channel credential.");
    }
    const hostToken = value["hostToken"];
    const projectId = value["projectId"];
    const tenantId = value["tenantId"];
    if (
        typeof hostToken !== "string" ||
        !isToken(hostToken) ||
        typeof projectId !== "string" ||
        !isIdentifier(projectId) ||
        typeof tenantId !== "string" ||
        !isIdentifier(tenantId)
    ) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid channel credential.");
    }
    return new LinkedBrowserChannelCredential(hostToken, projectId, tenantId);
}

abstract class ChannelAccessFragmentState {}

class MissingChannelAccessFragment extends ChannelAccessFragmentState {}

class PresentChannelAccessFragment extends ChannelAccessFragmentState {
    readonly grantId: string;
    readonly grantSecret: string;

    constructor(grantId: string, grantSecret: string) {
        super();
        this.grantId = grantId;
        this.grantSecret = grantSecret;
    }
}

function readChannelAccessFragment(): ChannelAccessFragmentState {
    const parameters = new URLSearchParams(window.location.hash.slice(1));
    const accessValues = parameters.getAll("access");
    if (accessValues.length === 0) {
        return new MissingChannelAccessFragment();
    }
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
    if (accessValues.length !== 1 || Array.from(parameters.keys()).length !== 1) {
        throw new PairingApiError("access_link_invalid", "The access link is malformed.");
    }
    const access = accessValues[0] ?? "";
    const separator = access.indexOf(".");
    if (separator <= 0 || separator !== access.lastIndexOf(".") || separator === access.length - 1) {
        throw new PairingApiError("access_link_invalid", "The access link is malformed.");
    }
    const grantId = access.slice(0, separator);
    const grantSecret = access.slice(separator + 1);
    if (!isIdentifier(grantId) || !isToken(grantSecret)) {
        throw new PairingApiError("access_link_invalid", "The access link is malformed.");
    }
    return new PresentChannelAccessFragment(grantId, grantSecret);
}

async function hasUsableChannelCredential(channelId: string, cancellationSignal: AbortSignal): Promise<boolean> {
    let credential: BrowserChannelCredential;
    try {
        credential = readChannelCredential(channelId);
    } catch (error) {
        if (
            error instanceof PairingApiError &&
            (error.code === "channel_credential_missing" || error.code === "channel_credential_invalid")
        ) {
            return false;
        }
        throw error;
    }
    const endpoint = mobiusApiUrl(window.location.origin, `/channels/${encodeURIComponent(channelId)}`);
    try {
        await requestJson(
            endpoint,
            {
                headers: { authorization: `Bearer ${credential.hostToken}` },
                method: "GET",
            },
            requestSignal(cancellationSignal),
        );
        return true;
    } catch (error) {
        if (error instanceof PairingApiError && error.code === "unauthorized") {
            return false;
        }
        throw error;
    }
}

function requestSignal(cancellationSignal: AbortSignal): AbortSignal {
    return AbortSignal.any([cancellationSignal, AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS)]);
}

function decodeChannelConnection(
    value: unknown,
    expectedChannelId: string,
    credential: BrowserChannelCredential,
): ChannelConnection {
    if (!isRecord(value)) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid channel.");
    }
    const channelId = value["channelId"];
    const runtimeId = value["runtimeId"];
    if (
        typeof channelId !== "string" ||
        !isIdentifier(channelId) ||
        channelId !== expectedChannelId ||
        typeof runtimeId !== "string" ||
        !isIdentifier(runtimeId)
    ) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid channel.");
    }
    if (value["tenantId"] !== credential.tenantId || value["projectId"] !== credential.projectId) {
        throw new PairingApiError("invalid_relay_response", "The relay returned a channel from another workspace.");
    }
    const agents = decodeAgents(value["agents"]);
    const installableAgents = decodeInstallableAgents(value["installableAgents"]);
    if (
        agents.length + installableAgents.length === 0 ||
        installableAgents.some((agent) => agents.some((available) => available.id === agent.id))
    ) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid Agent catalog.");
    }
    return new ChannelConnection(
        agents,
        channelId,
        readString(value["machineName"], "machine name", 120),
        readString(value["workspaceName"], "workspace name", 120),
        credential.hostToken,
        credential.tenantId,
        credential.projectId,
        runtimeId,
        installableAgents,
        import.meta.env.VITE_MOBIUS_BASE_URL,
        channelId,
        import.meta.env.VITE_MOBIUS_APP_ID,
    );
}

export async function createBrowserPairing(signal: AbortSignal, token: string | null): Promise<CreatedPairing> {
    const pairing = decodeCreatedPairing(
        await requestJson(
            mobiusApiUrl(window.location.origin, "/pairings"),
            {
                method: "POST",
                headers: token === null ? {} : { Authorization: `Bearer ${token}` },
            },
            requestSignal(signal),
        ),
    );
    saveChannelCredential(pairing);
    return pairing;
}

export async function readBrowserPairingStatus(pairing: CreatedPairing): Promise<BrowserPairingStatus> {
    const endpoint = mobiusApiUrl(window.location.origin, `/pairings/${encodeURIComponent(pairing.pairingId)}`);
    endpoint.searchParams.set("token", pairing.pollToken);
    const value = await requestJson(endpoint, { method: "GET" });
    if (!isRecord(value) || typeof value["status"] !== "string") {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid pairing status.");
    }
    if (value["status"] === "pending") {
        return new WaitingBrowserPairingStatus(readDate(value["expiresAt"], "expiry time"));
    }
    if (value["status"] === "expired") {
        return new ExpiredBrowserPairingStatus();
    }
    if (value["status"] !== "paired") {
        throw new PairingApiError("invalid_relay_response", "The relay returned an unknown pairing status.");
    }
    return new ConnectedBrowserPairingStatus(
        decodeChannelConnection(
            value,
            pairing.channelId,
            new OwnerBrowserChannelCredential(pairing.hostToken, pairing.projectId, pairing.tenantId),
        ),
    );
}

export async function createChannelAccessGrant(
    channelId: string,
    cancellationSignal: AbortSignal,
): Promise<CreatedChannelAccessGrant> {
    const credential = readChannelCredential(channelId);
    const endpoint = mobiusApiUrl(window.location.origin, `/channels/${encodeURIComponent(channelId)}/access-grants`);
    return decodeCreatedChannelAccessGrant(
        await requestJson(
            endpoint,
            {
                headers: { authorization: `Bearer ${credential.hostToken}` },
                method: "POST",
            },
            requestSignal(cancellationSignal),
        ),
    );
}

export async function readLinkedChannelDevices(
    channelId: string,
    cancellationSignal: AbortSignal,
): Promise<readonly LinkedChannelDevice[]> {
    const credential = readChannelCredential(channelId);
    const endpoint = mobiusApiUrl(window.location.origin, `/channels/${encodeURIComponent(channelId)}/linked-devices`);
    return decodeLinkedChannelDevices(
        await requestJson(
            endpoint,
            {
                headers: { authorization: `Bearer ${credential.hostToken}` },
                method: "GET",
            },
            requestSignal(cancellationSignal),
        ),
    );
}

export async function redeemChannelAccessGrantFromLocation(
    channelId: string,
    cancellationSignal: AbortSignal,
): Promise<void> {
    const fragment = readChannelAccessFragment();
    if (fragment instanceof MissingChannelAccessFragment) {
        return;
    }
    if (!(fragment instanceof PresentChannelAccessFragment)) {
        throw new PairingApiError("access_link_invalid", "The access link is malformed.");
    }
    if (await hasUsableChannelCredential(channelId, cancellationSignal)) {
        return;
    }
    const endpoint = mobiusApiUrl(
        window.location.origin,
        `/channels/${encodeURIComponent(channelId)}/access-grants/${encodeURIComponent(fragment.grantId)}/redeem`,
    );
    const credential = decodeRedeemedChannelCredential(
        await requestJson(
            endpoint,
            {
                body: JSON.stringify({ grantSecret: fragment.grantSecret }),
                headers: { "content-type": "application/json" },
                method: "POST",
            },
            requestSignal(cancellationSignal),
        ),
        channelId,
    );
    try {
        saveBrowserChannelCredential(channelId, credential);
    } catch (cause) {
        throw new PairingApiError(
            "channel_credential_unavailable",
            "This browser could not save access to the channel.",
            { cause },
        );
    }
}

export async function revokeLinkedChannelDevice(
    channelId: string,
    credentialId: string,
    cancellationSignal: AbortSignal,
): Promise<void> {
    const credential = readChannelCredential(channelId);
    const endpoint = mobiusApiUrl(
        window.location.origin,
        `/channels/${encodeURIComponent(channelId)}/linked-devices/${encodeURIComponent(credentialId)}`,
    );
    await requestEmpty(
        endpoint,
        {
            headers: { authorization: `Bearer ${credential.hostToken}` },
            method: "DELETE",
        },
        requestSignal(cancellationSignal),
    );
}

export async function readChannelConnection(
    channelId: string,
    cancellationSignal: AbortSignal = new AbortController().signal,
): Promise<ChannelConnection> {
    const credential = readChannelCredential(channelId);
    const endpoint = mobiusApiUrl(window.location.origin, `/channels/${encodeURIComponent(channelId)}`);
    return decodeChannelConnection(
        await requestJson(
            endpoint,
            {
                headers: { authorization: `Bearer ${credential.hostToken}` },
                method: "GET",
            },
            requestSignal(cancellationSignal),
        ),
        channelId,
        credential,
    );
}

export async function readChannelHistory(channelId: string): Promise<ChannelHistory> {
    return await readChannelHistoryWithSignal(channelId, AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS));
}

interface RestoredChannelSession {
    readonly session: RecordedSession;
    readonly turns: RecordedTurn[];
}

function isConcurrentSessionRemoval(error: unknown): boolean {
    return (
        (error instanceof PairingApiError || error instanceof MobiusApiError) &&
        (error.code === "session_not_found" || error.code === "session_deleted")
    );
}

function publicServiceClient(credential: BrowserChannelCredential): MobiusClient {
    return new MobiusClient({
        credentialProvider: new StaticMobiusCredentialProvider(credential.hostToken),
        endpoint: window.location.origin,
        projectId: credential.projectId,
    });
}

function projectCredential(channelId: string, projectId: string): BrowserChannelCredential {
    const credential = readChannelCredential(channelId);
    if (credential.projectId !== projectId) {
        throw new PairingApiError(
            "project_access_mismatch",
            "The saved channel credential belongs to another workspace.",
        );
    }
    return credential;
}

function throwPublicApiFailure(error: unknown): never {
    if (error instanceof MobiusError) {
        throw new PairingApiError(error.code, error.message, { cause: error });
    }
    throw error;
}

export async function readRuntimeManagementAccess(
    channelId: string,
    projectId: string,
    cancellationSignal: AbortSignal,
): Promise<RuntimeManagementAccess> {
    const credential = projectCredential(channelId, projectId);
    if (credential instanceof OwnerBrowserChannelCredential) {
        return new OwnerRuntimeManagementAccess();
    }
    if (credential instanceof LinkedBrowserChannelCredential) {
        return new ReadOnlyRuntimeManagementAccess();
    }
    try {
        await readLinkedChannelDevices(channelId, cancellationSignal);
        saveBrowserChannelCredential(
            channelId,
            new OwnerBrowserChannelCredential(credential.hostToken, credential.projectId, credential.tenantId),
        );
        return new OwnerRuntimeManagementAccess();
    } catch (error) {
        if (error instanceof PairingApiError && error.code === "owner_access_required") {
            saveBrowserChannelCredential(
                channelId,
                new LinkedBrowserChannelCredential(credential.hostToken, credential.projectId, credential.tenantId),
            );
            return new ReadOnlyRuntimeManagementAccess();
        }
        throw error;
    }
}

export async function createProjectRuntimePairing(
    channelId: string,
    projectId: string,
    idempotencyKey: string,
    cancellationSignal: AbortSignal,
): Promise<MobiusRuntimePairing> {
    const client = publicServiceClient(projectCredential(channelId, projectId));
    try {
        return await client.runtimePairings.create(
            new MobiusRuntimePairingRequest(idempotencyKey),
            requestSignal(cancellationSignal),
        );
    } catch (error) {
        return throwPublicApiFailure(error);
    } finally {
        client.close();
    }
}

export async function readProjectRuntimePairing(
    channelId: string,
    projectId: string,
    pairingId: string,
    cancellationSignal: AbortSignal,
): Promise<MobiusRuntimePairingStatus> {
    const client = publicServiceClient(projectCredential(channelId, projectId));
    try {
        return await client.runtimePairings.read(pairingId, requestSignal(cancellationSignal));
    } catch (error) {
        return throwPublicApiFailure(error);
    } finally {
        client.close();
    }
}

export async function readProjectRuntimes(
    channelId: string,
    projectId: string,
    cancellationSignal: AbortSignal,
): Promise<readonly MobiusRuntimeDescriptor[]> {
    const client = publicServiceClient(projectCredential(channelId, projectId));
    try {
        return await client.runtimes.list(requestSignal(cancellationSignal));
    } catch (error) {
        return throwPublicApiFailure(error);
    } finally {
        client.close();
    }
}

export async function revokeProjectRuntime(
    channelId: string,
    projectId: string,
    runtimeId: string,
    cancellationSignal: AbortSignal,
): Promise<void> {
    const client = publicServiceClient(projectCredential(channelId, projectId));
    try {
        await client.runtimes.revoke(runtimeId, requestSignal(cancellationSignal));
    } catch (error) {
        throwPublicApiFailure(error);
    } finally {
        client.close();
    }
}

async function readChannelHistoryWithSignal(channelId: string, signal: AbortSignal): Promise<ChannelHistory> {
    const credential = readChannelCredential(channelId);
    const client = publicServiceClient(credential);
    try {
        const directory = await client.sessions.list(new MobiusPageRequest(100, ""), signal);
        const summaries = directory.sessions.map((session) => decodeRecordedSession(session, credential));
        const restoredBySessionId = new Map<string, RestoredChannelSession>();
        await Promise.all(
            summaries.map(async (session) => {
                try {
                    const nativeHistory = await client.sessions.queryNativeMessages(session.sessionId, signal);
                    const turns: RecordedTurn[] = [];
                    restoredBySessionId.set(session.sessionId, {
                        turns,
                        session: new RecordedSession(
                            session.agentId,
                            session.bindingId,
                            session.configRevision,
                            session.directoryId,
                            session.runtimeId,
                            session.sessionId,
                            session.title,
                            session.updatedAt,
                            nativeHistory,
                            [],
                            [],
                            session.additionalDirectoryIds,
                            session.lastCommittedSeq,
                        ),
                    });
                } catch (error) {
                    if (!isConcurrentSessionRemoval(error)) {
                        throw error;
                    }
                }
            }),
        );
        const restored: RestoredChannelSession[] = [];
        for (const session of summaries) {
            const value = restoredBySessionId.get(session.sessionId);
            if (value !== undefined) {
                restored.push(value);
            }
        }
        const sessions = restored.map(({ session }) => session);
        const turns: RecordedTurn[] = [];
        for (const { turns: sessionTurns } of restored) {
            sessionTurns.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
            turns.push(...sessionTurns);
        }
        return new ChannelHistory(turns, sessions);
    } catch (error) {
        return throwPublicApiFailure(error);
    } finally {
        client.close();
    }
}

function decodeRecordedSession(value: MobiusSession, credential: BrowserChannelCredential): RecordedSession {
    const binding = value.defaultBinding;
    if (
        value.projectId !== credential.projectId ||
        value.state.kind !== "ready" ||
        binding.sessionId !== value.sessionId ||
        binding.agentRef !== value.agentId ||
        binding.runtimeId !== value.runtimeId
    ) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an inconsistent session summary.");
    }
    return new RecordedSession(
        value.agentId,
        binding.bindingId,
        binding.configRevision,
        binding.workspaceRef,
        value.runtimeId,
        value.sessionId,
        value.title,
        value.updatedAt,
        null,
        [],
        [],
        [],
        value.lastCommittedSequence,
    );
}

function decodeActivityDetail(value: unknown): ActivityDetailResult {
    if (!isRecord(value)) {
        throw new PairingApiError("invalid_relay_response", "The relay returned invalid activity details.");
    }
    const kind = value["kind"];
    if (kind === "unrecorded") {
        return { kind };
    }
    if (kind === "deleted") {
        return {
            deletedAt: readDate(value["deletedAt"], "activity deletion time"),
            kind,
        };
    }
    if (kind === "truncated") {
        const capturedBytes = value["capturedBytes"];
        const originalBytes = value["originalBytes"];
        if (
            typeof capturedBytes !== "number" ||
            !Number.isSafeInteger(capturedBytes) ||
            capturedBytes < 0 ||
            typeof originalBytes !== "number" ||
            !Number.isSafeInteger(originalBytes) ||
            originalBytes < capturedBytes
        ) {
            throw new PairingApiError("invalid_relay_response", "The relay returned invalid truncation details.");
        }
        return { capturedBytes, kind, originalBytes };
    }
    const content = value["content"];
    const storage = value["storage"];
    if (
        kind !== "available" ||
        !Array.isArray(content) ||
        content.length > 100 ||
        (storage !== "archive" && storage !== "hot")
    ) {
        throw new PairingApiError("invalid_relay_response", "The relay returned invalid activity details.");
    }
    return {
        artifactId: readIdentifier(value["artifactId"], "activity artifact"),
        content: content.map(decodeRecordedAgentContentValue),
        input: readText(value["input"], "activity input", 4_000_000),
        kind,
        output: readText(value["output"], "activity output", 4_000_000),
        storage,
    };
}

export async function readToolCallDetail(
    channelId: string,
    sessionId: string,
    attemptId: string,
    toolCallId: string,
    signal: AbortSignal,
): Promise<ActivityDetailResult> {
    const credential = readChannelCredential(channelId);
    const client = publicServiceClient(credential);
    try {
        return decodeActivityDetail(await client.toolCalls.readDetail(sessionId, attemptId, toolCallId, signal));
    } catch (error) {
        return throwPublicApiFailure(error);
    } finally {
        client.close();
    }
}

export async function readChannelHistoryForSynchronization(
    channelId: string,
    cancellationSignal: AbortSignal,
): Promise<ChannelHistory> {
    return await readChannelHistoryWithSignal(
        channelId,
        AbortSignal.any([cancellationSignal, AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS)]),
    );
}

export function pairingCommand(pairing: CreatedPairing): string {
    return `npm install --global @moxt-ai/mobius@latest && mobius pair --app-id ${JSON.stringify(pairing.appId)} --url ${JSON.stringify(window.location.origin)} --pairing ${JSON.stringify(pairing.pairingId)} --code ${JSON.stringify(pairing.pairingCode)}`;
}
