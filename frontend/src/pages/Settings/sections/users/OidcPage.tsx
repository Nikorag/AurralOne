import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { parseResponse, type InferResponseType } from "hono/client";
import { DotLoader } from "../../../../components/DotLoader";
import PillToggle from "../../../../components/PillToggle";
import { Select } from "../../../../components/Select";
import { oidcSettingsClient } from "../../../../utils/api/clients/oidcSettings.ts";
import { queryClient } from "../../../../queryClient.ts";
import { serverUrl } from "../../../../utils/server.ts";
import { SettingsInput } from "../../components/SettingsField";
import {
  SettingsActions,
  SettingsGroup,
  SettingsNote,
  SettingsPage,
  SettingsRow,
} from "../../SettingsLayout";

type OidcView = InferResponseType<typeof oidcSettingsClient.$get, 200>;
type TextKey =
  | "issuer"
  | "clientId"
  | "redirectUri"
  | "scopes"
  | "usernameClaim"
  | "adminUsers"
  | "groupsClaim"
  | "adminGroups"
  | "logoutUrl";

const QUERY_KEY = ["settings", "oidc"] as const;
const LOCKED_NOTE = "Set by an environment variable.";

export const oidcCallbackUrl = () => serverUrl("/sso/callback");

export const useOidcSettings = () =>
  useQuery({
    queryKey: QUERY_KEY,
    queryFn: ({ signal }) => parseResponse(oidcSettingsClient.$get({}, { init: { signal } })),
    staleTime: 30_000,
  });

function OidcForm({ view }: { view: OidcView }) {
  const [enabled, setEnabled] = useState(view.enabled);
  const [text, setText] = useState<Record<TextKey, string>>({
    issuer: view.issuer,
    clientId: view.clientId,
    redirectUri: view.redirectUri,
    scopes: view.scopes,
    usernameClaim: view.usernameClaim,
    adminUsers: view.adminUsers,
    groupsClaim: view.groupsClaim,
    adminGroups: view.adminGroups,
    logoutUrl: view.logoutUrl,
  });
  const [authMethod, setAuthMethod] = useState(view.tokenEndpointAuthMethod);
  const [defaultRole, setDefaultRole] = useState(view.defaultRole);
  const [secret, setSecret] = useState("");

  const save = useMutation({
    mutationFn: (clearClientSecret: boolean) =>
      parseResponse(
        oidcSettingsClient.$put({
          json: {
            enabled,
            ...text,
            tokenEndpointAuthMethod: authMethod as "client_secret_basic",
            defaultRole: defaultRole as "user",
            ...(secret && { clientSecret: secret }),
            ...(clearClientSecret && { clearClientSecret }),
          },
        }),
      ),
    onSuccess: (next) => {
      setSecret("");
      queryClient.setQueryData(QUERY_KEY, next);
      void queryClient.invalidateQueries({ queryKey: ["auth", "bootstrap"] });
    },
  });

  const field = (
    key: TextKey,
    label: string,
    options: { placeholder?: string; help?: React.ReactNode; type?: string } = {},
  ) => (
    <SettingsRow
      label={label}
      htmlFor={`oidc-${key}`}
      help={view.locked[key] ? LOCKED_NOTE : options.help}
    >
      <SettingsInput
        id={`oidc-${key}`}
        type={options.type ?? "text"}
        autoComplete="off"
        placeholder={options.placeholder}
        disabled={view.locked[key]}
        value={text[key]}
        onChange={(event) => setText({ ...text, [key]: event.target.value })}
      />
    </SettingsRow>
  );

  return (
    <>
      <SettingsGroup>
        <SettingsRow
          label="Enabled"
          htmlFor="oidc-enabled"
          help={view.locked.enabled ? LOCKED_NOTE : undefined}
        >
          <PillToggle
            id="oidc-enabled"
            checked={enabled}
            disabled={view.locked.enabled}
            aria-label="Enabled"
            onChange={(event) => setEnabled(event.target.checked)}
          />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup
        title="Provider"
        note={
          <>
            Register Aurral as a confidential client with your provider and use{" "}
            <span className="settings-code">{oidcCallbackUrl()}</span> as the redirect URI.
          </>
        }
      >
        {field("issuer", "Issuer URL", {
          placeholder: "https://id.example.com",
          type: "url",
          help: "Used for discovery. For PocketID, its base URL.",
        })}
        {field("clientId", "Client ID")}
        <SettingsRow
          label="Client secret"
          htmlFor="oidc-client-secret"
          help={
            view.locked.clientSecret
              ? LOCKED_NOTE
              : view.clientSecretSet
                ? "A secret is saved. Enter a new one to replace it."
                : undefined
          }
        >
          <SettingsInput
            id="oidc-client-secret"
            type="password"
            autoComplete="new-password"
            placeholder={view.clientSecretSet ? "Saved" : ""}
            disabled={view.locked.clientSecret}
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
          />
        </SettingsRow>
        {field("redirectUri", "Redirect URI", {
          placeholder: "https://aurral.example.com/sso/callback",
          type: "url",
        })}
        <SettingsRow
          label="Token endpoint auth"
          htmlFor="oidc-auth-method"
          help={view.locked.tokenEndpointAuthMethod ? LOCKED_NOTE : "Must match your provider."}
        >
          <Select
            id="oidc-auth-method"
            value={authMethod}
            disabled={view.locked.tokenEndpointAuthMethod}
            onChange={setAuthMethod}
            options={[
              { value: "client_secret_basic", label: "Client secret (basic)" },
              { value: "client_secret_post", label: "Client secret (post)" },
              { value: "none", label: "None (public client)" },
            ]}
          />
        </SettingsRow>
        {field("scopes", "Scopes", { placeholder: view.defaults.scopes })}
        {field("logoutUrl", "Logout URL", {
          type: "url",
          help: "Optional. Aurral sends the browser here after it ends its own session.",
        })}
      </SettingsGroup>
      <SettingsGroup title="Accounts and roles">
        {field("usernameClaim", "Username claim", {
          placeholder: view.defaults.usernameClaim,
          help: "Falls back to email when the claim is missing.",
        })}
        <SettingsRow
          label="Default role"
          htmlFor="oidc-default-role"
          help={view.locked.defaultRole ? LOCKED_NOTE : undefined}
        >
          <Select
            id="oidc-default-role"
            value={defaultRole}
            disabled={view.locked.defaultRole}
            onChange={setDefaultRole}
            options={[
              { value: "user", label: "User" },
              { value: "admin", label: "Admin" },
            ]}
          />
        </SettingsRow>
        {field("adminUsers", "Admin users", {
          help: "Comma-separated usernames that get the admin role at sign-in.",
        })}
        {field("groupsClaim", "Groups claim", {
          placeholder: "groups",
          help: "Optional claim that holds group membership.",
        })}
        {field("adminGroups", "Admin groups", {
          help: "Comma-separated groups that give the admin role.",
        })}
      </SettingsGroup>
      {save.isError ? (
        <SettingsNote tone="error">
          {save.error instanceof Error ? save.error.message : "Couldn't save."}
        </SettingsNote>
      ) : null}
      {enabled && !view.configured ? (
        <SettingsNote tone="warning">
          Sign-in stays off until the issuer, client ID, client secret, and redirect URI are saved.
        </SettingsNote>
      ) : null}
      <SettingsActions status={save.isSuccess ? { tone: "success", message: "Saved" } : null}>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={save.isPending}
          onClick={() => save.mutate(false)}
        >
          {save.isPending ? <DotLoader size="xs" label={null} /> : null}
          Save
        </button>
        {view.clientSecretSet && !view.locked.clientSecret ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={save.isPending}
            onClick={() => save.mutate(true)}
          >
            Remove saved secret
          </button>
        ) : null}
      </SettingsActions>
    </>
  );
}

export function OidcPage() {
  const query = useOidcSettings();
  return (
    <SettingsPage title="Single sign-on (OIDC)" back="Users">
      {query.data ? (
        <OidcForm view={query.data} />
      ) : query.isError ? (
        <SettingsNote tone="warning">Couldn&apos;t load OIDC settings.</SettingsNote>
      ) : (
        <p className="settings-loading">
          <DotLoader size="sm" label={null} /> Loading…
        </p>
      )}
    </SettingsPage>
  );
}
