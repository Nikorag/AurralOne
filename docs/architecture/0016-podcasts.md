# Podcasts

Status: Accepted

## Problem

Podcasts are episodic and shared: many users follow the same show, each wants a different number of episodes kept, and the audio is large. Music's model, one Library everyone reads, fits none of that.

## Decision

Podcasts have their own tables and queues, and share only the job queue, the SSRF-safe fetcher, and file serving with the rest of Aurral.

- **One file per episode.** `podcast_media` has one row per episode, so two users can never cause two downloads or two files. A claim on that row, plus the queue's dedupe key, stops concurrent downloads.
- **Users hold entitlements, not files.** `podcast_entitlements` says which user keeps which episode, as `retention` (inside their latest-N window) or `manual`. A file is needed while any entitlement points at it. With none, cleanup removes it after a grace period, and never while someone played it recently.
- **Progress points at the episode, never the file.** Deleting media, unfollowing, or reconciling storage can't touch `podcast_progress` or `podcast_history`. Only "erase my history" does.
- **The storage limit defers, it doesn't evict.** A download that doesn't fit becomes `awaiting_storage` and retries when space frees up. Aurral never removes an episode a user keeps to make room.
- **Progress sync is last-write-wins by client time.** A write older than the stored one is ignored and the server returns the winner. Client clocks are clamped to five minutes ahead so a wrong clock can't lock a user out.
- **Directories are optional.** Following works from any RSS URL. Apple Podcasts and Podcast Index only supply search and browse, behind `PodcastDirectory`. Anything else is a plugin.

- **Episodes that aren't downloaded stream through the server.** The browser can only process same-origin audio (voice boost, silence trimming), and a cross-origin source goes silent once it is routed through Web Audio. Streaming also fixes `http`-only enclosures under the CSP. The route only serves stored episodes and only audio types, so it isn't an open proxy.
- **Podcasts don't use the share-link system.** Those links are published to aurral.org, which would need a podcast page. A show shares as its feed URL or a link on this server.

## Traps

- Feeds and audio go through `http` with `publicOnly`, which pins DNS and re-checks every redirect. Eden's proxy doesn't see these requests, so Eden can't serve a fake feed.
- A `consume` callback's errors reach the caller wrapped in `HttpError`. Check `cause`.
- The audio route accepts a link token, because `<audio>` can't send an `Authorization` header. It still checks that the user holds the episode.
