/**
 * Where the dashboard is mounted. The gateway serves it under `/app` (the site owns `/`), which
 * Vite bakes in as `BASE_URL`; the router and every absolute public asset path take it from here.
 * Empty when Vite is not involved (the node test runner), so routes read as plain `/sessions`.
 */
export const BASE_PATH = (import.meta.env.BASE_URL ?? '/').replace(/\/+$/, '');

/** A file from `public/` at its served path. */
export const publicAsset = (file: string): string => `${BASE_PATH}/${file}`;
