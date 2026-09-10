interface ImportMetaEnv {
    readonly VITE_MOBIUS_APP_ID: string;
    readonly VITE_MOBIUS_BASE_URL: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
