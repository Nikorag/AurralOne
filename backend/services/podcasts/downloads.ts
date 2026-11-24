import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as v from "valibot";
import { http } from "../../../lib/http.ts";
import { db } from "../../config/db-sqlite.ts";
import { podcastDownloadQueue } from "../jobs/queues.ts";
import { mediaStore } from "./mediaStore.ts";
import { availableBytes, removeUnreferencedMedia } from "./storage.ts";

const MAX_EPISODE_BYTES = 3 * 1024 ** 3;
const HOUR = 60 * 60_000;

export const podcastDownloadSchema = v.object({ episodeId: v.number() });

export const CONTENT_TYPES: Record<string, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  flac: "audio/flac",
};

const SNIFF_BYTES = 12;

export function sniffAudio(head: Buffer) {
  const ascii = (start: number, end: number) => head.subarray(start, end).toString("latin1");
  if (ascii(0, 3) === "ID3") return "mp3";
  if (head[0] === 0xff && (head[1] ?? 0) >= 0xf0 && ((head[1] ?? 0) & 0x06) === 0) return "aac";
  if (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0) return "mp3";
  if (ascii(4, 8) === "ftyp") return "m4a";
  if (ascii(0, 4) === "OggS") return "ogg";
  if (ascii(0, 4) === "fLaC") return "flac";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "wav";
  return null;
}

const statements = {
  episode: db.prepare<
    [number],
    { id: number; enclosure_url: string; enclosure_bytes: number | null }
  >("SELECT id, enclosure_url, enclosure_bytes FROM podcast_episodes WHERE id = ?"),
  media: db.prepare<[number], { status: string; path: string | null }>(
    "SELECT status, path FROM podcast_media WHERE episode_id = ?",
  ),
  entitled: db.prepare<[number], { n: number }>(
    "SELECT COUNT(*) AS n FROM podcast_entitlements WHERE episode_id = ?",
  ),
  claim: db.prepare<[number, number]>(
    `UPDATE podcast_media SET status = 'downloading', error = NULL, updated_at = ?,
       attempts = attempts + 1
     WHERE episode_id = ? AND status IN ('pending', 'queued', 'failed', 'awaiting_storage')`,
  ),
  setStatus: db.prepare<[string, string | null, number, number]>(
    "UPDATE podcast_media SET status = ?, error = ?, updated_at = ? WHERE episode_id = ?",
  ),
  done: db.prepare<[string, number, string, string, number, number, number]>(
    `UPDATE podcast_media SET status = 'downloaded', path = ?, bytes = ?, content_type = ?,
       sha256 = ?, error = NULL, updated_at = ?, downloaded_at = ? WHERE episode_id = ?`,
  ),
  setSize: db.prepare<[number, number]>(
    "UPDATE podcast_episodes SET enclosure_bytes = ? WHERE id = ?",
  ),
  drop: db.prepare<[number]>("DELETE FROM podcast_media WHERE episode_id = ?"),
  waiting: db.prepare<[], { episode_id: number }>(
    `SELECT m.episode_id FROM podcast_media m
     WHERE m.status IN ('pending', 'awaiting_storage', 'failed') AND m.attempts < 8
       AND EXISTS (SELECT 1 FROM podcast_entitlements n WHERE n.episode_id = m.episode_id)
     ORDER BY m.updated_at LIMIT 200`,
  ),
  queue: db.prepare<[number, number]>(
    `UPDATE podcast_media SET status = 'queued', updated_at = ?
     WHERE episode_id = ? AND status IN ('pending', 'awaiting_storage', 'failed')`,
  ),
};

export function queueDownloads(episodeIds: Iterable<number>) {
  for (const episodeId of episodeIds) {
    statements.queue.run(Date.now(), episodeId);
    podcastDownloadQueue.enqueue({ episodeId }, { dedupeKey: `episode:${episodeId}` });
  }
}

export const queueWaitingDownloads = () =>
  queueDownloads(statements.waiting.all().map((row) => row.episode_id));

class DownloadRefused extends Error {}
class StorageFull extends Error {}

const causes = (error: unknown) => {
  const chain: unknown[] = [];
  for (let current = error; current && chain.length < 5; current = (current as Error).cause) {
    chain.push(current);
  }
  return chain;
};

export async function downloadEpisode(episodeId: number, signal?: AbortSignal) {
  const episode = statements.episode.get(episodeId);
  const media = statements.media.get(episodeId);
  if (!episode || !media) return "missing" as const;
  if (statements.entitled.get(episodeId)?.n === 0) {
    statements.drop.run(episodeId);
    return "unneeded" as const;
  }
  if (media.status === "downloaded" && media.path && (await mediaStore.size(media.path)) !== null) {
    return "downloaded" as const;
  }

  const needed = episode.enclosure_bytes ?? 0;
  if (availableBytes() < needed) await removeUnreferencedMedia();
  if (availableBytes() < Math.max(needed, 1)) {
    statements.setStatus.run(
      "awaiting_storage",
      "The podcast storage limit is full",
      Date.now(),
      episodeId,
    );
    return "awaiting_storage" as const;
  }
  if (statements.claim.run(Date.now(), episodeId).changes === 0) return "claimed" as const;

  const part = mediaStore.partPath(episodeId);
  const allowed = Math.min(MAX_EPISODE_BYTES, availableBytes() + needed);
  try {
    await fs.mkdir(mediaStore.root(), { recursive: true });
    const hash = createHash("sha256");
    const result = await http.get(episode.enclosure_url, {
      publicOnly: true,
      signal,
      timeoutMs: 60_000,
      bodyTimeoutMs: 6 * HOUR,
      headers: { Accept: "audio/*, */*;q=0.5" },
      consume: async (body, headers) => {
        const declared = Number(headers.get("content-length"));
        if (declared > allowed) {
          statements.setSize.run(declared, episodeId);
          throw allowed < MAX_EPISODE_BYTES
            ? new StorageFull("Not enough podcast storage")
            : new DownloadRefused("The episode is larger than allowed");
        }
        let bytes = 0;
        let head = Buffer.alloc(0);
        const limiter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length;
            if (head.length < SNIFF_BYTES)
              head = Buffer.concat([head, chunk]).subarray(0, SNIFF_BYTES);
            if (bytes > allowed) {
              return callback(
                allowed < MAX_EPISODE_BYTES
                  ? new StorageFull("Not enough podcast storage")
                  : new DownloadRefused("The episode is larger than allowed"),
              );
            }
            hash.update(chunk);
            callback(null, chunk);
          },
        });
        await pipeline(
          Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]),
          limiter,
          createWriteStream(part),
        );
        return { bytes, head };
      },
    });
    const { bytes, head } = result.data as { bytes: number; head: Buffer };
    const kind = sniffAudio(head);
    const contentType = String(result.headers["content-type"] ?? "")
      .split(";")[0]
      ?.trim()
      .toLowerCase();
    if (!bytes || !kind) throw new DownloadRefused("The download is not an audio file");
    if (contentType && /^(text\/|application\/(json|xml))/.test(contentType)) {
      throw new DownloadRefused(`Unexpected content type ${contentType}`);
    }
    const name = `${episodeId}.${kind}`;
    await mediaStore.commit(part, name);
    const now = Date.now();
    statements.done.run(
      name,
      bytes,
      CONTENT_TYPES[kind] ?? "audio/mpeg",
      hash.digest("hex"),
      now,
      now,
      episodeId,
    );
    return "downloaded" as const;
  } catch (error) {
    await fs.rm(part, { force: true });
    if (causes(error).some((cause) => cause instanceof StorageFull)) {
      statements.setStatus.run(
        "awaiting_storage",
        "The podcast storage limit is full",
        Date.now(),
        episodeId,
      );
      return "awaiting_storage" as const;
    }
    const message = error instanceof Error ? error.message : String(error);
    statements.setStatus.run("failed", message.slice(0, 300), Date.now(), episodeId);
    if (causes(error).some((cause) => cause instanceof DownloadRefused)) return "failed" as const;
    throw error;
  }
}
