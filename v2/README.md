# YTK v2 — karaoke jukebox

Re-implementation of the 2017 `ytk-jukebox` idea (Vue + Firebase, never
finished) with a deliberately boring stack:

- **Frontend:** plain web components, no framework, no build step
  (`static/index.html`, `static/app.js`, `static/style.css`)
- **Backend:** one Python file, stdlib only (`ThreadingHTTPServer` + `sqlite3`)
- **YouTube search:** proxied server-side through the local youtube-proxy,
  so no API keys or browser tokens are involved

## Run it

```sh
cd v2
python3 app.py            # listens on 127.0.0.1:8480 (YTK_PORT to change)
```

SQLite lives in `v2/data/ytk.db` (git-ignored). The systemd unit
`ytk.service` runs this on the tangentcode server behind nginx at
https://karaoke.tangentcode.com.

## What it does

- **Search** — search YouTube (appends "karaoke" by default, toggleable),
  ☆ save songs, + queue them with an optional singer name.
- **Saved** — your bookmark list; queue or remove.
- **Queue** — the KJ console: reorder (↑↓), rename singers inline,
  play-now, mark done, remove, clear played. The ⏯/⏭/↺ buttons remote-control
  the player view (2s poll), so a phone works as the KJ remote.
- **Player** — fullscreen YouTube player, big "🎤 singer" banner, up-next
  list, auto-advance on video end. Videos that block embedding (or are
  gone) are marked `unplayable` and skipped, never hard-fail.

## API

- `GET /api/search?q=&max=` — YouTube search via the proxy
- `GET/POST /api/bookmarks`, `DELETE /api/bookmarks/:id`
- `GET/POST /api/queue`, `PATCH /api/queue/:id` (`singer`, `status`,
  `move: up|down`), `DELETE /api/queue/:id`, `POST /api/queue/clear_played`
- `GET/POST /api/state` — remote-control bus `{cmd, arg}`;
  cmds: `playpause`, `next`, `restart`, `play_id`
