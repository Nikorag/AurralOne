import * as v from "valibot";
import { decryptWithKey, encryptWithKey } from "../config/encryption.ts";
import { dbOps, getOrCreateEncryptionKey } from "../db/helpers/settings.ts";
import { lenient } from "../db/helpers/storedSchemas.ts";

const SETTING_KEY = "oidc";

export const OIDC_AUTH_METHODS = ["client_secret_basic", "client_secret_post", "none"] as const;
export const OIDC_ROLES = ["user", "admin"] as const;

const DEFAULTS = {
  scopes: "openid profile email",
  usernameClaim: "preferred_username",
  tokenEndpointAuthMethod: "client_secret_basic",
  defaultRole: "user",
} as const;

const ENV_NAMES = {
  enabled: "OIDC_ENABLED",
  issuer: "OIDC_ISSUER",
  clientId: "OIDC_CLIENT_ID",
  clientSecret: "OIDC_CLIENT_SECRET",
  redirectUri: "OIDC_REDIRECT_URI",
  tokenEndpointAuthMethod: "OIDC_TOKEN_ENDPOINT_AUTH_METHOD",
  scopes: "OIDC_SCOPES",
  usernameClaim: "OIDC_USERNAME_CLAIM",
  defaultRole: "OIDC_DEFAULT_ROLE",
  adminUsers: "OIDC_ADMIN_USERS",
  groupsClaim: "OIDC_GROUPS_CLAIM",
  adminGroups: "OIDC_ADMIN_GROUPS",
  logoutUrl: "OIDC_LOGOUT_URL",
} as const;

export type OidcField = keyof typeof ENV_NAMES;
type TextField = Exclude<OidcField, "enabled" | "clientSecret">;
const OIDC_FIELDS = Object.keys(ENV_NAMES) as OidcField[];

const text = lenient(v.string());
const storedSchema = v.looseObject({
  enabled: lenient(v.boolean()),
  issuer: text,
  clientId: text,
  clientSecret: text,
  redirectUri: text,
  tokenEndpointAuthMethod: text,
  scopes: text,
  usernameClaim: text,
  defaultRole: text,
  adminUsers: text,
  groupsClaim: text,
  adminGroups: text,
  logoutUrl: text,
});

type Stored = v.InferOutput<typeof storedSchema>;

let storedCache: Stored | null | undefined;

export const invalidateOidcConfigCache = () => {
  storedCache = undefined;
};

function readStored() {
  if (storedCache === undefined) {
    storedCache = dbOps.getJSONSetting(SETTING_KEY, storedSchema);
  }
  return storedCache;
}

const envValue = (field: OidcField) => String(process.env[ENV_NAMES[field]] ?? "").trim();

export function resolveOidcConfig() {
  const stored = readStored();
  const pick = (field: TextField, fallback = "") =>
    envValue(field) || String(stored?.[field] ?? "").trim() || fallback;
  const enabledEnv = envValue("enabled");
  const storedSecret = stored?.clientSecret
    ? String(decryptWithKey(stored.clientSecret, getOrCreateEncryptionKey()) ?? "").trim()
    : "";
  const locked = Object.fromEntries(
    OIDC_FIELDS.map((field) => [field, !!envValue(field)]),
  ) as Record<OidcField, boolean>;
  return {
    enabled: enabledEnv ? enabledEnv === "true" : stored?.enabled === true,
    issuer: pick("issuer"),
    clientId: pick("clientId"),
    clientSecret: envValue("clientSecret") || storedSecret,
    redirectUri: pick("redirectUri"),
    tokenEndpointAuthMethod: pick(
      "tokenEndpointAuthMethod",
      DEFAULTS.tokenEndpointAuthMethod,
    ).toLowerCase(),
    scopes: pick("scopes", DEFAULTS.scopes).replace(/\s+/g, " "),
    usernameClaim: pick("usernameClaim", DEFAULTS.usernameClaim),
    defaultRole: pick("defaultRole", DEFAULTS.defaultRole).toLowerCase(),
    adminUsers: pick("adminUsers"),
    groupsClaim: pick("groupsClaim"),
    adminGroups: pick("adminGroups"),
    logoutUrl: pick("logoutUrl"),
    locked,
  };
}

export function isOidcConfigComplete(config = resolveOidcConfig()) {
  const secretRequired = config.tokenEndpointAuthMethod !== "none";
  return !!(
    config.issuer &&
    config.clientId &&
    (!secretRequired || config.clientSecret) &&
    config.redirectUri
  );
}

export function getOidcCspDomain() {
  const fromEnv = String(process.env.OIDC_DOMAIN || "").trim();
  if (fromEnv) return fromEnv;
  const stored = readStored();
  if (!stored?.enabled || !stored.issuer) return "";
  try {
    return new URL(stored.issuer).origin;
  } catch {
    return "";
  }
}

export function getOidcSettingsView() {
  const { clientSecret, ...config } = resolveOidcConfig();
  return {
    ...config,
    clientSecretSet: !!clientSecret,
    configured: isOidcConfigComplete({ ...config, clientSecret }),
    defaults: DEFAULTS,
  };
}

export type OidcSettingsPatch = Partial<Record<TextField, string>> & {
  enabled?: boolean;
  clientSecret?: string;
  clearClientSecret?: boolean;
};

export function saveOidcSettings(patch: OidcSettingsPatch) {
  const next: Record<string, unknown> = { ...readStored() };
  const { locked } = resolveOidcConfig();
  for (const field of OIDC_FIELDS) {
    if (locked[field]) continue;
    if (field === "clientSecret") {
      if (patch.clearClientSecret) delete next.clientSecret;
      else if (patch.clientSecret?.trim()) {
        next.clientSecret = encryptWithKey(patch.clientSecret.trim(), getOrCreateEncryptionKey());
      }
    } else if (field === "enabled") {
      if (patch.enabled !== undefined) next.enabled = patch.enabled;
    } else if (patch[field] !== undefined) {
      next[field] = patch[field].trim();
    }
  }
  dbOps.setJSONSetting(SETTING_KEY, next);
  invalidateOidcConfigCache();
}
