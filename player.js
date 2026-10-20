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
    seeking: false, saveTimer: 0, started: false
  };
  var els = {}, audio = null, opts = {}, base = "music/";

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
        (state.missing[t.file] ? " missing" : "");
      var name = document.createElement("span");
      name.className = "amp-track-name";
      name.textContent = t.title + (state.missing[t.file] ? " (file missing)" : "");
      var dur = document.createElement("span");
      dur.className = "amp-track-dur";
      dur.textContent = t.duration ? fmt(t.duration) : "";
      li.appendChild(name); li.appendChild(dur);
      li.addEventListener("click", function () {
        if (state.missing[t.file]) return;
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
    audio.src = base + t.file;
    renderMeta();
    if (autoplay) play();
    save();
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
        while (n === state.index || state.missing[state.tracks[n].file]);
      }
    } else {
      n = state.index + 1;
      if (n >= state.tracks.length) {
        if (auto && state.repeat === "off") { pause(); audio.currentTime = 0; return; }
        n = 0;
      }
      while (state.missing[state.tracks[n] && state.tracks[n].file] && n !== state.index) {
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
    '</div>' +
    '<ol class="amp-list"></ol>' +
    '<details class="amp-credits"><summary>Music credits &amp; licenses</summary><div class="amp-credits-body"></div></details>' +
    '</div>';

  function buildCredits() {
    var box = $("amp-credits-body");
    box.innerHTML = "";
    state.tracks.forEach(function (t) {
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
      if (t) state.missing[t.file] = true;
      renderList();
      var remain = state.tracks.some(function (x) { return !state.missing[x.file]; });
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
        state.tracks = (data.tracks || []).filter(function (t) { return t && t.file; });
        if (state.index >= state.tracks.length) state.index = 0;
        if (state.tracks.length) { loadTrack(state.index, false); buildCredits(); }
        else {
          $("amp-title").textContent = "No music added yet";
          $("amp-artist").textContent = "Add MP3 files to the music folder (see README).";
        }
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
