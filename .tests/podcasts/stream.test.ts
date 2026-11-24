import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { http: client }, { streamEpisode }] = await setupIsolatedBackend(
  "podcast-stream",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../lib/http.ts"),
  () => import("../../backend/services/podcasts/stream.ts"),
);

const server = http.createServer((req, res) => {
  const episodeId = Number(new URL(req.url ?? "", "http://x").searchParams.get("id"));
  void streamEpisode(episodeId, req, res).then((result) => {
    if (result === "missing") res.writeHead(404).end();
    else if (result === "unavailable") res.writeHead(502).end();
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const publisher = (
  status: number,
  headers: Record<string, string>,
  body: string,
  seen: { range?: string | null; url?: string } = {},
) =>
  vi.spyOn(client, "get").mockImplementation(async (url, options) => {
    seen.url = url;
    seen.range = options?.headers?.Range ?? null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    });
    const data = await options?.consume?.(stream, new Headers(headers), status);
    return { status, statusText: "", headers, data };
  });

beforeEach(() => {
  vi.restoreAllMocks();
  db.exec("DELETE FROM podcasts");
  db.exec(`
    INSERT INTO podcasts (id, title, created_at) VALUES (1, 'Show', 0);
    INSERT INTO podcast_episodes (id, podcast_id, guid, title, enclosure_url, created_at)
      VALUES (1, 1, 'g', 'One', 'http://cdn.example.com/one.mp3', 0);
  `);
});

afterAll(async () => {
  server.close();
  await cleanupIsolatedState(isolatedState);
});

test("a range request is passed to the publisher and its partial answer comes back", async () => {
  const seen: { range?: string | null; url?: string } = {};
  publisher(
    206,
    {
      "content-type": "audio/mpeg",
      "content-range": "bytes 0-4/100",
      "content-length": "5",
      "accept-ranges": "bytes",
    },
    "12345",
    seen,
  );
  const response = await fetch(`${base}/?id=1`, { headers: { Range: "bytes=0-4" } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 0-4/100");
  assert.equal(response.headers.get("content-type"), "audio/mpeg");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await response.text(), "12345");
  assert.equal(seen.range, "bytes=0-4");
  assert.equal(seen.url, "http://cdn.example.com/one.mp3");
});

test("a publisher answer that is not audio is never passed on", async () => {
  publisher(200, { "content-type": "text/html" }, "<script>alert(1)</script>");
  const response = await fetch(`${base}/?id=1`);
  assert.equal(response.status, 502);
  assert.equal((await response.text()).includes("script"), false);
});

test("a generic content type is served as the audio type its file name suggests", async () => {
  db.exec("UPDATE podcast_episodes SET enclosure_url = 'https://cdn.example.com/one.m4a'");
  publisher(200, { "content-type": "application/octet-stream" }, "abc");
  const response = await fetch(`${base}/?id=1`);
  assert.equal(response.headers.get("content-type"), "audio/mp4");
});

test("only stored episodes can be streamed, and a failing publisher is a 502", async () => {
  const get = publisher(200, { "content-type": "audio/mpeg" }, "x");
  assert.equal((await fetch(`${base}/?id=999`)).status, 404);
  assert.equal(get.mock.calls.length, 0);
  vi.spyOn(client, "get").mockRejectedValue(
    new Error("Only public HTTP and HTTPS URLs are allowed"),
  );
  assert.equal((await fetch(`${base}/?id=1`)).status, 502);
});
