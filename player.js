/* AppMusic — Spotify remote-control player (vanilla JS, no deps).
   Same shell as the offline player, but playback happens in the user's
   Spotify app via the Web API (no SDK, no in-app streaming).
   One-time PKCE authorization stores a refresh token in localStorage;
   after that the player connects silently — no Connect button.
   API:
     AppMusic.init({ mount, storageKey, appName, clientId, playlistId })
     AppMusic.duck()/unduck() — no-ops (kept so app cue code stays valid)
     AppMusic.pause(), AppMusic.isPlaying()
*/
(function () {
  "use strict";
  var API = "https://api.spotify.com/v1";
  var SCOPES = "user-read-playback-state user-modify-playback-state user-read-currently-playing";
  var state = {
    tracks: [], tokens: null, deviceId: null, isPlaying: false,
    currentUri: null, progressMs: 0, anchorAt: 0, durationMs: 0,
    shuffle: false, repeat: "off", volume: 90, collapsed: false,
    seeking: false, setup: false, pollTimer: 0, tickTimer: 0, volDead: false
  };
  var els = {}, opts = {};
  var TK = ""; // localStorage key for tokens

  function $(cls) { return els.root.querySelector("." + cls); }
  function fmt(s) {
    if (!isFinite(s) || s < 0) s = 0;
    s = Math.round(s);
    return Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2);
  }
  function status(msg) {
    var el = $("amp-status");
    if (el) { el.textContent = msg || ""; el.style.display = msg ? "block" : "none"; }
  }
  function redirectUri() { return location.origin + location.pathname; }

  /* ---------- tokens ---------- */
  function saveTokens(t) {
    state.tokens = t;
    try { localStorage.setItem(TK, JSON.stringify(t)); } catch (e) {}
  }
  function loadTokens() {
    try { state.tokens = JSON.parse(localStorage.getItem(TK) || "null"); } catch (e) { state.tokens = null; }
    return state.tokens;
  }
  function clearTokens() {
    state.tokens = null;
    try { localStorage.removeItem(TK); } catch (e) {}
  }
  function tokenPost(body) {
    return fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString()
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); });
  }
  function storeAuth(j) {
    saveTokens({
      access: j.access_token,
      refresh: j.refresh_token || (state.tokens && state.tokens.refresh),
      expires: Date.now() + (j.expires_in || 3600) * 1000
    });
  }
  function refresh() {
    if (!state.tokens || !state.tokens.refresh) return Promise.reject(new Error("no refresh"));
    return tokenPost({
      grant_type: "refresh_token", refresh_token: state.tokens.refresh,
      client_id: opts.clientId
    }).then(function (res) {
      if (!res.ok) throw new Error("refresh failed");
      storeAuth(res.j);
      return state.tokens.access;
    });
  }
  function accessToken() {
    if (state.tokens && state.tokens.access && Date.now() < state.tokens.expires - 30000) {
      return Promise.resolve(state.tokens.access);
    }
    return refresh();
  }
  function api(path, method, body) {
    return accessToken().then(function (tok) {
      return fetch(API + path, {
        method: method || "GET",
        headers: { "Authorization": "Bearer " + tok, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined
      }).then(function (r) {
        if (r.status === 401) {
          return refresh().then(function (tok2) {
            return fetch(API + path, {
              method: method || "GET",
              headers: { "Authorization": "Bearer " + tok2, "Content-Type": "application/json" },
              body: body ? JSON.stringify(body) : undefined
            });
          });
        }
        return r;
      });
    });
  }

  /* ---------- one-time PKCE setup ---------- */
  function startAuth() {
    var bytes = new Uint8Array(64);
    crypto.getRandomValues(bytes);
    var verifier = Array.prototype.map.call(bytes, function (b) {
      return ("0" + b.toString(16)).slice(-2);
    }).join("");
    try { sessionStorage.setItem(TK + ".verifier", verifier); } catch (e) {}
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)).then(function (hash) {
      var challenge = btoa(String.fromCharCode.apply(null, new Uint8Array(hash)))
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      var params = new URLSearchParams({
        response_type: "code", client_id: opts.clientId, scope: SCOPES,
        redirect_uri: redirectUri(), code_challenge_method: "S256",
        code_challenge: challenge
      });
      location.href = "https://accounts.spotify.com/authorize?" + params.toString();
    });
  }
  function handleCallback() {
    var q = new URLSearchParams(location.search);
    var code = q.get("code");
    if (!code) return Promise.resolve(false);
    var verifier = "";
    try { verifier = sessionStorage.getItem(TK + ".verifier") || ""; } catch (e) {}
    history.replaceState({}, "", location.pathname);
    return tokenPost({
      grant_type: "authorization_code", code: code,
      redirect_uri: redirectUri(), client_id: opts.clientId,
      code_verifier: verifier
    }).then(function (res) {
      if (res.ok) storeAuth(res.j);
      return res.ok;
    }).catch(function () { return false; });
  }

  /* ---------- playlist + playback state ---------- */
  function loadPlaylist() {
    return api("/playlists/" + opts.playlistId + "/tracks?limit=100&fields=items(track(uri,name,duration_ms,artists(name)))")
      .then(function (r) { return r.ok ? r.json() : { items: [] }; })
      .then(function (j) {
        state.tracks = (j.items || []).map(function (it) {
          var t = it.track || {};
          return {
            uri: t.uri, title: t.name || "Unknown",
            artist: (t.artists || []).map(function (a) { return a.name; }).join(", "),
            duration: Math.round((t.duration_ms || 0) / 1000)
          };
        }).filter(function (t) { return t.uri; });
        renderList(); renderMeta();
      }).catch(function () { status("Couldn't load the playlist. Check your connection."); });
  }
  function refreshPlayback() {
    return api("/me/player").then(function (r) {
      if (r.status === 204) { state.isPlaying = false; updatePlayBtn(); return null; }
      return r.ok ? r.json() : null;
    }).then(function (p) {
      if (!p) return;
      if (p.device) state.deviceId = p.device.id;
      state.isPlaying = !!p.is_playing;
      state.shuffle = !!p.shuffle_state;
      state.repeat = p.repeat_state || "off";
      if (p.item) {
        state.currentUri = p.item.uri;
        state.durationMs = p.item.duration_ms || 0;
      }
      state.progressMs = p.progress_ms || 0;
      state.anchorAt = Date.now();
      updatePlayBtn(); updateToggles(); renderMeta(); renderList();
      drawProgress();
    }).catch(function () {});
  }
  function chooseDevice() {
    return api("/me/player/devices").then(function (r) { return r.ok ? r.json() : { devices: [] }; })
      .then(function (j) {
        var devs = j.devices || [];
        var pick = devs.filter(function (d) { return d.is_active; })[0] ||
          devs.filter(function (d) { return d.type === "Smartphone"; })[0] || devs[0];
        state.deviceId = pick ? pick.id : null;
        return state.deviceId;
      }).catch(function () { return null; });
  }
  function ensureDevice() {
    if (state.deviceId) return Promise.resolve(state.deviceId);
    return chooseDevice();
  }

  function play(uri) {
    ensureDevice().then(function (id) {
      if (!id) {
        status("No Spotify device found. Open the Spotify app on your phone once, then tap play again.");
        return;
      }
      status("");
      var body;
      if (uri) body = { context_uri: "spotify:playlist:" + opts.playlistId, offset: { uri: uri } };
      else if (state.currentUri && isPlaylistContext()) body = undefined; // resume
      else body = { context_uri: "spotify:playlist:" + opts.playlistId };
      api("/me/player/play?device_id=" + encodeURIComponent(id), "PUT", body).then(function (r) {
        if (r.status === 404) { state.deviceId = null; status("Spotify device went away. Open the Spotify app, then tap play again."); }
        setTimeout(refreshPlayback, 700);
      });
    });
  }
  function isPlaylistContext() {
    // We only know the current item, not its context; resuming in place is
    // right if the current track is in this playlist.
    return state.tracks.some(function (t) { return t.uri === state.currentUri; });
  }
  function pausePlayback() {
    api("/me/player/pause", "PUT").then(function () { setTimeout(refreshPlayback, 400); });
  }

  /* ---------- UI ---------- */
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
    '<div class="amp-status" style="display:none"></div>' +
    '<div class="amp-setup" style="display:none"><p class="amp-setup-text">One-time setup: connect this app to your Spotify. You only do this once — after that it connects on its own, no button.</p>' +
    '<button class="amp-setup-btn">Set up Spotify once</button></div>' +
    '<ol class="amp-list"></ol>' +
    '<p class="amp-note">Plays in your Spotify app.</p>' +
    '</div>';

  function currentTrack() {
    return state.tracks.filter(function (t) { return t.uri === state.currentUri; })[0] || null;
  }
  function renderMeta() {
    var t = currentTrack();
    if (state.setup) {
      $("amp-title").textContent = "Spotify not set up yet";
      $("amp-artist").textContent = "";
      return;
    }
    $("amp-title").textContent = t ? t.title : (state.tracks.length ? "Your playlist" : "Loading…");
    $("amp-artist").textContent = t ? t.artist : "";
  }
  function renderList() {
    var ol = $("amp-list");
    if (!ol) return;
    ol.innerHTML = "";
    state.tracks.forEach(function (t) {
      var li = document.createElement("li");
      li.className = "amp-track" + (t.uri === state.currentUri ? " current" : "");
      var name = document.createElement("span");
      name.className = "amp-track-name";
      name.textContent = t.title + (t.artist ? " — " + t.artist : "");
      var dur = document.createElement("span");
      dur.className = "amp-track-dur";
      dur.textContent = t.duration ? fmt(t.duration) : "";
      li.appendChild(name); li.appendChild(dur);
      li.addEventListener("click", function () { play(t.uri); });
      ol.appendChild(li);
    });
  }
  function updatePlayBtn() { $("amp-play").textContent = state.isPlaying ? "⏸" : "▶"; }
  function updateToggles() {
    $("amp-shuffle").classList.toggle("on", state.shuffle);
    var b = $("amp-repeat");
    b.textContent = state.repeat === "track" ? "🔂 One" : state.repeat === "off" ? "🔁 Off" : "🔁 All";
    b.classList.toggle("on", state.repeat !== "off");
  }
  function progressNow() {
    if (!state.isPlaying) return state.progressMs;
    return Math.min(state.durationMs, state.progressMs + (Date.now() - state.anchorAt));
  }
  function drawProgress() {
    if (state.seeking) return;
    var d = state.durationMs / 1000;
    var p = progressNow() / 1000;
    $("amp-seek").value = d > 0 ? Math.round((p / d) * 1000) : 0;
    $("amp-cur").textContent = fmt(p);
    $("amp-dur").textContent = fmt(d);
  }
  function saveUi() {
    try {
      localStorage.setItem(opts.storageKey + ".ui",
        JSON.stringify({ volume: state.volume, collapsed: state.collapsed }));
    } catch (e) {}
  }
  function loadUi() {
    try {
      var p = JSON.parse(localStorage.getItem(opts.storageKey + ".ui") || "null");
      if (p) {
        state.volume = typeof p.volume === "number" ? p.volume : 90;
        state.collapsed = !!p.collapsed;
      }
    } catch (e) {}
  }
  function showSetup(on) {
    state.setup = on;
    $("amp-setup").style.display = on ? "block" : "none";
    $("amp-list").style.display = on ? "none" : "";
    renderMeta();
  }

  function init(o) {
    opts = o || {};
    TK = opts.storageKey + ".spotify";
    var mount = document.getElementById(opts.mount);
    if (!mount) return;
    loadUi();
    els.root = document.createElement("div");
    els.root.className = "amp" + (state.collapsed ? " collapsed" : "");
    els.root.innerHTML = HTML;
    mount.appendChild(els.root);
    $("amp-vol").value = state.volume;
    $("amp-collapse").textContent = state.collapsed ? "▸" : "▾";
    updateToggles();

    $("amp-play").addEventListener("click", function () {
      if (state.setup) { startAuth(); return; }
      state.isPlaying ? pausePlayback() : play();
    });
    $("amp-next").addEventListener("click", function () {
      api("/me/player/next", "POST").then(function () { setTimeout(refreshPlayback, 600); });
    });
    $("amp-prev").addEventListener("click", function () {
      api("/me/player/previous", "POST").then(function () { setTimeout(refreshPlayback, 600); });
    });
    $("amp-collapse").addEventListener("click", function () {
      state.collapsed = !state.collapsed;
      els.root.classList.toggle("collapsed", state.collapsed);
      $("amp-collapse").textContent = state.collapsed ? "▸" : "▾";
      saveUi();
    });
    $("amp-shuffle").addEventListener("click", function () {
      state.shuffle = !state.shuffle; updateToggles();
      api("/me/player/shuffle?state=" + state.shuffle, "PUT");
    });
    $("amp-repeat").addEventListener("click", function () {
      state.repeat = state.repeat === "context" ? "track" : state.repeat === "track" ? "off" : "context";
      updateToggles();
      api("/me/player/repeat?state=" + state.repeat, "PUT");
    });
    var volTimer = 0;
    $("amp-vol").addEventListener("input", function (e) {
      state.volume = Number(e.target.value); saveUi();
      if (state.volDead) return;
      clearTimeout(volTimer);
      volTimer = setTimeout(function () {
        api("/me/player/volume?volume_percent=" + state.volume, "PUT").then(function (r) {
          if (r && (r.status === 403 || r.status === 404)) {
            state.volDead = true;
            $("amp-vol").disabled = true;
            $("amp-vol").title = "Volume is controlled in the Spotify app for this device";
          }
        }).catch(function () {});
      }, 250);
    });
    var seek = $("amp-seek");
    seek.addEventListener("input", function () { state.seeking = true; });
    seek.addEventListener("change", function () {
      state.seeking = false;
      if (state.durationMs > 0) {
        var ms = Math.round((seek.value / 1000) * state.durationMs);
        state.progressMs = ms; state.anchorAt = Date.now();
        api("/me/player/seek?position_ms=" + ms, "PUT").then(function () { setTimeout(refreshPlayback, 500); });
      }
    });
    $("amp-setup-btn").addEventListener("click", startAuth);

    loadTokens();
    handleCallback().then(function () {
      if (!state.tokens || !state.tokens.refresh) { showSetup(true); return; }
      showSetup(false);
      accessToken().then(function () {
        loadPlaylist(); refreshPlayback(); chooseDevice();
        state.pollTimer = setInterval(function () {
          if (document.visibilityState === "visible") refreshPlayback();
        }, 5000);
        state.tickTimer = setInterval(drawProgress, 1000);
      }).catch(function () { clearTokens(); showSetup(true); });
    });
  }

  window.AppMusic = {
    init: init,
    duck: function () {},
    unduck: function () {},
    pause: function () { if (state.tokens) pausePlayback(); },
    isPlaying: function () { return state.isPlaying; }
  };
})();
