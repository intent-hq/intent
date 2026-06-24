// SPA mode: disable SSR/prerender so adapter-static emits an index.html fallback
// that the Tauri webview can serve for any client-side route.
export const ssr = false;
export const prerender = false;
