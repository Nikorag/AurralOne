import { hc } from "hono/client";
import type podcasts from "../../../../../backend/routes/podcasts.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const podcastsClient = hc<typeof podcasts>(API_BASE_URL, { fetch: apiFetch }).podcasts;
