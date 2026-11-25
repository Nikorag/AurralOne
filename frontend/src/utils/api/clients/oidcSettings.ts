import { hc } from "hono/client";
import type oidcSettings from "../../../../../backend/routes/settings/oidc.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const oidcSettingsClient = hc<typeof oidcSettings>(API_BASE_URL, {
  fetch: apiFetch,
}).settings.oidc;
