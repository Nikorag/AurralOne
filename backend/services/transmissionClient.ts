import * as v from "valibot";
import { http } from "../../lib/http.ts";
import { asAppError } from "../../lib/errors.ts";
import { dbOps } from "../db/helpers/index.ts";
import { readOne } from "./integrationData.ts";
import { prowlarrClient } from "./prowlarrClient.ts";
import { normalizeBaseUrl } from "./usenetClientCommon.ts";

const LABELS_RPC_VERSION = 16;

export const transmissionSettings = Object.freeze({
  key: "transmission",
  label: "Transmission",
  subtitle: "Torrents",
  enabledDefault: false,
  testRequiresEnabled: true,
  fields: Object.freeze([
    Object.freeze({ key: "enabled", label: "Enable Transmission", type: "toggle" }),
    Object.freeze({
      key: "url",
      label: "Server URL",
      type: "url",
      required: true,
      section: "Connection",
      placeholder: "http://localhost:9091",
    }),
    Object.freeze({ key: "username", label: "Username", type: "text", section: "Connection" }),
    Object.freeze({
      key: "password",
      label: "Password",
      type: "password",
      secret: true,
      section: "Connection",
    }),
    Object.freeze({
      key: "category",
      label: "Label",
      type: "text",
      section: "Downloads",
      hint: "Added to every torrent Aurral starts.",
    }),
    Object.freeze({
      key: "priority",
      label: "Track priority",
      type: "number",
      min: 1,
      max: 1000,
      advanced: true,
    }),
    Object.freeze({
      key: "albumPriority",
      label: "Album priority",
      type: "number",
      min: 1,
      max: 1000,
      advanced: true,
      hint: "Empty uses track priority.",
    }),
  ]),
  defaults: Object.freeze({
    enabled: false,
    url: "",
    username: "",
    password: "",
    category: "aurral",
    priority: 30,
  }),
  validation: Object.freeze({ required: ["url"], url: ["url"] }),
  testConnection: true,
});

type TransmissionConfig = Record<string, unknown> | null;

function getSettings(config: TransmissionConfig) {
  const transmission = config || dbOps.getSettings()?.integrations?.transmission || {};
  return {
    enabled: transmission.enabled === true,
    url: normalizeBaseUrl(transmission.url),
    username: String(transmission.username || "").trim(),
    password: String(transmission.password || ""),
    category: String(transmission.category ?? "aurral").trim(),
  };
}

type Settings = ReturnType<typeof getSettings>;

const torrentFields = [
  "hashString",
  "name",
  "status",
  "percentDone",
  "labels",
  "downloadDir",
  "error",
  "errorString",
];

const torrentSchema = v.looseObject({
  hashString: v.string(),
  name: v.optional(v.string(), ""),
  status: v.optional(v.number(), 0),
  percentDone: v.optional(v.number(), 0),
  labels: v.optional(v.array(v.string()), []),
  downloadDir: v.optional(v.string(), ""),
  error: v.optional(v.number(), 0),
  errorString: v.optional(v.string(), ""),
});

const filesSchema = v.looseObject({
  files: v.optional(
    v.array(v.looseObject({ name: v.string(), length: v.optional(v.number(), 0) })),
    [],
  ),
  fileStats: v.optional(v.array(v.looseObject({ wanted: v.optional(v.boolean(), true) })), []),
});

const torrentList = v.looseObject({ torrents: v.optional(v.array(v.unknown()), []) });
const torrentFileList = v.looseObject({ torrents: v.optional(v.array(filesSchema), []) });
const added = v.looseObject({
  torrentAdded: v.optional(v.looseObject({ hashString: v.string() })),
});
const session = v.looseObject({
  version: v.optional(v.string(), ""),
  rpcVersion: v.optional(v.number()),
});
const envelope = v.looseObject({
  result: v.optional(v.unknown()),
  arguments: v.optional(v.unknown()),
  error: v.optional(v.looseObject({ message: v.optional(v.string()) })),
});

// Transmission 4.1 speaks JSON-RPC with snake_case names. Older versions, and
// 4.1 still, take the original names Aurral writes, so they are converted.
const snake = (name: string) =>
  name
    .replace(/-/g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
const camel = (name: string) =>
  name.replace(/[-_]+(.)/g, (_, letter: string) => letter.toUpperCase());

function mapKeys(value: unknown, rename: (name: string) => string): unknown {
  if (Array.isArray(value)) return value.map((entry) => mapKeys(entry, rename));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [rename(key), mapKeys(entry, rename)]),
  );
}

const toJsonRpc = (args: Record<string, unknown>) => {
  const params = mapKeys(args, snake) as Record<string, unknown>;
  if (Array.isArray(args.fields)) params.fields = args.fields.map((field) => snake(String(field)));
  return params;
};

type Connection = { account: string; id: string; jsonRpc: boolean };
let connection: Connection | null = null;

const rpcUrl = (settings: Settings) =>
  settings.url.endsWith("/rpc") ? settings.url : `${settings.url}/transmission/rpc`;
const account = (settings: Settings) => `${rpcUrl(settings)}\0${settings.username}`;

async function call(settings: Settings, method: string, args: Record<string, unknown> = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const known = connection?.account === account(settings) ? connection : null;
    const jsonRpc = known?.jsonRpc === true;
    const response = await http.post(
      rpcUrl(settings),
      jsonRpc
        ? { jsonrpc: "2.0", method: snake(method), params: toJsonRpc(args), id: 1 }
        : { method, arguments: args },
      {
        timeoutMs: 30000,
        okStatus: () => true,
        basicAuth: settings.username
          ? { username: settings.username, password: settings.password }
          : undefined,
        headers: known ? { "X-Transmission-Session-Id": known.id } : {},
      },
    );
    if (response.status === 409) {
      connection = {
        account: account(settings),
        id: String(response.headers["x-transmission-session-id"] ?? ""),
        jsonRpc: "x-transmission-rpc-version" in response.headers,
      };
      continue;
    }
    if (response.status === 401) throw new Error("Transmission rejected the username or password");
    if (response.status === 403)
      throw new Error("Transmission refused Aurral. Check its RPC whitelist and host whitelist");
    if (response.status >= 400)
      throw new Error(`Transmission answered ${method} with HTTP ${response.status}`);
    const body = readOne(envelope, mapKeys(response.data, camel), {
      service: "Transmission",
      endpoint: method,
    });
    if (body.error) throw new Error(`Transmission: ${body.error.message ?? "request failed"}`);
    if (jsonRpc) return body.result;
    if (body.result !== "success") throw new Error(`Transmission: ${String(body.result)}`);
    return body.arguments;
  }
  throw new Error("Transmission kept refusing Aurral's session");
}

export class TransmissionClient {
  key = "transmission" as const;
  name = "Transmission" as const;
  _config: TransmissionConfig = null;

  updateConfig(config: TransmissionConfig = null) {
    this._config = config;
  }

  _getSettings() {
    return getSettings(this._config);
  }

  isConfigured() {
    const { enabled, url } = this._getSettings();
    return enabled && Boolean(url);
  }

  getStatus() {
    const { enabled } = this._getSettings();
    return { enabled, configured: this.isConfigured() };
  }

  _call(method: string, args: Record<string, unknown> = {}) {
    return call(this._getSettings(), method, args);
  }

  async testConnection() {
    const settings = this._getSettings();
    if (!settings.enabled)
      return {
        ok: false,
        configured: false,
        connected: false,
        message: "Transmission is disabled",
      };
    if (!settings.url)
      return {
        ok: false,
        configured: false,
        connected: false,
        message: "Transmission URL is required",
      };
    try {
      const { version, rpcVersion } = readOne(session, await this._call("session-get"), {
        service: "Transmission",
        endpoint: "session-get",
      });
      if (rpcVersion !== undefined && rpcVersion < LABELS_RPC_VERSION)
        throw new Error("Aurral needs Transmission 3.00 or newer, which added labels");
      const connected = `Transmission ${version} is connected`.replace(/\s+/gu, " ");
      if (prowlarrClient.isConfigured())
        return { ok: true, configured: true, connected: true, version, message: connected };
      return {
        ok: true,
        warning: true,
        configured: true,
        connected: true,
        version,
        message: `${connected}. Set up Prowlarr so Aurral can search for torrents.`,
      };
    } catch (error) {
      return {
        ok: false,
        configured: true,
        connected: false,
        message: asAppError(error)?.message || "Failed to reach Transmission",
      };
    }
  }

  // A torrent file stays stopped until Aurral picks its files. A magnet has to
  // run to fetch them, so unwanted files can start before Aurral skips them.
  async addTorrent(torrent: { magnet: string } | { file: Buffer }, label: string) {
    const { category } = this._getSettings();
    const result = readOne(
      added,
      await this._call("torrent-add", {
        ...("magnet" in torrent
          ? { filename: torrent.magnet }
          : { metainfo: torrent.file.toString("base64"), paused: true }),
        labels: [category, label].filter(Boolean),
      }),
      { service: "Transmission", endpoint: "torrent-add" },
    );
    return Boolean(result.torrentAdded);
  }

  async torrentsLabelled(label: string) {
    const result = readOne(
      torrentList,
      await this._call("torrent-get", { fields: torrentFields }),
      { service: "Transmission", endpoint: "torrent-get" },
    );
    return result.torrents
      .flatMap((entry) => {
        const parsed = v.safeParse(torrentSchema, entry);
        return parsed.success ? [parsed.output] : [];
      })
      .filter((torrent) => torrent.labels.includes(label));
  }

  async torrentFiles(hash: string) {
    const result = readOne(
      torrentFileList,
      await this._call("torrent-get", { ids: [hash], fields: ["files", "fileStats"] }),
      { service: "Transmission", endpoint: "torrent-get" },
    );
    const [torrent] = result.torrents;
    return (torrent?.files ?? []).map((file, index) => ({
      index,
      name: file.name,
      size: file.length,
      wanted: torrent?.fileStats[index]?.wanted !== false,
    }));
  }

  // An empty list would mean every file.
  async skipFiles(hash: string, indexes: number[]) {
    if (indexes.length === 0) return;
    await this._call("torrent-set", { ids: [hash], "files-unwanted": indexes });
  }

  async startTorrent(hash: string) {
    await this._call("torrent-start", { ids: [hash] });
  }

  async addLabel(torrent: { hashString: string; labels: string[] }, label: string) {
    await this._call("torrent-set", {
      ids: [torrent.hashString],
      labels: [...torrent.labels, label],
    });
  }

  async deleteTorrents(hashes: string[]) {
    if (hashes.length === 0) return;
    await this._call("torrent-remove", { ids: hashes, "delete-local-data": true });
  }
}

export const transmissionClient = new TransmissionClient();
