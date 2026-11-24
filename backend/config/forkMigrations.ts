import type Database from "better-sqlite3";

type Migration = (db: Database.Database) => void;

const createPodcasts: Migration = (db) =>
  db.exec(`
    CREATE TABLE IF NOT EXISTS podcasts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      publisher TEXT,
      description TEXT,
      image_url TEXT,
      language TEXT,
      categories TEXT,
      website_url TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS podcast_sources (
      podcast_id INTEGER PRIMARY KEY REFERENCES podcasts(id) ON DELETE CASCADE,
      feed_url TEXT NOT NULL UNIQUE,
      etag TEXT,
      last_modified TEXT,
      last_checked_at INTEGER,
      last_success_at INTEGER,
      last_error TEXT,
      failure_count INTEGER NOT NULL DEFAULT 0,
      next_check_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_podcast_sources_next_check ON podcast_sources(next_check_at);

    CREATE TABLE IF NOT EXISTS podcast_provider_ids (
      provider TEXT NOT NULL,
      external_id TEXT NOT NULL,
      podcast_id INTEGER NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,
      PRIMARY KEY (provider, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_podcast_provider_ids_podcast ON podcast_provider_ids(podcast_id);

    CREATE TABLE IF NOT EXISTS podcast_episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      podcast_id INTEGER NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,
      guid TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      published_at INTEGER,
      duration_seconds INTEGER,
      image_url TEXT,
      enclosure_url TEXT NOT NULL,
      enclosure_type TEXT,
      enclosure_bytes INTEGER,
      season INTEGER,
      episode_number INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE (podcast_id, guid)
    );
    CREATE INDEX IF NOT EXISTS idx_podcast_episodes_published
      ON podcast_episodes(podcast_id, published_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_podcast_episodes_enclosure
      ON podcast_episodes(podcast_id, enclosure_url);

    CREATE TABLE IF NOT EXISTS podcast_media (
      episode_id INTEGER PRIMARY KEY REFERENCES podcast_episodes(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      storage TEXT NOT NULL DEFAULT 'local',
      path TEXT,
      bytes INTEGER,
      content_type TEXT,
      sha256 TEXT,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      downloaded_at INTEGER,
      CHECK (status IN (
        'pending', 'queued', 'downloading', 'downloaded', 'failed', 'awaiting_storage'
      ))
    );
    CREATE INDEX IF NOT EXISTS idx_podcast_media_status ON podcast_media(status);

    CREATE TABLE IF NOT EXISTS podcast_follows (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      podcast_id INTEGER NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,
      followed_at INTEGER NOT NULL,
      keep_latest INTEGER NOT NULL DEFAULT 5,
      auto_download INTEGER NOT NULL DEFAULT 1,
      remove_played INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, podcast_id)
    );
    CREATE INDEX IF NOT EXISTS idx_podcast_follows_podcast ON podcast_follows(podcast_id);

    CREATE TABLE IF NOT EXISTS podcast_entitlements (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      episode_id INTEGER NOT NULL REFERENCES podcast_episodes(id) ON DELETE CASCADE,
      reason TEXT NOT NULL DEFAULT 'retention',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, episode_id),
      CHECK (reason IN ('retention', 'manual'))
    );
    CREATE INDEX IF NOT EXISTS idx_podcast_entitlements_episode ON podcast_entitlements(episode_id);

    CREATE TABLE IF NOT EXISTS podcast_progress (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      episode_id INTEGER NOT NULL REFERENCES podcast_episodes(id) ON DELETE CASCADE,
      position_seconds REAL NOT NULL DEFAULT 0,
      duration_seconds REAL,
      played INTEGER NOT NULL DEFAULT 0,
      completed_at INTEGER,
      last_listened_at INTEGER,
      updated_at INTEGER NOT NULL,
      device_id TEXT,
      PRIMARY KEY (user_id, episode_id)
    );
    CREATE INDEX IF NOT EXISTS idx_podcast_progress_recent
      ON podcast_progress(user_id, last_listened_at DESC);

    CREATE TABLE IF NOT EXISTS podcast_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      episode_id INTEGER NOT NULL REFERENCES podcast_episodes(id) ON DELETE CASCADE,
      listened_at INTEGER NOT NULL,
      seconds INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_podcast_history_user
      ON podcast_history(user_id, listened_at DESC);
  `);

const addColumn = (db: Database.Database, table: string, column: string, type: string) => {
  const exists = db
    .prepare<[string, string]>("SELECT 1 FROM pragma_table_info(?) WHERE name = ?")
    .get(table, column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
};

const trackPodcastDownloadProgress: Migration = (db) => {
  addColumn(db, "podcast_media", "progress_bytes", "INTEGER");
  addColumn(db, "podcast_media", "total_bytes", "INTEGER");
};

const createPodcastImports: Migration = (db) =>
  db.exec(`
    CREATE TABLE IF NOT EXISTS podcast_imports (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      feed_url TEXT NOT NULL,
      title TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      podcast_id INTEGER REFERENCES podcasts(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, feed_url),
      CHECK (status IN ('pending', 'done', 'failed'))
    );
  `);

const addPodcastChapters: Migration = (db) => {
  addColumn(db, "podcast_episodes", "chapters_url", "TEXT");
  addColumn(db, "podcast_episodes", "chapters_json", "TEXT");
  addColumn(db, "podcast_episodes", "chapters_checked_at", "INTEGER");
};

const addPodcastNotify: Migration = (db) =>
  addColumn(db, "podcast_follows", "notify", "INTEGER NOT NULL DEFAULT 0");

const forkMigrations: [string, Migration][] = [
  ["createPodcasts", createPodcasts],
  ["trackPodcastDownloadProgress", trackPodcastDownloadProgress],
  ["createPodcastImports", createPodcastImports],
  ["addPodcastChapters", addPodcastChapters],
  ["addPodcastNotify", addPodcastNotify],
];

export function migrateFork(db: Database.Database) {
  db.exec("CREATE TABLE IF NOT EXISTS fork_migrations (name TEXT PRIMARY KEY)");
  const applied = new Set(
    db
      .prepare<[], { name: string }>("SELECT name FROM fork_migrations")
      .all()
      .map((row) => row.name),
  );
  const record = db.prepare<[string]>("INSERT INTO fork_migrations (name) VALUES (?)");
  db.transaction(() => {
    for (const [name, step] of forkMigrations) {
      if (applied.has(name)) continue;
      step(db);
      record.run(name);
    }
  }).immediate();
}
