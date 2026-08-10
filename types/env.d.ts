interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_ENABLE_BACKEND_SYNC?: string;
  readonly VITE_POLL_INTERVAL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
