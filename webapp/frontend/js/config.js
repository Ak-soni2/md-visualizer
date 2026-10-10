// Deployment configuration. Locally the API is served from the same origin as this page (empty apiBase).
// For a Vercel-hosted frontend with a separately hosted Python backend, set apiBase to that backend's URL,
// e.g. "https://nanocut-api.example.org", and add the Vercel origin to NANOCUT_CORS_ORIGINS on the backend.
export const CONFIG = Object.freeze({
  apiBase: (window.NANOCUT_API_BASE ?? ""),
  requestTimeoutMs: 30000,
  healthEveryMs: 15000,
  jobPollMs: 600,
  fixturesPath: "fixtures/",
});
