#!/usr/bin/env python3
"""YTK v2 — karaoke jukebox backend.

Plain stdlib: ThreadingHTTPServer + sqlite3. No dependencies.
Serves the web-component frontend and a small JSON API.
YouTube search goes through the local youtube-proxy (127.0.0.1:8472)
so the proxy Bearer token never reaches the browser.
"""
import json
import os
import re
import sqlite3
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(HERE, "static")
DATA_DIR = os.path.join(HERE, "data")
DB_PATH = os.path.join(DATA_DIR, "ytk.db")

PORT = int(os.environ.get("YTK_PORT", "8480"))
PROXY_BASE = os.environ.get("YTK_PROXY_BASE", "http://127.0.0.1:8472")
PROXY_TOKEN_PATH = os.environ.get(
    "YTK_PROXY_TOKEN_PATH", "/home/memnar/youtube-proxy/.proxy-token"
)

db_lock = threading.Lock()
state_lock = threading.Lock()
# Remote-control bus for the player view. In-memory is fine for the MVP:
# the player re-syncs from the queue on load.
remote_state = {"seq": 0, "cmd": None, "arg": None}


def proxy_token():
    with open(PROXY_TOKEN_PATH) as f:
        return f.read().strip()


def db():
    os.makedirs(DATA_DIR, exist_ok=True)
    con = sqlite3.connect(DB_PATH, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute(
        """CREATE TABLE IF NOT EXISTS bookmarks(
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             video_id TEXT UNIQUE NOT NULL,
             title TEXT NOT NULL DEFAULT '',
             channel TEXT NOT NULL DEFAULT '',
             thumb TEXT NOT NULL DEFAULT '',
             created_at REAL NOT NULL)"""
    )
    con.execute(
        """CREATE TABLE IF NOT EXISTS queue(
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             video_id TEXT NOT NULL,
             title TEXT NOT NULL DEFAULT '',
             channel TEXT NOT NULL DEFAULT '',
             thumb TEXT NOT NULL DEFAULT '',
             singer TEXT NOT NULL DEFAULT '',
             position INTEGER NOT NULL DEFAULT 0,
             status TEXT NOT NULL DEFAULT 'queued',
             created_at REAL NOT NULL)"""
    )
    return con


CON = db()


def yt_search(query, max_results=12):
    """Search YouTube via the local proxy. Returns simplified items."""
    params = urllib.parse.urlencode(
        {
            "part": "snippet",
            "q": query,
            "type": "video",
            "videoEmbeddable": "true",
            "maxResults": max_results,
            "safeSearch": "moderate",
        }
    )
    req = urllib.request.Request(
        PROXY_BASE + "/v3/search?" + params,
        headers={"Authorization": "Bearer " + proxy_token()},
    )
    with urllib.request.urlopen(req, timeout=25) as r:
        data = json.load(r)
    items = []
    for it in data.get("items", []):
        vid = (it.get("id") or {}).get("videoId")
        sn = it.get("snippet", {})
        if not vid:
            continue
        thumbs = sn.get("thumbnails", {})
        thumb = (thumbs.get("medium") or thumbs.get("default") or {}).get("url", "")
        items.append(
            {
                "videoId": vid,
                "title": sn.get("title", ""),
                "channel": sn.get("channelTitle", ""),
                "thumb": thumb,
            }
        )
    return items


MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "YTK/2.0"

    # ---- helpers -----------------------------------------------------
    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _err(self, code, msg):
        self._json({"error": msg}, code)

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0:
            return {}
        raw = self.rfile.read(n)
        try:
            return json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            return {}
    @staticmethod
    def _rows(cur):
        return [dict(r) for r in cur.fetchall()]

    def _serve(self, name):
        # No directory traversal: only flat files under static/.
        if "/" in name or name.startswith("."):
            return self._err(404, "not found")
        fpath = os.path.join(STATIC_DIR, name)
        if not os.path.isfile(fpath):
            return self._err(404, "not found")
        ext = os.path.splitext(name)[1].lower()
        ctype = MIME.get(ext, "application/octet-stream")
        try:
            with open(fpath, "rb") as f:
                data = f.read()
        except OSError:
            return self._err(404, "not found")
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    # ---- GET ---------------------------------------------------------
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path, qs = parsed.path, urllib.parse.parse_qs(parsed.query)

        if path == "/api/health":
            return self._json({"ok": True, "service": "ytk-v2"})
        if path == "/api/search":
            q = (qs.get("q") or [""])[0].strip()
            if not q:
                return self._err(400, "missing q")
            try:
                maxr = min(25, max(1, int((qs.get("max") or ["12"])[0])))
            except ValueError:
                maxr = 12
            try:
                return self._json(yt_search(q, maxr))
            except Exception as e:  # proxy down / quota / network
                return self._err(502, "youtube search failed: %s" % e)
        if path == "/api/bookmarks":
            with db_lock:
                cur = CON.execute("SELECT * FROM bookmarks ORDER BY created_at DESC")
                return self._json(self._rows(cur))
        if path == "/api/queue":
            with db_lock:
                cur = CON.execute(
                    "SELECT * FROM queue ORDER BY position ASC, id ASC"
                )
                return self._json(self._rows(cur))
        if path == "/api/state":
            with state_lock:
                return self._json(dict(remote_state))
        if path in ("/", "/index.html"):
            return self._serve("index.html")
        if path.startswith("/static/"):
            return self._serve(path[len("/static/"):])
        return self._err(404, "not found")

    # ---- POST --------------------------------------------------------
    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        body = self._body()

        if path == "/api/bookmarks":
            vid = (body.get("videoId") or "").strip()
            if not vid:
                return self._err(400, "missing videoId")
            with db_lock:
                CON.execute(
                    "INSERT OR IGNORE INTO bookmarks(video_id,title,channel,thumb,created_at)"
                    " VALUES(?,?,?,?,?)",
                    (vid, body.get("title", ""), body.get("channel", ""),
                     body.get("thumb", ""), time.time()),
                )
                CON.commit()
                cur = CON.execute("SELECT * FROM bookmarks WHERE video_id=?", (vid,))
                return self._json(dict(cur.fetchone()))
        if path == "/api/queue":
            vid = (body.get("videoId") or "").strip()
            if not vid:
                return self._err(400, "missing videoId")
            with db_lock:
                cur = CON.execute("SELECT COALESCE(MAX(position),-1)+1 FROM queue")
                pos = cur.fetchone()[0]
                cur = CON.execute(
                    "INSERT INTO queue(video_id,title,channel,thumb,singer,position,status,created_at)"
                    " VALUES(?,?,?,?,?,?,?,?)",
                    (vid, body.get("title", ""), body.get("channel", ""),
                     body.get("thumb", ""), (body.get("singer") or "").strip(),
                     pos, "queued", time.time()),
                )
                CON.commit()
                row = CON.execute("SELECT * FROM queue WHERE id=?",
                                  (cur.lastrowid,)).fetchone()
                return self._json(dict(row), 201)
        if path == "/api/queue/clear_played":
            with db_lock:
                CON.execute("DELETE FROM queue WHERE status IN ('played','skipped','unplayable')")
                CON.commit()
                self._renumber()
                return self._json({"ok": True})
        if path == "/api/state":
            cmd = body.get("cmd")
            if cmd not in ("playpause", "next", "restart", "play_id"):
                return self._err(400, "unknown cmd")
            with state_lock:
                remote_state["seq"] += 1
                remote_state["cmd"] = cmd
                remote_state["arg"] = body.get("arg")
                return self._json(dict(remote_state))
        return self._err(404, "not found")

    def _renumber(self):
        cur = CON.execute("SELECT id FROM queue ORDER BY position ASC, id ASC")
        for i, r in enumerate(cur.fetchall()):
            CON.execute("UPDATE queue SET position=? WHERE id=?", (i, r["id"]))
        CON.commit()

    # ---- PATCH -------------------------------------------------------
    def do_PATCH(self):
        parsed = urllib.parse.urlparse(self.path)
        m = re.match(r"^/api/queue/(\d+)$", parsed.path)
        if not m:
            return self._err(404, "not found")
        qid = int(m.group(1))
        body = self._body()
        with db_lock:
            row = CON.execute("SELECT * FROM queue WHERE id=?", (qid,)).fetchone()
            if not row:
                return self._err(404, "no such queue item")
            if "singer" in body:
                CON.execute("UPDATE queue SET singer=? WHERE id=?",
                            (str(body["singer"]).strip()[:60], qid))
            if "status" in body and body["status"] in (
                    "queued", "playing", "played", "skipped", "unplayable"):
                if body["status"] == "playing":
                    CON.execute("UPDATE queue SET status='queued' WHERE status='playing'")
                CON.execute("UPDATE queue SET status=? WHERE id=?",
                            (body["status"], qid))
            if body.get("move") in ("up", "down"):
                delta = -1 if body["move"] == "up" else 1
                other = CON.execute(
                    "SELECT id, position FROM queue WHERE "
                    + ("position < ? ORDER BY position DESC, id DESC"
                       if delta < 0 else "position > ? ORDER BY position ASC, id ASC"),
                    (row["position"],)).fetchone()
                if other:
                    CON.execute("UPDATE queue SET position=? WHERE id=?",
                                (other["position"], qid))
                    CON.execute("UPDATE queue SET position=? WHERE id=?",
                                (row["position"], other["id"]))
            CON.commit()
            upd = CON.execute("SELECT * FROM queue WHERE id=?", (qid,)).fetchone()
            return self._json(dict(upd))

    # ---- DELETE ------------------------------------------------------
    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        m = re.match(r"^/api/(bookmarks|queue)/(\d+)$", parsed.path)
        if not m:
            return self._err(404, "not found")
        table, rid = m.group(1), int(m.group(2))
        with db_lock:
            CON.execute("DELETE FROM %s WHERE id=?" % table, (rid,))
            if table == "queue":
                self._renumber()
            else:
                CON.commit()
            return self._json({"ok": True})

    def log_message(self, fmt, *args):  # quieter logs
        pass


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("ytk-v2 listening on 127.0.0.1:%d" % PORT, flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
