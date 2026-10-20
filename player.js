/* AppMusic — self-contained offline music player (vanilla JS, no deps).
   One copy lives in each app. Loads music/playlist.json, plays local MP3s.
   API:
     AppMusic.init({ mount: "musicMount", storageKey: "appmusic.<app>", appName: "My App" })
     AppMusic.duck()    — lower music while a voice cue plays (nestable)
     AppMusic.unduck()  — restore after the cue
     AppMusic.pause()   — pause music (used by apps if needed)
   Persistence (per storageKey): track index, position, volume, shuffle,
   repeat, collapsed. Playback starts only after a user tap.
*/
(function () {
  "use strict";
  var state = {
    tracks: [], index: 0, playing: false, shuffle: false,
    repeat: "all", volume: 0.9, duckCount: 0, missing: {},
    seeking: false, saveTimer: 0, started: false,
    userTracks: [], blobs: {}, objUrl: null
  };
  var els = {}, audio = null, opts = {}, base = "music/";

  /* User-imported files live in IndexedDB so they survive offline. */
  function keyOf(t) { return t.blobId ? "blob:" + t.blobId : t.file; }
  function idb() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open("appmusic-files-v1", 1);
      r.onupgradeneeded = function () { r.result.createObjectStore("files"); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function idbAll() {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var out = {}, tx = db.transaction("files").objectStore("files").openCursor();
        tx.onsuccess = function () {
          var c = tx.result;
          if (c) { out[c.key] = c.value; c.continue(); } else res(out);
        };
        tx.onerror = function () { rej(tx.error); };
      });
    }).catch(function () { return {}; });
  }
  function idbPut(id, blob) {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction("files", "readwrite");
        tx.objectStore("files").put(blob, id);
        tx.oncomplete = res; tx.onerror = function () { rej(tx.error); };
      });
    });
  }
  function idbDel(id) {
    return idb().then(function (db) {
      return new Promise(function (res) {
        var tx = db.transaction("files", "readwrite");
        tx.objectStore("files").delete(id);
        tx.oncomplete = res; tx.onerror = res;
      });
    }).catch(function () {});
  }
  function saveUserMeta() {
    try {
      localStorage.setItem(opts.storageKey + ".usertracks",
        JSON.stringify(state.userTracks.map(function (t) {
          return { blobId: t.blobId, title: t.title, artist: t.artist, duration: t.duration };
        })));
    } catch (e) {}
  }
  function loadUserMeta() {
    try {
      state.userTracks = JSON.parse(localStorage.getItem(opts.storageKey + ".usertracks") || "[]")
        .filter(function (t) { return t && t.blobId; })
        .map(function (t) { t.user = true; return t; });
    } catch (e) { state.userTracks = []; }
  }

  function $(cls) { return els.root.querySelector("." + cls); }
  function fmt(s) {
    if (!isFinite(s) || s < 0) s = 0;
    s = Math.round(s);
    return Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2);
  }
  function save() {
    try {
      localStorage.setItem(opts.storageKey, JSON.stringify({
        index: state.index,
        position: audio ? audio.currentTime || 0 : 0,
        volume: state.volume, shuffle: state.shuffle,
        repeat: state.repeat, collapsed: state.collapsed
      }));
    } catch (e) {}
  }
  function loadPrefs() {
    try {
      var p = JSON.parse(localStorage.getItem(opts.storageKey) || "null");
      if (p) {
        state.index = p.index || 0;
        state.volume = typeof p.volume === "number" ? p.volume : 0.9;
        state.shuffle = !!p.shuffle;
        state.repeat = p.repeat || "all";
        state.collapsed = !!p.collapsed;
        state.savedPosition = p.position || 0;
      }
    } catch (e) {}
  }
  function applyVolume() {
    if (!audio) return;
    var duck = state.duckCount > 0 ? 0.25 : 1;
    audio.volume = Math.max(0, Math.min(1, state.volume * duck));
  }

  function renderList() {
    var ol = $("amp-list");
    ol.innerHTML = "";
    state.tracks.forEach(function (t, i) {
      var li = document.createElement("li");
      li.className = "amp-track" + (i === state.index ? " current" : "") +
        (state.missing[keyOf(t)] ? " missing" : "");
      var name = document.createElement("span");
      name.className = "amp-track-name";
      name.textContent = t.title + (state.missing[keyOf(t)] ? " (file missing)" : "");
      var dur = document.createElement("span");
      dur.className = "amp-track-dur";
      dur.textContent = t.duration ? fmt(t.duration) : "";
      li.appendChild(name);
      if (t.user) {
        var rm = document.createElement("button");
        rm.className = "amp-remove"; rm.textContent = "✕"; rm.title = "Remove song";
        rm.addEventListener("click", function (e) {
          e.stopPropagation(); removeUserTrack(t.blobId);
        });
        li.appendChild(rm);
      }
      li.appendChild(dur);
      li.addEventListener("click", function () {
        if (state.missing[keyOf(t)]) return;
        loadTrack(i, true);
      });
      ol.appendChild(li);
    });
  }
  function renderMeta() {
    var t = state.tracks[state.index];
    $("amp-title").textContent = t ? t.title : "No music";
    $("amp-artist").textContent = t ? (t.artist || "") : "";
    if ("mediaSession" in navigator && t) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: t.title, artist: t.artist || "", album: opts.appName || ""
        });
      } catch (e) {}
    }
    renderList();
  }
  function loadTrack(i, autoplay) {
    if (!state.tracks.length) return;
    state.index = (i + state.tracks.length) % state.tracks.length;
    var t = state.tracks[state.index];
    if (state.objUrl) { URL.revokeObjectURL(state.objUrl); state.objUrl = null; }
    if (t.blobId) {
      var blob = state.blobs[t.blobId];
      if (!blob) { state.missing[keyOf(t)] = true; renderMeta(); if (autoplay) next(false); return; }
      state.objUrl = URL.createObjectURL(blob);
      audio.src = state.objUrl;
    } else {
      audio.src = base + t.file;
    }
    renderMeta();
    if (autoplay) play();
    save();
  }
  function removeUserTrack(blobId) {
    var wasCurrent = state.tracks[state.index] && state.tracks[state.index].blobId === blobId;
    delete state.blobs[blobId];
    state.userTracks = state.userTracks.filter(function (t) { return t.blobId !== blobId; });
    state.tracks = state.tracks.filter(function (t) { return t.blobId !== blobId; });
    saveUserMeta(); idbDel(blobId);
    if (state.index >= state.tracks.length) state.index = Math.max(0, state.tracks.length - 1);
    if (wasCurrent) { pause(); if (state.tracks.length) loadTrack(state.index, false); }
    renderList(); save();
  }
  function importFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    var pending = files.length;
    files.forEach(function (f) {
      if (!/audio|\.mp3$|\.m4a$|\.ogg$|\.wav$/i.test(f.type + " " + f.name)) { if (--pending === 0) renderList(); return; }
      var id = "u" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      var clean = f.name.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").trim();
      var title = clean || "Untitled", artist = "Your music";
      var parts = clean.split(" - ");
      if (parts.length > 1) { artist = parts[0].trim(); title = parts.slice(1).join(" - ").trim(); }
      idbPut(id, f).then(function () {
        state.blobs[id] = f;
        var meta = { blobId: id, title: title, artist: artist, duration: 0, user: true };
        var probe = new Audio();
        probe.preload = "metadata";
        probe.onloadedmetadata = function () {
          meta.duration = Math.round(probe.duration) || 0;
          URL.revokeObjectURL(probe.src);
          finish();
        };
        probe.onerror = finish;
        probe.src = URL.createObjectURL(f);
        function finish() {
          state.userTracks.push(meta);
          state.tracks.push(meta);
          saveUserMeta();
          if (--pending === 0) { renderList(); renderMeta(); }
        }
      }).catch(function () { if (--pending === 0) renderList(); });
    });
  }
  function play() {
    if (!audio || !state.tracks.length) return;
    var p = audio.play();
    if (p && p.catch) p.catch(function () {});
  }
  function pause() { if (audio) audio.pause(); }
  function next(auto) {
    if (!state.tracks.length) return;
    if (auto && state.repeat === "one") { audio.currentTime = 0; play(); return; }
    var n = state.index;
    if (state.shuffle) {
      if (state.tracks.length > 1) {
        do { n = Math.floor(Math.random() * state.tracks.length); }
        while (n === state.index || state.missing[keyOf(state.tracks[n])]);
      }
    } else {
      n = state.index + 1;
      if (n >= state.tracks.length) {
        if (auto && state.repeat === "off") { pause(); audio.currentTime = 0; return; }
        n = 0;
      }
      while (state.tracks[n] && state.missing[keyOf(state.tracks[n])] && n !== state.index) {
        n = (n + 1) % state.tracks.length;
      }
    }
    loadTrack(n, true);
  }
  function prev() {
    if (!state.tracks.length) return;
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    loadTrack(state.index - 1, state.playing);
  }

  var HTML =
    '<div class="amp-bar">' +
    '<button class="amp-btn amp-play" aria-label="Play or pause">▶</button>' +
    '<button class="amp-btn amp-prev" aria-label="Previous track">⏮</button>' +
    '<button class="amp-btn amp-next" aria-label="Next track">⏭</button>' +
    '<div class="amp-meta"><div class="amp-title">Loading…</div><div class="amp-artist"></div></div>' +
    '<button class="amp-btn amp-collapse" aria-label="Collapse player">▾</button>' +
    '</div>' +
    '<div class="amp-body">' +
    '<div class="amp-progress"><span class="amp-cur">0:00</span>' +
    '<input type="range" class="amp-seek" min="0" max="1000" value="0" aria-label="Seek">' +
    '<span class="amp-dur">0:00</span></div>' +
    '<div class="amp-controls">' +
    '<label class="amp-volwrap">Volume <input type="range" class="amp-vol" min="0" max="100" value="90" aria-label="Volume"></label>' +
    '<button class="amp-toggle amp-shuffle" aria-label="Shuffle">🔀 Shuffle</button>' +
    '<button class="amp-toggle amp-repeat" aria-label="Repeat">🔁 All</button>' +
    '<button class="amp-toggle amp-add" aria-label="Add your own songs">＋ Add songs</button>' +
    '<input type="file" class="amp-file" accept="audio/*,.mp3,.m4a,.ogg,.wav" multiple hidden>' +
    '</div>' +
    '<ol class="amp-list"></ol>' +
    '<details class="amp-credits"><summary>Music credits &amp; licenses</summary><div class="amp-credits-body"></div></details>' +
    '</div>';

  function buildCredits() {
    var box = $("amp-credits-body");
    box.innerHTML = "";
    state.tracks.forEach(function (t) {
      if (t.user) return;
      var d = document.createElement("div");
      d.className = "amp-credit";
      var a = document.createElement("a");
      a.href = t.source || "#"; a.target = "_blank"; a.rel = "noopener";
      a.textContent = t.title + " — " + (t.artist || "Unknown");
      d.appendChild(a);
      var s = document.createElement("span");
      s.textContent = " · " + (t.license || "") + (t.source ? " · Source" : "");
      d.appendChild(s);
      box.appendChild(d);
    });
  }

  function init(o) {
    opts = o || {};
    var mount = document.getElementById(opts.mount);
    if (!mount) return;
    loadPrefs();
    els.root = document.createElement("div");
    els.root.className = "amp" + (state.collapsed ? " collapsed" : "");
    els.root.innerHTML = HTML;
    mount.appendChild(els.root);

    audio = new Audio();
    audio.preload = "metadata";
    applyVolume();
    $("amp-vol").value = Math.round(state.volume * 100);
    $("amp-shuffle").classList.toggle("on", state.shuffle);
    updateRepeatBtn();
    $("amp-collapse").textContent = state.collapsed ? "▸" : "▾";

    $("amp-play").addEventListener("click", function () {
      state.playing ? pause() : play();
    });
    $("amp-next").addEventListener("click", function () { next(false); });
    $("amp-prev").addEventListener("click", prev);
    $("amp-collapse").addEventListener("click", function () {
      state.collapsed = !state.collapsed;
      els.root.classList.toggle("collapsed", state.collapsed);
      $("amp-collapse").textContent = state.collapsed ? "▸" : "▾";
      save();
    });
    $("amp-shuffle").addEventListener("click", function () {
      state.shuffle = !state.shuffle;
      $("amp-shuffle").classList.toggle("on", state.shuffle);
      save();
    });
    $("amp-repeat").addEventListener("click", function () {
      state.repeat = state.repeat === "all" ? "one" : state.repeat === "one" ? "off" : "all";
      updateRepeatBtn(); save();
    });
    $("amp-vol").addEventListener("input", function (e) {
      state.volume = e.target.value / 100; applyVolume(); save();
    });
    $("amp-add").addEventListener("click", function () { $("amp-file").click(); });
    $("amp-file").addEventListener("change", function (e) {
      importFiles(e.target.files); e.target.value = "";
    });
    if (navigator.storage && navigator.storage.persist) {
      try { navigator.storage.persist(); } catch (e) {}
    }
    var seek = $("amp-seek");
    seek.addEventListener("input", function () { state.seeking = true; });
    seek.addEventListener("change", function () {
      if (isFinite(audio.duration) && audio.duration > 0) {
        audio.currentTime = (seek.value / 1000) * audio.duration;
      }
      state.seeking = false; save();
    });

    audio.addEventListener("play", function () {
      state.playing = true; state.started = true;
      $("amp-play").textContent = "⏸";
      if ("mediaSession" in navigator) { try { navigator.mediaSession.playbackState = "playing"; } catch (e) {} }
    });
    audio.addEventListener("pause", function () {
      state.playing = false;
      $("amp-play").textContent = "▶";
      if ("mediaSession" in navigator) { try { navigator.mediaSession.playbackState = "paused"; } catch (e) {} }
      save();
    });
    audio.addEventListener("timeupdate", function () {
      if (!state.seeking && isFinite(audio.duration) && audio.duration > 0) {
        $("amp-seek").value = Math.round((audio.currentTime / audio.duration) * 1000);
        if ("mediaSession" in navigator && navigator.mediaSession.setPositionState) {
          try {
            navigator.mediaSession.setPositionState({
              duration: audio.duration, position: audio.currentTime, playbackRate: audio.playbackRate
            });
          } catch (e) {}
        }
      }
      $("amp-cur").textContent = fmt(audio.currentTime);
      var now = Date.now();
      if (now - state.saveTimer > 4000) { state.saveTimer = now; save(); }
    });
    audio.addEventListener("loadedmetadata", function () {
      $("amp-dur").textContent = fmt(audio.duration);
      if (!state.started && state.savedPosition > 0) {
        try { audio.currentTime = Math.min(state.savedPosition, (audio.duration || 0) - 1); } catch (e) {}
        state.savedPosition = 0;
      }
    });
    audio.addEventListener("ended", function () { next(true); });
    audio.addEventListener("error", function () {
      var t = state.tracks[state.index];
      if (t) state.missing[keyOf(t)] = true;
      renderList();
      var remain = state.tracks.some(function (x) { return !state.missing[keyOf(x)]; });
      if (remain && state.playing) next(false);
    });

    if ("mediaSession" in navigator) {
      try {
        navigator.mediaSession.setActionHandler("play", play);
        navigator.mediaSession.setActionHandler("pause", pause);
        navigator.mediaSession.setActionHandler("previoustrack", prev);
        navigator.mediaSession.setActionHandler("nexttrack", function () { next(false); });
        navigator.mediaSession.setActionHandler("seekto", function (d) {
          if (typeof d.seekTime === "number") audio.currentTime = d.seekTime;
        });
      } catch (e) {}
    }

    fetch(base + "playlist.json", { cache: "no-cache" })
      .then(function (r) { if (!r.ok) throw new Error("playlist"); return r.json(); })
      .then(function (data) {
        var builtin = (data.tracks || []).filter(function (t) { return t && t.file; });
        return idbAll().then(function (blobs) {
          state.blobs = blobs;
          loadUserMeta();
          state.userTracks.forEach(function (t) {
            if (!blobs[t.blobId]) state.missing[keyOf(t)] = true;
          });
          state.tracks = builtin.concat(state.userTracks);
          if (state.index >= state.tracks.length) state.index = 0;
          if (state.tracks.length) { loadTrack(state.index, false); buildCredits(); }
          else {
            $("amp-title").textContent = "No music added yet";
            $("amp-artist").textContent = "Tap ＋ Add songs to add your own MP3s.";
          }
        });
      })
      .catch(function () {
        $("amp-title").textContent = "Music unavailable";
        $("amp-artist").textContent = "playlist.json could not be loaded.";
      });
  }

  function updateRepeatBtn() {
    var b = $("amp-repeat");
    if (!b) return;
    b.textContent = state.repeat === "one" ? "🔂 One" : state.repeat === "off" ? "🔁 Off" : "🔁 All";
    b.classList.toggle("on", state.repeat !== "off");
  }

  window.AppMusic = {
    init: init,
    duck: function () { state.duckCount++; applyVolume(); },
    unduck: function () { state.duckCount = Math.max(0, state.duckCount - 1); applyVolume(); },
    pause: pause,
    isPlaying: function () { return state.playing; }
  };
})();
