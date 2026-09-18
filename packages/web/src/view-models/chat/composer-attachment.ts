import type { PromptImage, PromptResource } from "@moxt-ai/mobius-sdk";

export type ComposerAttachment =
    | { readonly kind: "image"; readonly image: PromptImage }
    | { readonly kind: "resource"; readonly resource: PromptResource };
