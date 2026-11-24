import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as v from "valibot";
import { asAppError } from "../../lib/errors.ts";
import { DownloadSourceError, type DownloadSource } from "./download/downloadSource.ts";
import { isAudioFile } from "./downloadJobs/usenetReleaseSearch.ts";
import { getPathMappings, resolveLocalPath } from "./pathMappings.ts";
import { fetchTorrent, releaseData, searchReleases } from "./qbittorrentSource.ts";
import { transmissionClient } from "./transmissionClient.ts";

const CHECKING = new Set([1, 2]);
const STOPPED = 0;
const LOCAL_ERROR = 3;
const IMPORTED_LABEL = "aurral-imported";

const failure = (error: unknown) => asAppError(error)?.message || String(error);

async function labelledTorrent(label: string) {
  const [torrent] = await transmissionClient.torrentsLabelled(label);
  if (!torrent) throw new DownloadSourceError("Transmission no longer has the torrent");
  return torrent;
}

async function linkAudioFiles(
  torrent: { hashString: string; downloadDir: string },
  directory: string,
) {
  const files = (await transmissionClient.torrentFiles(torrent.hashString)).filter(
    (file) =>
      file.wanted &&
      isAudioFile(file.name) &&
      !path.relative(directory, path.join(directory, file.name)).startsWith(".."),
  );
  if (files.length === 0) throw new DownloadSourceError("The torrent has no audio files");
  const mappings = getPathMappings("transmission");
  for (const file of files) {
    const from = resolveLocalPath(`${torrent.downloadDir}/${file.name}`, mappings);
    const target = path.join(directory, file.name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs
      .link(from, target)
      .catch(() => fs.copyFile(from, target))
      .catch(() => {
        throw new DownloadSourceError(
          `Aurral can't find ${from}. Add a remote path mapping for Transmission.`,
        );
      });
  }
}

export const transmissionSource = {
  id: "transmission",
  staging: "transmission",
  albums: {
    async search(album, { upgrade }) {
      const ranked = await searchReleases(album, upgrade).catch((error: unknown) => {
        if (error instanceof DownloadSourceError) throw error;
        throw new DownloadSourceError(`Prowlarr search failed: ${failure(error)}`);
      });
      return ranked.map(({ raw, resolvedAlbumName }) => ({
        id: raw.release.guid || String(raw.downloadUrl),
        title: String(resolvedAlbumName),
        artist: album.artist || raw.release.title,
        data: { downloadUrl: raw.release.downloadUrl, magnetUrl: raw.release.magnetUrl },
      }));
    },
    async download({ result }) {
      const label = `aurral-${randomUUID()}`;
      const added = await transmissionClient.addTorrent(
        await fetchTorrent(v.parse(releaseData, result.data)),
        label,
      );
      if (!added) throw new DownloadSourceError("Transmission didn't add the torrent");
      return { pending: label };
    },
    files: {
      async list(id) {
        const [torrent] = await transmissionClient.torrentsLabelled(id);
        const files = torrent ? await transmissionClient.torrentFiles(torrent.hashString) : [];
        return files.length > 0 ? files.map(({ name, size }) => ({ path: name, size })) : null;
      },
      async keep({ id, paths }) {
        const torrent = await labelledTorrent(id);
        const files = await transmissionClient.torrentFiles(torrent.hashString);
        await transmissionClient.skipFiles(
          torrent.hashString,
          files.filter((file) => !paths.includes(file.name)).map((file) => file.index),
        );
        await transmissionClient.startTorrent(torrent.hashString);
      },
    },
  },
  async status({ id, directory }) {
    const torrent = await labelledTorrent(id);
    if (torrent.error === LOCAL_ERROR)
      throw new DownloadSourceError(
        `Transmission stopped the torrent: ${torrent.errorString || "local error"}`,
      );
    if (torrent.percentDone < 1 || CHECKING.has(torrent.status)) return { done: false };
    await linkAudioFiles(torrent, directory);
    await transmissionClient.addLabel(torrent, IMPORTED_LABEL);
    return { done: true };
  },
  async discard(id) {
    const torrents = await transmissionClient.torrentsLabelled(id);
    await transmissionClient.deleteTorrents(torrents.map((torrent) => torrent.hashString));
  },
} satisfies DownloadSource;

export async function removeSeededTorrents() {
  if (!transmissionClient.isConfigured()) return;
  const torrents = await transmissionClient.torrentsLabelled(IMPORTED_LABEL);
  await transmissionClient.deleteTorrents(
    torrents
      .filter((torrent) => torrent.percentDone >= 1 && torrent.status === STOPPED)
      .map((torrent) => torrent.hashString),
  );
}
