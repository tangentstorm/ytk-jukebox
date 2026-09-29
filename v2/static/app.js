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

/* ---------------- voice recorder helpers ----------------
   Honest limitation: getUserMedia/MediaRecorder captures the MICROPHONE
   ONLY. The YouTube backing track plays in a cross-origin iframe whose
   audio the page cannot capture, so recordings are VOCALS-ONLY. The UI
   labels them exactly that way. */
// The most recent voice clip, kept here (not on the player element) so it
// survives tab switches: leaving the Player mid-recording stops the mic
// gracefully but the finished clip stays available when you come back.
const recStore = { clip: null }; // {url, title, mime, ext} | null

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
}

function recFilename(title, ext) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  const safe = String(title || "karaoke").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "karaoke";
  return `${safe}-vocals-${stamp}.${ext}`;
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
    this.currentTab = null;
    // Tab switches go through the history stack so the Android/browser
    // back button walks back through tabs instead of leaving the app.
    this.links.forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault();
      this.go(a.dataset.r, true);
    }));
    window.addEventListener("popstate", (e) => {
      const tab = (e.state && e.state.tab) || this.tabFromHash();
      this.go(tab, false);
    });
    // Fallback for hash changes not made through go() (e.g. address bar).
    // popstate runs first on back/forward and sets currentTab, so this is a
    // no-op there — no double routing.
    window.addEventListener("hashchange", () => {
      const tab = this.tabFromHash();
      if (tab !== this.currentTab) this.go(tab, false);
    });
    // Seed the first entry: back from here exits the app — no history trap.
    const tab = this.tabFromHash();
    history.replaceState({ tab }, "", "#/" + tab);
    this.go(tab, false);
    // Programmatic navigation (e.g. ▶ Play jumping to the Player) so the
    // back button undoes it naturally.
    window.ytkNav = (t) => this.go(t, true);
  }
  tabFromHash() {
    const r = (location.hash || "#/search").replace("#/", "") || "search";
    return ["search", "saved", "queue", "player"].includes(r) ? r : "search";
  }
  go(tab, push) {
    const name = ["search", "saved", "queue", "player"].includes(tab) ? tab : "search";
    if (push) {
      // pushState never fires hashchange, so no double routing.
      if (!history.state || history.state.tab !== name) {
        history.pushState({ tab: name }, "", "#/" + name);
      }
    }
    this.currentTab = name;
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
        <button class="small play">▶ Play</button>
        ${opts.unbookmark ? `<button class="small ghost rm">Remove</button>` : ""}
      </div>
      <div class="singer-input">
        <input placeholder="Singer name (optional)" maxlength="60" aria-label="Singer name (optional)">
      </div>
    </div>`;
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
  const queueIt = async () => {
    try {
      const singer = singerInput.value.trim();
      await POST("/api/queue", { ...item, singer });
      toast(singer ? `Queued for ${singer} 🎤` : "Queued 🎤");
      singerInput.value = "";
    } catch (err) { toast("Error: " + err.message); }
  };
  el.querySelector(".q").onclick = queueIt;
  singerInput.addEventListener("keydown", (e) => { if (e.key === "Enter") queueIt(); });
  el.querySelector(".play").onclick = async () => {
    try {
      await POST("/api/state", { cmd: "play_direct", arg: { videoId: item.videoId, title: item.title } });
      toast("▶ Playing now — one-off, queue untouched");
      if (window.ytkNav) window.ytkNav("player");
      else location.hash = "#/player";
    } catch (err) { toast("Error: " + err.message); }
  };
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
        <button id="mic" title="Voice search" aria-label="Voice search" hidden>🎤</button>
        <button class="primary" id="go">Search</button>
      </div>
      <div class="mic-hint" id="michint" hidden>🎤 Listening… speak the song name</div>
      <label class="toggle"><input type="checkbox" id="kara" checked> append “karaoke” to the search</label>
      <div class="grid" id="results"></div>
      <div class="empty" id="empty">Search YouTube for your song. ☆ saves it, + queues it for tonight, ▶ plays it right now.</div>`;
    this.q = this.querySelector("#q");
    this.results = this.querySelector("#results");
    this.empty = this.querySelector("#empty");
    this.querySelector("#go").onclick = () => this.search();
    this.q.addEventListener("keydown", (e) => { if (e.key === "Enter") this.search(); });
    this.setupVoice();
    this.q.focus();
  }

  setupVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const btn = this.querySelector("#mic");
    const hint = this.querySelector("#michint");
    if (!SR) return; // mic button stays hidden where the API is unavailable
    btn.hidden = false;
    let rec = null;
    const setListening = (on) => {
      btn.classList.toggle("listening", on);
      hint.hidden = !on;
    };
    btn.onclick = () => {
      if (rec) { try { rec.stop(); } catch (_) {} return; } // tap again cancels
      rec = new SR();
      rec.lang = navigator.language || "en-US";
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      rec.onresult = (e) => {
        let text = "";
        for (const r of e.results) text += r[0].transcript;
        this.q.value = text;
        if (e.results[e.results.length - 1].isFinal) {
          const finalText = text.trim();
          rec = null;
          setListening(false);
          if (finalText) { this.q.value = finalText; this.search(); }
        }
      };
      rec.onerror = (e) => {
        rec = null;
        setListening(false);
        const k = e.error;
        if (k === "aborted") return; // user cancelled via tap — stay silent
        if (k === "not-allowed" || k === "service-not-allowed")
          toast("Microphone permission denied — allow mic access to use voice search.");
        else if (k === "no-speech") toast("Didn't catch that — try again.");
        else if (k === "audio-capture") toast("No microphone found on this device.");
        else toast("Voice search isn't available right now — try typing instead.");
      };
      rec.onend = () => { rec = null; setListening(false); };
      try { rec.start(); setListening(true); }
      catch (err) { rec = null; setListening(false); toast("Voice search couldn't start — try typing instead."); }
    };
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
      const savedIds = new Set(saved.map((b) => b.video_id));
      this.empty.style.display = items.length ? "none" : "";
      if (!items.length) this.empty.textContent = "No results. Try different words.";
      for (const it of items) {
        this.results.appendChild(songCard(it, {
          bookmarkBtn: true,
          bookmarked: savedIds.has(it.videoId),
          bmId: (saved.find((b) => b.video_id === it.videoId) || {}).id,
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
        g.appendChild(songCard({ videoId: it.video_id, title: it.title, channel: it.channel, thumb: it.thumb, bmId: it.id },
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
    this.direct = null; // one-off direct play: {videoId, title} | null
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
        <button class="small bm" id="p-save" hidden>☆ Save</button>
        <button class="small" id="p-rec" title="Record your voice (mic only — vocals only)">● Rec</button>
        <span class="spacer"></span>
        <button class="small" id="p-fs">⛶ Fullscreen</button>
      </div>
      <div class="rec-panel" id="rec-panel" hidden></div>
      <div class="upnext"><h2>Up next</h2><div id="upnext"></div></div>`;
    this.wrap = this.querySelector("#wrap");
    this.saveBtn = this.querySelector("#p-save");
    this.savedBmId = null;   // bookmark id of the current track, if saved
    this.saveSeq = 0;        // guards refreshSaveBtn against track-change races
    this.savePending = null;
    this.querySelector("#p-play").onclick = () => this.togglePlay();
    this.querySelector("#p-next").onclick = () => this.advance(true);
    this.querySelector("#p-restart").onclick = () => this.restart();
    this.saveBtn.onclick = () => this.toggleSave();
    this.recBtn = this.querySelector("#p-rec");
    this.recBtn.onclick = () => this.toggleRec();
    this.recState = null; // active recording: {recorder, stream, chunks, mime, startedAt, timer, done}
    this.querySelector("#p-fs").onclick = () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else this.wrap.requestFullscreen && this.wrap.requestFullscreen();
    };
    this.renderRecPanel(); // show a kept clip from an earlier visit, if any
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
  disconnectedCallback() {
    clearInterval(this.poller);
    // Navigating away mid-recording: stop gracefully so the mic is released
    // and the finished clip is kept in recStore (it re-renders on return).
    if (this.recState) this.stopRec();
  }

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
      this.refreshSaveBtn();
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
          if (e.data === YT.PlayerState.ENDED) {
            if (this.direct) this.resumeQueue();
            else this.advance(false);
          }
        },
        onError: (e) => this.onYtError(e),
      },
    });
  }

  /* One-off direct play: takes over the player without touching the queue. */
  playDirect(arg) {
    this.direct = { videoId: arg.videoId, title: arg.title || "Untitled" };
    this.idx = -1;
    this.makePlayer(this.direct.videoId);
    this.renderBanner();
    this.renderUpNext();
    this.refreshSaveBtn();
  }

  async resumeQueue() {
    // A direct play ended or was skipped: the queue continues intact.
    this.direct = null;
    try { this.queue = await GET("/api/queue"); } catch (err) { /* keep going */ }
    const items = this.activeItems();
    if (!items.length) {
      this.idx = -1;
      this.querySelector("#banner-now").innerHTML = "🎤 —";
      this.querySelector("#banner-next").textContent = "That's everything! 🎉";
      this.renderUpNext();
      this.refreshSaveBtn();
      if (this.yt) { this.yt.stopVideo(); }
      return;
    }
    this.playIdx(0);
  }

  async playIdx(i) {
    this.direct = null; // queue flow always exits direct mode
    const items = this.activeItems();
    if (i < 0 || i >= items.length) {
      this.idx = -1;
      this.querySelector("#banner-now").innerHTML = "🎤 —";
      this.querySelector("#banner-next").textContent = "That's everything! 🎉";
      this.renderUpNext();
      this.refreshSaveBtn();
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
    this.refreshSaveBtn();
  }

  /* The track on screen right now — from the queue, or a one-off direct play. */
  currentTrack() {
    if (this.direct) {
      return { videoId: this.direct.videoId, title: this.direct.title, channel: "", thumb: "" };
    }
    const items = this.activeItems();
    const cur = items[this.idx];
    return cur
      ? { videoId: cur.video_id, title: cur.title, channel: cur.channel, thumb: cur.thumb }
      : null;
  }

  /* Sync the ☆/★ button with the saved list for the current track.
     Hidden when nothing is playing. Never touches queue or playback. */
  refreshSaveBtn() {
    const t = this.currentTrack();
    if (!t) {
      this.saveBtn.hidden = true;
      this.savedBmId = null;
      return Promise.resolve();
    }
    this.saveBtn.hidden = false;
    const seq = ++this.saveSeq;
    this.savePending = (async () => {
      const saved = await GET("/api/bookmarks");
      if (seq !== this.saveSeq) return; // a newer track already took over
      const hit = saved.find((b) => b.video_id === t.videoId);
      this.savedBmId = hit ? hit.id : null;
      this.saveBtn.textContent = hit ? "★ Saved" : "☆ Save";
    })().catch(() => {});
    return this.savePending;
  }

  async toggleSave() {
    const t = this.currentTrack();
    if (!t) return;
    if (this.savePending) { try { await this.savePending; } catch (e) { /* fall through */ } }
    try {
      if (this.savedBmId) {
        await DEL(`/api/bookmarks/${this.savedBmId}`);
        this.savedBmId = null;
        this.saveBtn.textContent = "☆ Save";
        toast("Removed from saved");
      } else {
        const row = await POST("/api/bookmarks", t);
        this.savedBmId = row.id;
        this.saveBtn.textContent = "★ Saved";
        toast("Saved ★");
      }
    } catch (err) { toast("Error: " + err.message); }
  }

  renderBanner() {
    if (this.direct) {
      this.querySelector("#banner-now").innerHTML = `<span class="mic">🎤</span>—`;
      this.querySelector("#banner-next").textContent =
        `Now: ${this.direct.title} (one-off — queue paused)`;
      return;
    }
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
    if (this.direct) { this.resumeQueue(); return; } // ⏭ during a one-off → back to the queue
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
    const label = { 2: "bad video id", 5: "player error", 100: "not found", 101: "embedding blocked", 150: "embedding blocked" }[e.data]
      || ("error " + e.data);
    if (this.direct) {
      toast(`⏭ Skipping "${this.direct.title}" — ${label}.`);
      this.resumeQueue();
      return;
    }
    const items = this.activeItems();
    const cur = items[this.idx];
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

  /* ---------------- voice recorder (mic only — vocals only) ---------------- */
  pickRecMime() {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported) {
      for (const c of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
        try { if (MediaRecorder.isTypeSupported(c)) return c; } catch (e) { /* try next */ }
      }
    }
    return "";
  }
  recExt(mime) { return /mp4/i.test(mime || "") ? "m4a" : "webm"; }

  toggleRec() {
    if (this.recState) this.stopRec();
    else this.startRec();
  }

  async startRec() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast("Voice recording isn't available here — this browser exposes no microphone.");
      return;
    }
    if (!window.MediaRecorder) {
      toast("Voice recording isn't supported in this browser.");
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const name = (err && err.name) || "";
      toast(name === "NotAllowedError" || name === "SecurityError"
        ? "Microphone permission denied — allow mic access to record your voice."
        : "Couldn't open the microphone" + (name ? ` (${name})` : "") + ".");
      return;
    }
    const mime = this.pickRecMime();
    const st = { stream, chunks: [], mime, startedAt: Date.now(), timer: null, done: false, recorder: null };
    try {
      st.recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch (err) {
      stream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} });
      toast("Couldn't start the recorder (" + err.message + ").");
      return;
    }
    st.recorder.ondataavailable = (e) => { if (e.data && e.data.size) st.chunks.push(e.data); };
    st.recorder.onstop = () => this.finishRec(st);
    try {
      st.recorder.start(500);
    } catch (err) {
      stream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} });
      toast("Couldn't start the recorder (" + err.message + ").");
      return;
    }
    this.recState = st;
    this.recBtn.textContent = "⏹ Stop";
    this.recBtn.classList.add("recording");
    this.renderRecRecording();
    st.timer = setInterval(() => this.tickRecTimer(), 500);
    this.tickRecTimer();
    // Note: YouTube playback is untouched — the mic records independently.
  }

  tickRecTimer() {
    const el = this.querySelector("#rec-timer");
    if (el && this.recState) el.textContent = fmtElapsed(Date.now() - this.recState.startedAt);
  }

  stopRec() {
    const st = this.recState;
    if (!st) return;
    this.recState = null;
    clearInterval(st.timer);
    this.recBtn.textContent = "● Rec";
    this.recBtn.classList.remove("recording");
    if (st.recorder && st.recorder.state !== "inactive") {
      try { st.recorder.stop(); return; } catch (e) { /* fall through to finish */ }
    }
    this.finishRec(st);
  }

  finishRec(st) {
    if (!st || st.done) return;
    st.done = true;
    try { st.stream.getTracks().forEach((t) => t.stop()); } catch (e) {} // release the mic
    const type = st.mime || "audio/webm";
    const blob = new Blob(st.chunks, { type });
    if (!blob.size) {
      toast("Recording came out empty — nothing saved.");
      this.renderRecPanel();
      return;
    }
    if (recStore.clip) { try { URL.revokeObjectURL(recStore.clip.url); } catch (e) {} }
    const t = this.currentTrack();
    recStore.clip = {
      url: URL.createObjectURL(blob),
      title: t ? t.title : "karaoke",
      mime: type,
      ext: this.recExt(type),
    };
    this.renderRecPanel();
    toast("Voice clip ready — vocals only 🎙");
  }

  clearClip() {
    if (recStore.clip) { try { URL.revokeObjectURL(recStore.clip.url); } catch (e) {} }
    recStore.clip = null;
    this.renderRecPanel();
  }

  renderRecRecording() {
    const panel = this.querySelector("#rec-panel");
    if (!panel) return;
    panel.hidden = false;
    panel.innerHTML = `
      <div class="rec-status"><span class="rec-dot"></span><span>● REC</span><span class="rec-timer" id="rec-timer">00:00</span></div>
      <div class="rec-note">Voice recording — <b>vocals only</b>. The backing track keeps playing; only your mic is captured.</div>`;
  }

  renderRecPanel() {
    const panel = this.querySelector("#rec-panel");
    if (!panel || !this.isConnected) return;
    const clip = recStore.clip;
    if (!clip) { panel.hidden = true; panel.innerHTML = ""; return; }
    panel.hidden = false;
    const fname = recFilename(clip.title, clip.ext);
    panel.innerHTML = `
      <div class="rec-status"><span class="rec-dot done"></span><span>Voice clip — vocals only</span></div>
      <div class="rec-note">Mic recording only — the YouTube backing track can't be captured.</div>
      <audio controls src="${clip.url}"></audio>
      <div class="rec-actions">
        <a class="btn small" href="${clip.url}" download="${esc(fname)}">⬇ Download</a>
        <button class="small ghost" id="rec-discard">Discard</button>
      </div>`;
    panel.querySelector("#rec-discard").onclick = () => this.clearClip();
  }

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
      else if (cmd === "play_direct" && arg && arg.videoId) this.playDirect(arg);
    } catch (err) { /* poll failures are non-fatal */ }
  }
}
customElements.define("ytk-player", YtkPlayer);
