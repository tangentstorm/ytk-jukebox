/* YTK v2 — plain web components. No framework, no build step. */
"use strict";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
  return data;
}
const GET = (p) => api("GET", p);
const POST = (p, b) => api("POST", p, b);
const PATCH = (p, b) => api("PATCH", p, b);
const DEL = (p) => api("DELETE", p);

function toast(msg, ms = 3200) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/* ---------------- shell / router ---------------- */
class YtkApp extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
      <nav class="nav">
        <span class="brand">YTK</span>
        <a href="#/search" data-r="search">Search</a>
        <a href="#/saved" data-r="saved">Saved</a>
        <a href="#/queue" data-r="queue">Queue</a>
        <a href="#/player" data-r="player">Player</a>
      </nav>
      <main id="view"></main>`;
    this.view = this.querySelector("#view");
    this.links = [...this.querySelectorAll("nav a")];
    window.addEventListener("hashchange", () => this.route());
    this.route();
  }
  route() {
    const r = (location.hash || "#/search").replace("#/", "") || "search";
    const name = ["search", "saved", "queue", "player"].includes(r) ? r : "search";
    this.links.forEach((a) => a.classList.toggle("active", a.dataset.r === name));
    this.view.innerHTML = `<ytk-${name}></ytk-${name}>`;
    window.scrollTo(0, 0);
  }
}
customElements.define("ytk-app", YtkApp);

/* ---------------- song card (search + saved) ---------------- */
function songCard(item, opts = {}) {
  const el = document.createElement("div");
  el.className = "card";
  el.innerHTML = `
    <img class="thumb" loading="lazy" src="${esc(item.thumb)}" alt="">
    <div class="meta">
      <div class="title">${esc(item.title)}</div>
      <div class="channel">${esc(item.channel)}</div>
      <div class="row">
        ${opts.bookmarkBtn ? `<button class="small bm">${opts.bookmarked ? "★ Saved" : "☆ Save"}</button>` : ""}
        <button class="small primary q">+ Queue</button>
        ${opts.unbookmark ? `<button class="small ghost rm">Remove</button>` : ""}
      </div>
      <div class="singer-input" hidden>
        <input placeholder="Singer name (optional)" maxlength="60">
        <button class="small primary go">Add</button>
      </div>
    </div>`;
  const singerBox = el.querySelector(".singer-input");
  const singerInput = el.querySelector(".singer-input input");
  if (opts.bookmarkBtn) {
    el.querySelector(".bm").onclick = async (e) => {
      const btn = e.currentTarget;
      try {
        if (opts.bookmarked) {
          await DEL(`/api/bookmarks/${item.bmId}`);
          toast("Removed from saved");
        } else {
          await POST("/api/bookmarks", item);
          toast("Saved ★");
        }
        opts.onBookmarkChange && opts.onBookmarkChange();
      } catch (err) { toast("Error: " + err.message); }
    };
  }
  el.querySelector(".q").onclick = () => {
    singerBox.hidden = !singerBox.hidden;
    if (!singerBox.hidden) singerInput.focus();
  };
  const add = async () => {
    try {
      await POST("/api/queue", { ...item, singer: singerInput.value.trim() });
      toast(`Queued${singerInput.value.trim() ? " for " + singerInput.value.trim() : ""} 🎤`);
      singerBox.hidden = true;
      singerInput.value = "";
    } catch (err) { toast("Error: " + err.message); }
  };
  el.querySelector(".go").onclick = add;
  singerInput.addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
  if (opts.unbookmark) {
    el.querySelector(".rm").onclick = async () => {
      try { await DEL(`/api/bookmarks/${item.bmId}`); toast("Removed"); opts.onBookmarkChange && opts.onBookmarkChange(); }
      catch (err) { toast("Error: " + err.message); }
    };
  }
  return el;
}

/* ---------------- search ---------------- */
class YtkSearch extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
      <h2>Find a karaoke track</h2>
      <div class="searchbar">
        <input type="search" id="q" placeholder="song title + artist…" autocomplete="off">
        <button class="primary" id="go">Search</button>
      </div>
      <label class="toggle"><input type="checkbox" id="kara" checked> append “karaoke” to the search</label>
      <div class="grid" id="results"></div>
      <div class="empty" id="empty">Search YouTube for your song. ☆ saves it, + queues it for tonight.</div>`;
    this.q = this.querySelector("#q");
    this.results = this.querySelector("#results");
    this.empty = this.querySelector("#empty");
    this.querySelector("#go").onclick = () => this.search();
    this.q.addEventListener("keydown", (e) => { if (e.key === "Enter") this.search(); });
    this.q.focus();
  }
  async search() {
    const q = this.q.value.trim();
    if (!q) return;
    const kara = this.querySelector("#kara").checked;
    const query = kara && !/karaoke/i.test(q) ? q + " karaoke" : q;
    this.results.innerHTML = "";
    this.empty.textContent = "Searching…";
    this.empty.style.display = "";
    try {
      const [items, saved] = await Promise.all([
        GET("/api/search?" + new URLSearchParams({ q: query, max: 12 })),
        GET("/api/bookmarks"),
      ]);
      const savedIds = new Set(saved.map((b) => b.videoId));
      this.empty.style.display = items.length ? "none" : "";
      if (!items.length) this.empty.textContent = "No results. Try different words.";
      for (const it of items) {
        this.results.appendChild(songCard(it, {
          bookmarkBtn: true,
          bookmarked: savedIds.has(it.videoId),
          bmId: (saved.find((b) => b.videoId === it.videoId) || {}).id,
          onBookmarkChange: () => this.search(),
        }));
      }
    } catch (err) {
      this.empty.textContent = "Search failed: " + err.message;
    }
  }
}
customElements.define("ytk-search", YtkSearch);

/* ---------------- saved ---------------- */
class YtkSaved extends HTMLElement {
  async connectedCallback() { await this.load(); }
  async load() {
    this.innerHTML = `<h2>Saved songs <span class="count" id="c"></span></h2>
      <div class="grid" id="g"></div><div class="empty" id="e" hidden>No saved songs yet — ☆ songs from Search.</div>`;
    try {
      const items = await GET("/api/bookmarks");
      this.querySelector("#c").textContent = `(${items.length})`;
      const g = this.querySelector("#g");
      this.querySelector("#e").hidden = items.length > 0;
      for (const it of items) {
        g.appendChild(songCard({ videoId: it.videoId, title: it.title, channel: it.channel, thumb: it.thumb, bmId: it.id },
          { unbookmark: true, onBookmarkChange: () => this.load() }));
      }
    } catch (err) {
      this.querySelector("#e").hidden = false;
      this.querySelector("#e").textContent = "Failed to load: " + err.message;
    }
  }
}
customElements.define("ytk-saved", YtkSaved);

/* ---------------- queue (KJ console) ---------------- */
class YtkQueue extends HTMLElement {
  async connectedCallback() {
    this.innerHTML = `
      <h2>Karaoke queue <span class="count" id="c"></span></h2>
      <div class="nowbar" id="nowbar" hidden>
        <span class="label">NOW</span><span class="who" id="nowwho"></span>
        <span class="label">controls the player →</span>
      </div>
      <div class="toolbar" id="tools">
        <button class="small" id="t-play">⏯ Play/Pause</button>
        <button class="small" id="t-next">⏭ Next</button>
        <button class="small" id="t-restart">↺ Restart</button>
        <span class="spacer"></span>
        <button class="small ghost" id="t-clear">Clear played</button>
      </div>
      <div id="list"></div>`;
    this.list = this.querySelector("#list");
    this.querySelector("#t-play").onclick = () => this.cmd("playpause");
    this.querySelector("#t-next").onclick = () => this.cmd("next");
    this.querySelector("#t-restart").onclick = () => this.cmd("restart");
    this.querySelector("#t-clear").onclick = async () => {
      await POST("/api/queue/clear_played");
      this.load();
    };
    await this.load();
  }
  async cmd(c, arg) {
    try { await POST("/api/state", { cmd: c, arg: arg || null }); }
    catch (err) { toast("Error: " + err.message); }
  }
  async load() {
    try {
      const items = await GET("/api/queue");
      this.querySelector("#c").textContent = `(${items.filter((i) => i.status === "queued" || i.status === "playing").length} up)`;
      const now = items.find((i) => i.status === "playing");
      const nb = this.querySelector("#nowbar");
      nb.hidden = !now;
      if (now) this.querySelector("#nowwho").textContent = `🎤 ${now.singer || "—"} — ${now.title}`;
      this.list.innerHTML = "";
      if (!items.length) {
        this.list.innerHTML = `<div class="empty">Queue is empty. Find songs in Search and + Queue them.</div>`;
        return;
      }
      items.forEach((it, idx) => {
        const el = document.createElement("div");
        el.className = "qitem " + (it.status === "playing" ? "playing" : it.status === "played" ? "played" : "");
        const badge = it.status === "playing" ? `<span class="badge playing">playing</span>`
          : it.status === "played" ? `<span class="badge played">played</span>`
          : it.status === "unplayable" ? `<span class="badge unplayable">unplayable</span>` : "";
        el.innerHTML = `
          <div class="pos">${idx + 1}</div>
          <img loading="lazy" src="${esc(it.thumb)}" alt="">
          <div class="info">
            <div class="title">${esc(it.title)}${badge}</div>
            <div class="singer">🎤 <input value="${esc(it.singer)}" placeholder="singer name" maxlength="60" aria-label="singer"></div>
          </div>
          <div class="ctl">
            <button class="small" data-a="up" ${idx === 0 ? "disabled" : ""}>↑</button>
            <button class="small" data-a="down" ${idx === items.length - 1 ? "disabled" : ""}>↓</button>
            <button class="small primary" data-a="playnow">▶</button>
            <button class="small" data-a="done">✓</button>
            <button class="small ghost" data-a="rm">✕</button>
          </div>`;
        const singerInput = el.querySelector(".singer input");
        let deb = null;
        singerInput.addEventListener("input", () => {
          clearTimeout(deb);
          deb = setTimeout(() => PATCH(`/api/queue/${it.id}`, { singer: singerInput.value.trim() }).catch(() => {}), 600);
        });
        el.querySelectorAll("button").forEach((b) => {
          b.onclick = async () => {
            const a = b.dataset.a;
            try {
              if (a === "up" || a === "down") await PATCH(`/api/queue/${it.id}`, { move: a });
              else if (a === "rm") await DEL(`/api/queue/${it.id}`);
              else if (a === "done") await PATCH(`/api/queue/${it.id}`, { status: "played" });
              else if (a === "playnow") {
                await PATCH(`/api/queue/${it.id}`, { status: "playing" });
                await this.cmd("play_id", { id: it.id, videoId: it.video_id });
              }
              this.load();
            } catch (err) { toast("Error: " + err.message); }
          };
        });
        this.list.appendChild(el);
      });
    } catch (err) {
      this.list.innerHTML = `<div class="empty">Failed to load queue: ${esc(err.message)}</div>`;
    }
  }
}
customElements.define("ytk-queue", YtkQueue);

/* ---------------- player ---------------- */
class YtkPlayer extends HTMLElement {
  connectedCallback() {
    this.lastSeq = 0;
    this.queue = [];
    this.idx = -1;
    this.yt = null;
    this.ytReady = false;
    this.innerHTML = `
      <div class="player-wrap" id="wrap">
        <div id="ytplayer"></div>
        <div class="singer-banner">
          <div class="now" id="banner-now">🎤 —</div>
          <div class="next" id="banner-next"></div>
        </div>
      </div>
      <div class="player-ctl">
        <button class="small" id="p-play">⏯ Play/Pause</button>
        <button class="small" id="p-next">⏭ Next</button>
        <button class="small" id="p-restart">↺ Restart</button>
        <span class="spacer"></span>
        <button class="small" id="p-fs">⛶ Fullscreen</button>
      </div>
      <div class="upnext"><h2>Up next</h2><div id="upnext"></div></div>`;
    this.wrap = this.querySelector("#wrap");
    this.querySelector("#p-play").onclick = () => this.togglePlay();
    this.querySelector("#p-next").onclick = () => this.advance(true);
    this.querySelector("#p-restart").onclick = () => this.restart();
    this.querySelector("#p-fs").onclick = () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else this.wrap.requestFullscreen && this.wrap.requestFullscreen();
    };
    this.boot();
  }

  async boot() {
    // Recover stale "playing" rows (e.g. tab closed mid-song).
    try {
      const q = await GET("/api/queue");
      await Promise.all(q.filter((i) => i.status === "playing")
        .map((i) => PATCH(`/api/queue/${i.id}`, { status: "queued" })));
      this.queue = await GET("/api/queue");
    } catch (err) { toast("Queue load failed: " + err.message); return; }
    this.waitForYT(() => this.start());
    this.poller = setInterval(() => this.poll(), 2000);
    this.addEventListener("disconnect", () => clearInterval(this.poller));
  }
  disconnectedCallback() { clearInterval(this.poller); }

  waitForYT(cb) {
    if (window.YT && YT.Player) { this.ytReady = true; cb(); return; }
    let tries = 0;
    const t = setInterval(() => {
      if (window.YT && YT.Player) { clearInterval(t); this.ytReady = true; cb(); }
      else if (++tries > 50) { clearInterval(t); toast("YouTube player API failed to load. Check network."); }
    }, 200);
  }

  activeItems() {
    return this.queue.filter((i) => i.status === "queued" || i.status === "playing");
  }

  start() {
    const items = this.activeItems();
    if (!items.length) {
      this.querySelector("#banner-now").innerHTML = "🎤 —";
      this.querySelector("#banner-next").textContent = "Queue is empty — add songs from Search.";
      this.renderUpNext();
      return;
    }
    this.idx = 0;
    this.playIdx(this.idx);
  }

  makePlayer(videoId) {
    if (this.yt) { this.yt.destroy(); this.yt = null; }
    this.yt = new YT.Player("ytplayer", {
      videoId,
      playerVars: { autoplay: 1, rel: 0, modestbranding: 1 },
      events: {
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.ENDED) this.advance(false);
        },
        onError: (e) => this.onYtError(e),
      },
    });
  }

  async playIdx(i) {
    const items = this.activeItems();
    if (i < 0 || i >= items.length) {
      this.idx = -1;
      this.querySelector("#banner-now").innerHTML = "🎤 —";
      this.querySelector("#banner-next").textContent = "That's everything! 🎉";
      this.renderUpNext();
      if (this.yt) { this.yt.stopVideo(); }
      return;
    }
    this.idx = i;
    const it = items[i];
    // mark playing (and clear any other playing flags)
    try {
      await PATCH(`/api/queue/${it.id}`, { status: "playing" });
      this.queue = await GET("/api/queue");
    } catch (err) { /* keep going */ }
    this.makePlayer(it.video_id);
    this.renderBanner();
    this.renderUpNext();
  }

  renderBanner() {
    const items = this.activeItems();
    const cur = items[this.idx];
    const nxt = items[this.idx + 1];
    this.querySelector("#banner-now").innerHTML =
      `<span class="mic">🎤</span>${esc(cur ? (cur.singer || "—") : "—")}`;
    this.querySelector("#banner-next").textContent =
      cur ? `Now: ${cur.title}` + (nxt ? `   •   Next: ${nxt.singer || "—"} — ${nxt.title}` : "   •   (last song)")
           : "";
  }

  renderUpNext() {
    const box = this.querySelector("#upnext");
    box.innerHTML = "";
    const items = this.activeItems().slice(this.idx + 1, this.idx + 6);
    if (!items.length) { box.innerHTML = `<div class="empty">Nothing after this.</div>`; return; }
    for (const it of items) {
      const el = document.createElement("div");
      el.className = "qitem";
      el.innerHTML = `<div class="pos">•</div>
        <img loading="lazy" src="${esc(it.thumb)}" alt="">
        <div class="info"><div class="title">${esc(it.title)}</div>
        <div class="singer">🎤 ${esc(it.singer || "—")}</div></div>`;
      box.appendChild(el);
    }
  }

  async advance(manual) {
    const items = this.activeItems();
    const cur = items[this.idx];
    if (cur) {
      try {
        await PATCH(`/api/queue/${cur.id}`, { status: manual ? "skipped" : "played" });
        this.queue = await GET("/api/queue");
      } catch (err) { /* keep going */ }
    }
    // Marking cur removes it from the active list, so the next song
    // slides into this.idx. playIdx(len) renders the "that's everything" state.
    this.playIdx(Math.min(this.idx, this.activeItems().length));
  }

  onYtError(e) {
    // 101/150 = embedding disabled, 100 = not found, 5 = HTML5 error
    const items = this.activeItems();
    const cur = items[this.idx];
    const label = { 2: "bad video id", 5: "player error", 100: "not found", 101: "embedding blocked", 150: "embedding blocked" }[e.data]
      || ("error " + e.data);
    toast(`⏭ Skipping “${cur ? cur.title : "video"}” — ${label}.`);
    if (cur) PATCH(`/api/queue/${cur.id}`, { status: "unplayable" }).catch(() => {});
    // drop it from the local list and continue
    this.queue = this.queue.filter((i) => !(cur && i.id === cur.id));
    this.playIdx(this.idx); // same index now points at the next item
  }

  togglePlay() {
    if (!this.yt || !this.yt.getPlayerState) return;
    const s = this.yt.getPlayerState();
    if (s === YT.PlayerState.PLAYING) this.yt.pauseVideo();
    else this.yt.playVideo();
  }
  restart() { if (this.yt && this.yt.seekTo) { this.yt.seekTo(0, true); this.yt.playVideo(); } }

  async poll() {
    try {
      const st = await GET("/api/state");
      if (!st || st.seq <= this.lastSeq) return;
      this.lastSeq = st.seq;
      const cmd = st.cmd, arg = st.arg;
      if (cmd === "playpause") this.togglePlay();
      else if (cmd === "next") this.advance(true);
      else if (cmd === "restart") this.restart();
      else if (cmd === "play_id" && arg) {
        this.queue = await GET("/api/queue");
        const items = this.activeItems();
        const i = items.findIndex((x) => x.id === arg.id);
        if (i >= 0) this.playIdx(i);
      }
    } catch (err) { /* poll failures are non-fatal */ }
  }
}
customElements.define("ytk-player", YtkPlayer);
