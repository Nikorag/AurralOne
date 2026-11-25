<div align="center" width="100%">
  <img src="docs/src/assets/aurralone-logo.png" width="600" alt="Aurral One" />
</div>

<p align="center">
  <a href="https://github.com/Nikorag/AurralOne/releases"><img src="https://img.shields.io/github/v/release/Nikorag/AurralOne" alt="Release" /></a>
</p>

<p align="center"><b>AurralOne</b> is a fork of <a href="https://github.com/lklynet/aurral">Aurral</a> that adds podcasts and a Transmission download client. Everything else is Aurral: one container, zero API keys, and you own every file.</p>

<p align="center">
  <a href="https://docs.aurral.org/">Upstream docs</a> ·
  <a href="https://github.com/lklynet/aurral">Upstream project</a> ·
  <a href="https://github.com/Nikorag/AurralOne/issues">Issues</a>
</p>

<p align="center">
  <img src="web/screenshots/discover.webp" width="900" alt="Aurral Discover page" />
</p>

- **Discover** artists you'll like, with a real reason for every pick. Bootstrap straight from your Spotify history.
- **Flows** turn your taste into scheduled playlists that grab their own tracks and rotate on autopilot. Daily mixes build from what you play.
- **Import** playlists from Spotify, YouTube Music, Last.fm, ListenBrainz, and M3U files.
- **Library** managed for you, with real audio verification, automatic tagging, and read-only folder support for music you don't want touched.
- **Listen** with synced lyrics and radio in the built-in player, from anywhere at [music.aurral.org](https://music.aurral.org), or in any Subsonic app. Already on Navidrome, Plex, or Jellyfin? Aurral writes M3U playlists and plays nice with all of them.
- **Friends** see what people on your server and your aurral.org friends are playing, and Blends mix your taste with theirs.
- **Share** tracks, albums, and playlists as links, publish public playlists, or let friends play straight from your Library.
- **Podcasts** (AurralOne) follow shows from iTunes, Podcast Index, or any RSS feed. Progress syncs between devices, episodes download once for everyone, and a storage limit keeps the disk in check. OPML import and export, chapters, a sleep timer, voice boost, and new-episode notifications are included. See [Podcasts](docs/src/content/docs/using/podcasts.mdx).
- **Plugins** add download sources, imports, and actions when you want them.

Connect slskd, Usenet, qBittorrent, Tidarr, deemix, or download plugins for lossless music, with built-in yt-dlp ready as a fallback out of the box. Every integration is optional. [Read the docs](https://docs.aurral.org/) for the full tour, or check the [FAQ](https://docs.aurral.org/faq/).

## New features in Aurral One

- **Podcast support.** Follow shows from iTunes, Podcast Index, or any RSS feed, with progress synced between devices, shared episode downloads, OPML import and export, chapters, and new-episode notifications. See [Podcasts](docs/src/content/docs/using/podcasts.mdx).
- **Transmission client.** Use Transmission as a torrent download source, as an alternative to qBittorrent. It shares the same Prowlarr search and supports both the classic RPC and the Transmission 4.1 JSON-RPC protocols. See [Transmission](docs/src/content/docs/integrations/transmission.mdx).
- **Single sign-on with OIDC, including PocketID.** Admins can set up OpenID Connect sign-in in the web UI. See [Single sign-on (OIDC)](#single-sign-on-oidc).

## Single sign-on (OIDC)

Aurral signs people in through any OpenID Connect provider. [PocketID](https://pocket-id.org/) works well. Configure it in **Settings > Users > Sign-in > Single sign-on (OIDC)**, or with environment variables. When both set a field, the environment variable wins and the field is greyed out in Settings. The client secret is stored encrypted and is never sent back to the browser.

For PocketID:

1. Create an OIDC client for Aurral in PocketID, marked as confidential, with the callback URL `https://<your-aurral-host>/sso/callback`.
2. Set the issuer to the PocketID base URL, enter the client ID and secret, and use the same callback URL as the redirect URI.
3. Use the scopes `openid profile email groups`. To map a PocketID group to the Aurral admin role, set the groups claim to `groups` and list the group as an admin group.

The same setup with environment variables:

```yaml
environment:
  - OIDC_ENABLED=true
  - OIDC_ISSUER=https://id.example.com
  - OIDC_CLIENT_ID=aurral
  - OIDC_CLIENT_SECRET=change-me
  - OIDC_REDIRECT_URI=https://aurral.example.com/sso/callback
  - OIDC_SCOPES=openid profile email groups
  - OIDC_GROUPS_CLAIM=groups
  - OIDC_ADMIN_GROUPS=admins
```

Optional variables are `OIDC_TOKEN_ENDPOINT_AUTH_METHOD`, `OIDC_USERNAME_CLAIM`, `OIDC_DEFAULT_ROLE`, `OIDC_ADMIN_USERS`, and `OIDC_LOGOUT_URL`. See [Native OIDC](docs/src/content/docs/admin/users.mdx#native-oidc) and [Environment variables](docs/src/content/docs/admin/environment.mdx).

## Quick start

```yaml
services:
  aurral:
    image: ghcr.io/nikorag/aurralone:latest
    restart: unless-stopped
    ports:
      - "3001:3001"
    environment:
      - PUID=1000
      - PGID=1000
    volumes:
      - ./config:/config
      - ./data:/data
```

Run `docker compose up -d`, open `http://localhost:3001`, and create your admin account. No companion containers required to start. The image is built for `linux/amd64` and `linux/arm64`. `latest` is the newest release and version tags like `1.0.0` are pinned. `nightly` follows `main` and is `amd64` only.

## About this fork

AurralOne tracks upstream. A scheduled workflow merges `lklynet/aurral` into `main` through a pull request, so new upstream features and fixes arrive here. The podcast work lives in `backend/services/podcasts/`, `frontend/src/pages/podcasts/`, and [ADR 0016](docs/architecture/0016-podcasts.md). It was offered upstream and not taken, so it is maintained here.

The rest of the documentation is Aurral's and lives at [docs.aurral.org](https://docs.aurral.org/). Report problems with podcasts or this image in [this repo's issues](https://github.com/Nikorag/AurralOne/issues), and anything else upstream.

## Thanks

All credit for Aurral goes to [lklynet](https://github.com/lklynet) and its contributors. If you like it, [sponsor the upstream project](https://github.com/sponsors/lklynet/), which also pays for AurralBrainz, the hosted metadata server this fork relies on. Built on open music data from [MetaBrainz](https://metabrainz.org) ([MusicBrainz](https://musicbrainz.org), [ListenBrainz](https://listenbrainz.org), and the [Cover Art Archive](https://coverartarchive.org)).

Aurral is MIT licensed.
