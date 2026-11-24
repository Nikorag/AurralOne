import fs from "node:fs/promises";
import path from "node:path";
import { resolveAurralDataDir } from "../../config/data-dir.ts";

export interface StoredFile {
  name: string;
  size: number;
  mtimeMs: number;
}

export interface MediaStore {
  root: () => string;
  partPath: (episodeId: number) => string;
  resolve: (name: string) => string;
  commit: (partPath: string, name: string) => Promise<void>;
  remove: (name: string) => Promise<void>;
  size: (name: string) => Promise<number | null>;
  list: () => Promise<StoredFile[]>;
}

const root = () => path.join(resolveAurralDataDir(), "podcasts");

export const localMediaStore: MediaStore = {
  root,
  partPath: (episodeId) => path.join(root(), `${episodeId}.part`),
  resolve(name) {
    const resolved = path.resolve(root(), name);
    if (path.dirname(resolved) !== path.resolve(root())) throw new Error("Invalid media name");
    return resolved;
  },
  async commit(partPath, name) {
    await fs.rename(partPath, this.resolve(name));
  },
  async remove(name) {
    await fs.rm(this.resolve(name), { force: true });
  },
  async size(name) {
    try {
      return (await fs.stat(this.resolve(name))).size;
    } catch {
      return null;
    }
  },
  async list() {
    const entries = await fs.readdir(root(), { withFileTypes: true }).catch(() => []);
    const files: StoredFile[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const stat = await fs.stat(path.join(root(), entry.name)).catch(() => null);
      if (stat) files.push({ name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs });
    }
    return files;
  },
};

export const mediaStore: MediaStore = localMediaStore;
