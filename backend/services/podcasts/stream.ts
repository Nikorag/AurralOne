import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { http } from "../../../lib/http.ts";
import { db } from "../../config/db-sqlite.ts";
import { CONTENT_TYPES } from "./downloads.ts";

const FORWARDED = ["content-length", "content-range", "accept-ranges", "etag", "last-modified"];

const episodeUrl = db.prepare<[number], { enclosure_url: string }>(
  "SELECT enclosure_url FROM podcast_episodes WHERE id = ?",
);

const audioType = (upstream: string | null, url: string) => {
  const type = (upstream ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (type.startsWith("audio/")) return type;
  if (type && type !== "application/octet-stream" && type !== "binary/octet-stream") return null;
  const extension = path.extname(new URL(url).pathname).slice(1).toLowerCase();
  return CONTENT_TYPES[extension] ?? "audio/mpeg";
};

export async function streamEpisode(
  episodeId: number,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<"sent" | "missing" | "unavailable"> {
  const row = episodeUrl.get(episodeId);
  if (!row) return "missing";
  const controller = new AbortController();
  res.once("close", () => controller.abort());
  const range = typeof req.headers.range === "string" ? req.headers.range : undefined;
  let sent = false;
  try {
    await http.get(row.enclosure_url, {
      publicOnly: true,
      signal: controller.signal,
      timeoutMs: 30_000,
      bodyTimeoutMs: 6 * 60 * 60_000,
      okStatus: (status) => status === 200 || status === 206 || status === 416,
      headers: { Accept: "audio/*, */*;q=0.5", ...(range && { Range: range }) },
      consume: async (body, headers, status) => {
        const type = audioType(headers.get("content-type"), row.enclosure_url);
        if (!type) throw new Error("The publisher didn't send audio");
        res.statusCode = status;
        res.setHeader("Content-Type", type);
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Cache-Control", "private, no-store");
        for (const name of FORWARDED) {
          const value = headers.get(name);
          if (value) res.setHeader(name, value);
        }
        if (!headers.get("accept-ranges")) res.setHeader("Accept-Ranges", "none");
        sent = true;
        if (req.method === "HEAD" || status === 416) {
          res.end();
          return;
        }
        await new Promise<void>((resolve, reject) => {
          const source = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
          source.once("error", reject);
          res.once("close", resolve);
          source.pipe(res);
          source.once("end", resolve);
        });
      },
    });
    return "sent";
  } catch {
    if (sent) {
      res.destroy();
      return "sent";
    }
    return "unavailable";
  }
}
