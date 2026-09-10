export class R2SlackAttachmentStorage {
    readonly #bucket: R2Bucket;
    constructor(bucket: R2Bucket) {
        this.#bucket = bucket;
    }
    readonly get = async (key: string, signal: AbortSignal): Promise<Response | null> => {
        signal.throwIfAborted();
        const object = await this.#bucket.get(key);
        signal.throwIfAborted();
        if (object === null) {
            return null;
        }
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        return new Response(object.body, { headers });
    };
    readonly put = async (key: string, response: Response, contentType: string, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        await this.#bucket.put(key, response.body, {
            httpMetadata: { contentType },
        });
        signal.throwIfAborted();
    };
}
