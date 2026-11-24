import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { buffer } from "node:stream/consumers";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, test } from "vite-plus/test";
import {
  cleanupIsolatedState,
  createMockHttpServer,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [
  state,
  { db },
  { dbOps },
  { transmissionSource, removeSeededTorrents },
  { transmissionClient },
  { DownloadSourceError },
] = await setupIsolatedBackend(
  "transmission-source",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/transmissionSource.ts"),
  () => import("../../backend/services/transmissionClient.ts"),
  () => import("../../backend/services/download/downloadSource.ts"),
);

type Torrent = {
  hashString: string;
  name: string;
  status: number;
  percentDone: number;
  labels: string[];
  downloadDir: string;
  error: number;
  errorString: string;
  files: { name: string; length: number }[];
  wanted: boolean[];
};

type Call = { method: string; args: Record<string, unknown> };

const MAGNET = "magnet:?xt=urn:btih:abc";
const ALBUM = {
  artist: "Glass Coast",
  title: "Lowlands",
  releaseMbid: null,
  releaseGroupMbid: null,
  tracks: [],
};

let fake: Awaited<ReturnType<typeof startFake>>;
let folder = "";

const json = (response: ServerResponse, value: unknown, headers: Record<string, string> = {}) => {
  response.writeHead(200, { "Content-Type": "application/json", ...headers });
  response.end(JSON.stringify(value));
};

const snake = (name: string) =>
  name
    .replace(/-/g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
const kebab = (name: string) => snake(name).replace(/_/g, "-");

function mapKeys(value: unknown, rename: (name: string) => string): unknown {
  if (Array.isArray(value)) return value.map((entry) => mapKeys(entry, rename));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [rename(key), mapKeys(entry, rename)]),
  );
}

function torrentBody(torrent: Torrent, fields: string[]) {
  const all: Record<string, unknown> = {
    ...torrent,
    files: torrent.files.map((file, index) => ({ ...file, bytesCompleted: index })),
    fileStats: torrent.wanted.map((wanted) => ({ wanted, priority: 0 })),
  };
  return Object.fromEntries(fields.map((field) => [field, all[field]]));
}

async function startFake() {
  const fake = {
    sid: "first",
    modern: false,
    rpcVersion: 17,
    password: "secret",
    handshakes: 0,
    torrents: [] as Torrent[],
    calls: [] as Call[],
    releases: [] as Record<string, unknown>[],
    onAdd: (_label: string) => {},
  };
  const byHash = (hash: unknown) => fake.torrents.find((torrent) => torrent.hashString === hash);
  const server = await createMockHttpServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fake");
    const payload = await buffer(request);
    if (url.pathname === "/transmission/rpc") {
      const credentials = Buffer.from(`aurral:${fake.password}`).toString("base64");
      if (request.headers.authorization !== `Basic ${credentials}`) {
        response.writeHead(401);
        return response.end();
      }
      if (request.headers["x-transmission-session-id"] !== fake.sid) {
        fake.handshakes += 1;
        response.writeHead(409, {
          "X-Transmission-Session-Id": fake.sid,
          ...(fake.modern && { "X-Transmission-Rpc-Version": "6.0.0" }),
        });
        return response.end();
      }
      const body = JSON.parse(payload.toString()) as Record<string, unknown>;
      const jsonRpc = body.jsonrpc === "2.0";
      assert.equal(jsonRpc, fake.modern, "the client picked the wrong protocol");
      const method = kebab(String(body.method));
      const args = (
        jsonRpc
          ? mapKeys(body.params, (name) => (name === "fields" ? name : kebab(name)))
          : body.arguments
      ) as Record<string, unknown>;
      const requested: unknown[] = Array.isArray(args.fields) ? args.fields : [];
      const fields = requested.map((field) =>
        jsonRpc
          ? String(field).replace(/_(.)/g, (_, letter: string) => letter.toUpperCase())
          : String(field),
      );
      fake.calls.push({ method, args: { ...args, ...(jsonRpc && { fields: args.fields }) } });
      const reply = (result: unknown) =>
        jsonRpc
          ? json(response, { jsonrpc: "2.0", result: mapKeys(result, snake), id: body.id })
          : json(response, { result: "success", arguments: mapKeys(result, kebabIfAdded) });
      const kebabIfAdded = (name: string) =>
        name === "torrentAdded" || name === "torrentDuplicate" ? kebab(name) : name;
      const ids = (args.ids as string[] | undefined) ?? [];
      if (method === "session-get")
        return reply({ version: "4.0.6 (abc)", rpcVersion: fake.rpcVersion });
      if (method === "torrent-get") {
        const torrents = ids.length ? ids.map(byHash) : fake.torrents;
        return reply({
          torrents: torrents.flatMap((torrent) => (torrent ? [torrentBody(torrent, fields)] : [])),
        });
      }
      if (method === "torrent-add") {
        const labels = args.labels as string[];
        const filename = args.filename;
        if (filename && fake.torrents.some((torrent) => torrent.name === filename))
          return reply({ torrentDuplicate: { hashString: "dup" } });
        fake.onAdd(String(labels.at(-1)));
        return reply({ torrentAdded: { hashString: "new", id: 1, name: "x" } });
      }
      if (method === "torrent-set") {
        const torrent = byHash(ids[0]);
        for (const index of (args["files-unwanted"] as number[] | undefined) ?? [])
          if (torrent) torrent.wanted[index] = false;
        if (torrent && Array.isArray(args.labels)) torrent.labels = args.labels as string[];
        return reply({});
      }
      if (method === "torrent-start") {
        const torrent = byHash(ids[0]);
        if (torrent) Object.assign(torrent, { status: 6, percentDone: 1 });
        return reply({});
      }
      if (method === "torrent-remove") return reply({});
      response.writeHead(404);
      return response.end();
    }
    if (url.pathname === "/release.torrent") return response.end("d4:infod4:name8:Lowlandsee");
    if (url.pathname === "/magnet-only") {
      response.writeHead(302, { Location: MAGNET });
      return response.end();
    }
    if (url.pathname === "/api/v1/indexer")
      return json(response, [
        {
          id: 3,
          name: "Torrents",
          enable: true,
          protocol: "torrent",
          supportsSearch: true,
          capabilities: { categories: [{ id: 3000 }], musicSearchParams: ["q", "artist", "album"] },
        },
      ]);
    if (url.pathname === "/api/v1/search") return json(response, fake.releases);
    response.writeHead(404);
    response.end();
  });
  return Object.assign(fake, { url: server.url, close: server.close });
}

const release = (
  guid: string,
  title: string,
  link = "/release.torrent",
  field = "downloadUrl",
) => ({
  guid,
  title,
  seeders: 5,
  size: 300_000_000,
  protocol: "torrent",
  indexerId: 3,
  [field]: `${fake.url}${link}`,
  categories: [{ id: 3000 }],
});

const torrent = (overrides: Partial<Torrent> = {}): Torrent => ({
  hashString: "h1",
  name: "Lowlands",
  status: 4,
  percentDone: 0.5,
  labels: ["aurral", "aurral-1"],
  downloadDir: "/downloads",
  error: 0,
  errorString: "",
  files: [
    { name: "Lowlands/01 Night Drive.flac", length: 5 },
    { name: "Lowlands/CD2/01 Tide.flac", length: 5 },
    { name: "Lowlands/02 Skipped.flac", length: 5 },
    { name: "Lowlands/cover.jpg", length: 5 },
  ],
  wanted: [true, true, false, true],
  ...overrides,
});

const search = () =>
  transmissionSource.albums!.search(ALBUM, {
    upgrade: null,
    track: null,
    denied: new Set(),
    release: null,
  });

beforeEach(async () => {
  resetDatabase(db);
  fake = await startFake();
  folder = await mkdtemp(path.join(tmpdir(), "aurral-transmission-"));
  const settings = dbOps.getSettings();
  dbOps.updateSettings({
    ...settings,
    integrations: {
      ...settings.integrations,
      prowlarr: { enabled: true, url: fake.url, apiKey: "prowlarr-key" },
      transmission: { enabled: true, url: fake.url, username: "aurral", password: "secret" },
    },
    pathMappings: [{ source: "transmission", remote: "/downloads", local: folder }],
  });
  transmissionClient.updateConfig();
});

afterEach(async () => {
  await fake.close();
  await rm(folder, { recursive: true, force: true });
});

afterAll(async () => {
  await cleanupIsolatedState(state);
});

for (const modern of [false, true]) {
  const protocol = modern ? "JSON-RPC" : "the original protocol";

  test(`over ${protocol}, a download starts a torrent file stopped and a magnet running, and moves on when Transmission already has it`, async () => {
    fake.modern = modern;
    fake.releases = [
      release("file", "Glass Coast - Lowlands [FLAC]"),
      release("magnet", "Glass Coast - Lowlands [MP3]", "/magnet-only", "magnetUrl"),
    ];
    const [file, magnet] = await search();
    assert.ok(file && magnet);
    const input = { album: ALBUM, directory: folder, signal: new AbortController().signal };

    const first = await transmissionSource.albums!.download({ result: file, ...input });
    const second = await transmissionSource.albums!.download({ result: magnet, ...input });
    fake.torrents = [torrent({ name: MAGNET })];

    const [fileAdd, magnetAdd] = fake.calls.filter((call) => call.method === "torrent-add");
    assert.ok(fileAdd && magnetAdd);
    assert.equal(
      Buffer.from(String(fileAdd.args.metainfo), "base64").toString(),
      "d4:infod4:name8:Lowlandsee",
    );
    assert.equal(fileAdd.args.paused, true);
    assert.deepEqual(fileAdd.args.labels, ["aurral", first?.pending]);
    assert.equal(magnetAdd.args.filename, MAGNET);
    assert.equal(magnetAdd.args.paused, undefined);
    assert.deepEqual(magnetAdd.args.labels, ["aurral", second?.pending]);
    assert.notEqual(first?.pending, second?.pending);
    await assert.rejects(
      transmissionSource.albums!.download({ result: magnet, ...input }),
      (error) => error instanceof DownloadSourceError && /didn't add/.test(error.message),
    );
  });

  test(`over ${protocol}, the files are unknown until Transmission has them, then only the ones Aurral keeps download`, async () => {
    fake.modern = modern;
    const { files } = transmissionSource.albums!;
    assert.ok(files);
    const waiting = torrent({ files: [], wanted: [] });
    fake.torrents = [torrent({ hashString: "other", labels: [] }), waiting];

    assert.equal(await files.list("aurral-1"), null);
    Object.assign(waiting, torrent({ wanted: [true, true, true, true] }));
    assert.deepEqual(
      (await files.list("aurral-1"))?.map((file) => file.path),
      [
        "Lowlands/01 Night Drive.flac",
        "Lowlands/CD2/01 Tide.flac",
        "Lowlands/02 Skipped.flac",
        "Lowlands/cover.jpg",
      ],
    );

    await files.keep({
      id: "aurral-1",
      paths: ["Lowlands/01 Night Drive.flac", "Lowlands/CD2/01 Tide.flac"],
    });

    assert.deepEqual(waiting.wanted, [true, true, false, false]);
    assert.equal(waiting.percentDone, 1);
    const sets = fake.calls.filter((call) => call.method === "torrent-set");
    assert.deepEqual(sets[0]?.args["files-unwanted"], [2, 3]);

    fake.calls = [];
    await files.keep({ id: "aurral-1", paths: waiting.files.map((file) => file.name) });
    assert.equal(
      fake.calls.some((call) => call.method === "torrent-set"),
      false,
      "an empty list of unwanted files would mean every file",
    );
  });
}

test("status waits for the torrent, then links the kept audio files into the download folder", async () => {
  await mkdir(path.join(folder, "Lowlands", "CD2"), { recursive: true });
  await writeFile(path.join(folder, "Lowlands", "01 Night Drive.flac"), "audio");
  await writeFile(path.join(folder, "Lowlands", "CD2", "01 Tide.flac"), "audio");
  const directory = path.join(folder, "staging");
  await mkdir(directory);
  const download = torrent();
  fake.torrents = [torrent({ hashString: "untagged", labels: [] }), download];

  assert.deepEqual(await transmissionSource.status({ id: "aurral-1", directory }), { done: false });
  download.status = 2;
  download.percentDone = 1;
  assert.deepEqual(await transmissionSource.status({ id: "aurral-1", directory }), { done: false });
  download.status = 6;
  fake.sid = "second";
  assert.deepEqual(await transmissionSource.status({ id: "aurral-1", directory }), { done: true });

  assert.deepEqual(download.labels, ["aurral", "aurral-1", "aurral-imported"]);
  assert.equal(fake.handshakes, 2);
  assert.deepEqual((await readdir(directory, { recursive: true })).sort(), [
    "Lowlands",
    path.join("Lowlands", "01 Night Drive.flac"),
    path.join("Lowlands", "CD2"),
    path.join("Lowlands", "CD2", "01 Tide.flac"),
  ]);

  Object.assign(download, { error: 2, errorString: "tracker down" });
  assert.deepEqual(await transmissionSource.status({ id: "aurral-1", directory }), { done: true });
  Object.assign(download, { error: 3, errorString: "No space left" });
  await assert.rejects(
    transmissionSource.status({ id: "aurral-1", directory }),
    (error) => error instanceof DownloadSourceError && /No space left/.test(error.message),
  );
});

test("discard removes the torrent and its data, finished or not", async () => {
  fake.torrents = [
    torrent({ hashString: "other", labels: [] }),
    torrent({ hashString: "partial", labels: ["a"] }),
    torrent({ hashString: "done", labels: ["b"], percentDone: 1 }),
  ];

  await transmissionSource.discard!("a");
  await transmissionSource.discard!("b");

  const removals = fake.calls.filter((call) => call.method === "torrent-remove");
  assert.deepEqual(
    removals.map((call) => [call.args.ids, call.args["delete-local-data"]]),
    [
      [["partial"], true],
      [["done"], true],
    ],
  );
});

test("cleanup removes imported torrents once Transmission stops seeding them", async () => {
  fake.torrents = [
    torrent({ hashString: "stopped", status: 0, percentDone: 1, labels: ["x", "aurral-imported"] }),
    torrent({ hashString: "seeding", status: 6, percentDone: 1, labels: ["y", "aurral-imported"] }),
    torrent({ hashString: "partial", status: 0, percentDone: 0.5, labels: ["aurral-imported"] }),
    torrent({ hashString: "unimported", status: 0, percentDone: 1, labels: ["z"] }),
  ];

  await removeSeededTorrents();

  const removals = fake.calls.filter((call) => call.method === "torrent-remove");
  assert.deepEqual(
    removals.map((call) => call.args.ids),
    [["stopped"]],
  );
});

test("a connection test names the version, and reports a wrong password or a Transmission too old for labels", async () => {
  const connected = await transmissionClient.testConnection();
  assert.equal(connected.connected, true);
  assert.match(connected.message, /Transmission 4\.0\.6/);

  fake.rpcVersion = 15;
  const old = await transmissionClient.testConnection();
  assert.equal(old.connected, false);
  assert.match(old.message, /3\.00/);

  fake.rpcVersion = 17;
  fake.password = "changed";
  const rejected = await transmissionClient.testConnection();
  assert.equal(rejected.connected, false);
  assert.match(rejected.message, /username or password/);
});
