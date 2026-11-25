import { Hono } from "hono";
import * as v from "valibot";
import { requireAdmin, requireAuth } from "../../middleware/guards.ts";
import { noCache } from "../../middleware/cacheHeaders.ts";
import { validate } from "../../middleware/validate.ts";
import type { AppEnv } from "../../middleware/requestUser.ts";
import {
  OIDC_AUTH_METHODS,
  OIDC_ROLES,
  getOidcSettingsView,
  saveOidcSettings,
} from "../../services/oidcConfig.ts";

const isHttpUrl = (value: string) => {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

const url = v.union([
  v.literal(""),
  v.pipe(v.string(), v.trim(), v.check(isHttpUrl, "Must be an http or https URL")),
]);
const text = v.pipe(v.string(), v.maxLength(2000));

const oidcPatch = v.object({
  enabled: v.optional(v.boolean()),
  issuer: v.optional(url),
  clientId: v.optional(text),
  clientSecret: v.optional(text),
  clearClientSecret: v.optional(v.boolean()),
  redirectUri: v.optional(url),
  tokenEndpointAuthMethod: v.optional(v.picklist(OIDC_AUTH_METHODS)),
  scopes: v.optional(text),
  usernameClaim: v.optional(text),
  defaultRole: v.optional(v.picklist(OIDC_ROLES)),
  adminUsers: v.optional(text),
  groupsClaim: v.optional(text),
  adminGroups: v.optional(text),
  logoutUrl: v.optional(url),
});

export default new Hono<AppEnv>()
  .basePath("/settings/oidc")
  .get("/", requireAuth, requireAdmin, noCache, (c) => c.json(getOidcSettingsView(), 200))
  .put("/", requireAuth, requireAdmin, validate("json", oidcPatch), (c) => {
    saveOidcSettings(c.req.valid("json"));
    return c.json(getOidcSettingsView(), 200);
  });
