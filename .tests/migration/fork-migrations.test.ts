import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { test } from "vite-plus/test";
import { migrateFork } from "../../backend/config/forkMigrations.ts";
import { migrate } from "../../backend/config/migrations.ts";

test("removing a podcast file or unfollowing keeps listening progress", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  migrate(db);
  migrateFork(db);
  db.exec(`
    INSERT INTO users (id, username, password_hash) VALUES (1, 'a', 'x');
    INSERT INTO podcasts (id, title, created_at) VALUES (1, 'Show', 0);
    INSERT INTO podcast_episodes (id, podcast_id, guid, title, enclosure_url, created_at)
      VALUES (1, 1, 'g1', 'One', 'https://example.com/1.mp3', 0);
    INSERT INTO podcast_media (episode_id, status, path, updated_at)
      VALUES (1, 'downloaded', '/p/1.mp3', 0);
    INSERT INTO podcast_follows (user_id, podcast_id, followed_at) VALUES (1, 1, 0);
    INSERT INTO podcast_entitlements (user_id, episode_id, created_at) VALUES (1, 1, 0);
    INSERT INTO podcast_progress (user_id, episode_id, position_seconds, updated_at)
      VALUES (1, 1, 42, 0);
  `);

  db.exec(
    "DELETE FROM podcast_media; DELETE FROM podcast_entitlements; DELETE FROM podcast_follows",
  );
  const progress = db.prepare("SELECT position_seconds AS p FROM podcast_progress").get();
  assert.deepEqual(progress, { p: 42 });
  assert.throws(() =>
    db.exec("INSERT INTO podcast_media (episode_id, status, updated_at) VALUES (1, 'bogus', 0)"),
  );
});

test("running the fork migrations again changes nothing", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  migrate(db);
  migrateFork(db);
  migrateFork(db);
  const applied = db.prepare("SELECT COUNT(*) AS n FROM fork_migrations").get();
  assert.deepEqual(applied, { n: 5 });
});
