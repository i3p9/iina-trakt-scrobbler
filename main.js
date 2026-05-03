const { core, event, file, preferences, utils, sidebar, menu } = iina;

var parser = require("./parser.js");
var monitor = require("./monitor.js");
var trakt = require("./trakt.js");
var DEBUG_LOG_PATH = "@data/debug.log";
var MAX_DEBUG_LOG_CHARS = 200000;
var POLL_INTERVAL_MS = 2000;
var UI_POLL_INTERVAL_MS = 750;
var PLUGIN_SIDEBAR_ID = "plugin:io.github.fahim.iinatraktscrobbler";
var currentMedia = null;
var lastSourceSignature = "";
var playbackState = createPlaybackState();
var pollTimer = null;
var uiPollTimer = null;
var sidebarHandlersBound = false;
var firstScrobbleNoticeShown = false;
var missingCredentialsNoticeShown = false;
var authRequiredNoticeShown = false;
var guessitFailureLogged = false;
var lastHandledAuthActionNonce = "";
var lastAuthStatusSignature = "";
var authActionChain = Promise.resolve();
var sidebarRefreshChain = Promise.resolve();
var lastScrobbleStatus = createScrobbleStatus();

function createPlaybackState() {
  return {
    prevSnapshot: null,
    preview: false,
    fastPause: false,
    scrobbleBuffer: null,
    previewTimer: null,
    fastPauseTimer: null,
    lastScrobbleKey: "",
    scrobbleChain: Promise.resolve()
  };
}

function createScrobbleStatus() {
  return {
    status: "idle",
    verb: "",
    mediaLabel: "",
    detail: "No scrobble has been attempted in this window yet.",
    reason: "",
    progress: null,
    updatedAt: ""
  };
}

trakt.configure({
  file: file,
  preferences: preferences,
  utils: utils,
  logger: function(message) {
    log(message);
  },
  notify: function(message) {
    importantOsd(message);
  }
});

function appendDebugLog(message) {
  var line = "[" + new Date().toISOString() + "] " + message;
  try {
    var existing = file.exists(DEBUG_LOG_PATH) ? (file.read(DEBUG_LOG_PATH) || "") : "";
    var next = existing + line + "\n";
    if (next.length > MAX_DEBUG_LOG_CHARS) {
      next = next.slice(next.length - MAX_DEBUG_LOG_CHARS);
    }
    file.write(DEBUG_LOG_PATH, next);
  } catch (_error) {}
}

function log(message) {
  iina.console.log("[IINATraktScrobbler] " + message);
  appendDebugLog("[IINATraktScrobbler] " + message);
}

function errStr(error) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  return error.message || String(error);
}

function logGuessitFailureOnce() {
  if (guessitFailureLogged || !parser || typeof parser.getDiagnostics !== "function") return;

  var diagnostics = parser.getDiagnostics();
  if (!diagnostics) return;
  if (
    diagnostics.guessitStatus !== "load-failed" &&
    diagnostics.guessitStatus !== "unconfigured" &&
    diagnostics.guessitStatus !== "runtime-failed"
  ) return;

  guessitFailureLogged = true;
  if (diagnostics.guessitStatus === "runtime-failed") {
    log("Guessit runtime failed: " + diagnostics.guessitError);
    return;
  }

  log("Guessit unavailable: " + diagnostics.guessitLoadError);
}

function prefBool(key, fallbackValue) {
  var value = preferences.get(key);
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return fallbackValue;
}

function prefNumber(key, fallbackValue) {
  var value = Number(preferences.get(key));
  return isFinite(value) ? value : fallbackValue;
}

function debugOsd(message) {
  if (!prefBool("debug_osd", false)) return;
  try {
    core.osd("Trakt Scrobbler: " + message);
  } catch (_error) {}
}

function statusOsd(message) {
  if (!prefBool("status_osd", true)) return;
  try {
    core.osd("Trakt Scrobbler: " + message);
  } catch (_error) {}
}

function importantOsd(message) {
  try {
    core.osd("Trakt Scrobbler: " + message);
  } catch (_error) {}
}

function maybeShowScrobbleStatusOsd(verb) {
  if (verb === "start") {
    statusOsd("Watching on Trakt");
    return;
  }

  if (verb === "stop") {
    statusOsd("Stopped on Trakt");
  }
}

function persistPreferences(values) {
  Object.keys(values || {}).forEach(function(key) {
    preferences.set(key, values[key]);
  });

  if (typeof preferences.sync === "function") {
    try {
      preferences.sync();
    } catch (_error) {}
  }
}

function authStatusSignature(status) {
  return JSON.stringify({
    state: status.state,
    summary: status.summary,
    detail: status.detail,
    busy: !!status.busy,
    connected: !!status.connected,
    credentialMode: status.credentialMode
  });
}

function persistAuthStatus(status) {
  var resolved = status || trakt.getAuthStatus();
  var signature = authStatusSignature(resolved);
  var payload = {
    auth_state: resolved.state,
    auth_summary: resolved.summary,
    auth_detail: resolved.detail || "",
    auth_busy: !!resolved.busy,
    auth_connected: !!resolved.connected,
    auth_credential_mode: resolved.credentialMode || ""
  };

  if (signature !== lastAuthStatusSignature) {
    payload.auth_updated_at = new Date().toISOString();
    lastAuthStatusSignature = signature;
  }

  persistPreferences(payload);
  return resolved;
}

function stateName(state) {
  if (state === monitor.State.Playing) return "playing";
  if (state === monitor.State.Paused) return "paused";
  if (state === monitor.State.Stopped) return "stopped";
  return core.status.idle ? "idle" : (core.status.paused ? "paused" : "playing");
}

function cloneScrobbleStatus(status) {
  return {
    status: status.status,
    verb: status.verb,
    mediaLabel: status.mediaLabel,
    detail: status.detail,
    reason: status.reason,
    progress: status.progress,
    updatedAt: status.updatedAt
  };
}

function setScrobbleStatus(values) {
  var incoming = values || {};
  var next = Object.assign({}, lastScrobbleStatus, incoming);
  if (!Object.prototype.hasOwnProperty.call(incoming, "reason") &&
      incoming.status !== "skipped" &&
      incoming.status !== "disabled") {
    next.reason = "";
  }

  lastScrobbleStatus = Object.assign({}, next, {
    updatedAt: new Date().toISOString()
  });
  queueSidebarRefresh(false);
}

function showSidebarTab() {
  try {
    if (sidebar && typeof sidebar.show === "function") {
      sidebar.show();
      return;
    }
  } catch (_error) {}

  try {
    if (core.window) {
      core.window.sidebar = PLUGIN_SIDEBAR_ID;
    }
  } catch (_error) {}
}

function registerMenuItems() {
  if (!menu || typeof menu.addItem !== "function" || typeof menu.item !== "function") {
    return;
  }

  menu.addItem(menu.item("Show Sidebar", function() {
    showSidebarTab();
  }, {
    keyBinding: "Meta+t"
  }));
}

function buildSidebarPlayback() {
  var snapshot = buildLiveSnapshot();
  return {
    available: !!(currentMedia && currentMedia.mediaInfo),
    mediaLabel: currentMedia && currentMedia.mediaInfo ? mediaLabel(currentMedia.mediaInfo) : "",
    parserSource: currentMedia && currentMedia.parsed ? (currentMedia.parsed.parserSource || "") : "",
    state: snapshot ? stateName(snapshot.state) : stateName(null),
    progress: snapshot ? snapshot.progress : 0,
    position: snapshot ? snapshot.position : 0,
    duration: snapshot ? snapshot.duration : 0,
    preview: !!playbackState.preview,
    fastPause: !!playbackState.fastPause,
    identifiedAt: currentMedia ? currentMedia.identifiedAt : ""
  };
}

async function buildSidebarPayload(forceProfileRefresh) {
  var auth = persistAuthStatus();
  var viewerProfile = null;

  if (auth.connected && typeof trakt.getViewerProfile === "function") {
    try {
      viewerProfile = await trakt.getViewerProfile({
        force: !!forceProfileRefresh
      });
    } catch (error) {
      log("Sidebar profile refresh failed: " + errStr(error));
    }
  }

  return {
    scrobblingEnabled: prefBool("scrobble_enabled", true),
    auth: {
      state: auth.state,
      summary: auth.summary,
      detail: auth.detail || "",
      busy: !!auth.busy,
      connected: !!auth.connected,
      credentialMode: auth.credentialMode || "",
      deviceCode: auth.deviceCode || "",
      verificationUrl: auth.verificationUrl || "",
      token: typeof trakt.getTokenInfo === "function" ? trakt.getTokenInfo() : null,
      user: viewerProfile
    },
    playback: buildSidebarPlayback(),
    scrobble: cloneScrobbleStatus(lastScrobbleStatus),
    generatedAt: new Date().toISOString()
  };
}

function queueSidebarRefresh(forceProfileRefresh) {
  if (!sidebar || typeof sidebar.postMessage !== "function") {
    return;
  }

  sidebarRefreshChain = sidebarRefreshChain.then(async function() {
    var payload = await buildSidebarPayload(!!forceProfileRefresh);
    try {
      sidebar.postMessage("state", payload);
    } catch (error) {
      log("Sidebar postMessage failed: " + errStr(error));
    }
  }).catch(function(error) {
    log("Sidebar refresh failed: " + errStr(error));
  });
}

function bindSidebarMessaging() {
  if (sidebarHandlersBound || !sidebar || typeof sidebar.onMessage !== "function") {
    return;
  }

  sidebarHandlersBound = true;

  sidebar.onMessage("ready", function() {
    log("Sidebar ready");
    queueSidebarRefresh(true);
  });

  sidebar.onMessage("connect", function() {
    log("Sidebar requested connect");
    authActionChain = authActionChain.then(async function() {
      var force = trakt.getAuthStatus().state === "connected";
      await runManualAuth(force);
    }).catch(function(error) {
      log("Sidebar connect failed: " + errStr(error));
      persistAuthStatus();
      queueSidebarRefresh(true);
    });
  });

  sidebar.onMessage("signout", function() {
    log("Sidebar requested signout");
    authActionChain = authActionChain.then(function() {
      handleManualSignOut();
    }).catch(function(error) {
      log("Sidebar signout failed: " + errStr(error));
      persistAuthStatus();
      queueSidebarRefresh(true);
    });
  });

  sidebar.onMessage("toggle_scrobbling", function(payload) {
    var enabled = !(payload && payload.enabled === false);
    log("Sidebar requested scrobbling " + (enabled ? "enable" : "disable"));
    setScrobblingEnabled(enabled);
  });

  sidebar.onMessage("refresh", function() {
    log("Sidebar requested refresh");
    queueSidebarRefresh(true);
  });

  sidebar.onMessage("copy_auth_code", function() {
    Promise.resolve().then(async function() {
      var result = { ok: false, message: "No active code." };
      if (typeof trakt.copyPendingAuthCode === "function") {
        result = await trakt.copyPendingAuthCode();
      }
      try {
        sidebar.postMessage("copy_auth_result", result);
      } catch (_error) {}
    }).catch(function(error) {
      log("Sidebar auth code copy failed: " + errStr(error));
      try {
        sidebar.postMessage("copy_auth_result", {
          ok: false,
          message: "Copy failed. Copy manually."
        });
      } catch (_error) {}
    });
  });
}

function initializeSidebar() {
  if (!sidebar || typeof sidebar.loadFile !== "function") {
    return;
  }

  sidebarHandlersBound = false;
  sidebar.loadFile("sidebar.html");
  bindSidebarMessaging();
  queueSidebarRefresh(true);
}

function wrapEvent(label, fn) {
  return async function() {
    try {
      return await fn();
    } catch (error) {
      var message = label + " failed: " + errStr(error);
      log(message);
      importantOsd(message);
    }
  };
}

function getCurrentSource() {
  return {
    url: String(core.status.url || ""),
    title: String(core.status.title || "")
  };
}

async function runManualAuth(force) {
  var status = trakt.getAuthStatus();
  showSidebarTab();
  persistAuthStatus({
    state: "authorizing",
    summary: force ? "Reconnecting to Trakt" : "Waiting for Trakt authorization",
    detail: "Complete the confirmation in your browser.",
    busy: true,
    connected: false,
    credentialMode: status.credentialMode
  });
  queueSidebarRefresh(true);

  try {
    await trakt.beginInteractiveAuth({
      force: !!force,
      showDialog: true
    });
    authRequiredNoticeShown = false;
    persistAuthStatus();
    queueSidebarRefresh(true);
    resyncCurrentPlaybackAfterAuth();
    importantOsd("Trakt connected");
    log("Manual Trakt auth completed");
  } catch (error) {
    persistAuthStatus();
    queueSidebarRefresh(true);
    importantOsd("Trakt authorization failed");
    log("Manual Trakt auth failed: " + errStr(error));
  }
}

function handleManualSignOut() {
  trakt.signOut();
  authRequiredNoticeShown = false;
  persistAuthStatus();
  queueSidebarRefresh(true);
  importantOsd("Trakt signed out");
  log("Trakt token cleared");
}

function checkAuthActionRequest() {
  var nonce = String(preferences.get("auth_action_nonce") || "");
  if (!nonce || nonce === lastHandledAuthActionNonce) {
    return;
  }

  lastHandledAuthActionNonce = nonce;
  var action = String(preferences.get("auth_action_kind") || "");
  persistPreferences({
    auth_action_kind: "",
    auth_action_nonce: ""
  });

  if (!action) {
    return;
  }

  authActionChain = authActionChain.then(async function() {
    if (action === "show_sidebar") {
      log("Preferences requested sidebar show");
      showSidebarTab();
      queueSidebarRefresh(true);
      return;
    }

    if (action === "connect") {
      var force = trakt.getAuthStatus().state === "connected";
      await runManualAuth(force);
      return;
    }

    if (action === "signout") {
      handleManualSignOut();
    }
  }).catch(function(error) {
    log("Auth action failed: " + errStr(error));
    persistAuthStatus();
  });
}

function parsedLabel(parsed) {
  if (!parsed) return "unparsed";
  if (parsed.kind === "episode") {
    return parsed.showTitle + " S" + parsed.season + "E" + parsed.episode;
  }
  return parsed.title || parsed.kind;
}

function isScrobblingEnabled() {
  return prefBool("scrobble_enabled", true);
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function mediaInfoFromParsed(parsed) {
  if (!parsed) return null;
  if (parsed.kind === "movie") {
    return {
      type: "movie",
      title: parsed.title,
      year: parsed.year || null
    };
  }

  if (parsed.kind === "episode") {
    return {
      type: "episode",
      title: parsed.showTitle,
      showTitle: parsed.showTitle,
      year: parsed.year || null,
      season: parsed.season,
      episode: parsed.episode,
      episodeTitle: parsed.episodeTitle || ""
    };
  }

  return null;
}

function mediaLabel(mediaInfo) {
  if (!mediaInfo) return "unknown media";
  if (mediaInfo.type === "episode") {
    var suffix = mediaInfo.episodeTitle ? (" - " + mediaInfo.episodeTitle) : "";
    return mediaInfo.showTitle + " S" + pad2(mediaInfo.season) + "E" + pad2(mediaInfo.episode) + suffix;
  }
  return mediaInfo.title + (mediaInfo.year ? (" (" + mediaInfo.year + ")") : "");
}

function cloneMediaInfo(mediaInfo) {
  if (!mediaInfo) return null;
  return {
    type: mediaInfo.type,
    title: mediaInfo.title,
    showTitle: mediaInfo.showTitle,
    year: mediaInfo.year,
    season: mediaInfo.season,
    episode: mediaInfo.episode,
    episodeTitle: mediaInfo.episodeTitle
  };
}

function cloneSnapshot(snapshot) {
  if (!snapshot) return null;
  return {
    state: snapshot.state,
    duration: snapshot.duration,
    position: snapshot.position,
    progress: snapshot.progress,
    updatedAt: snapshot.updatedAt,
    mediaInfo: cloneMediaInfo(snapshot.mediaInfo)
  };
}

function createResumableTimer(timeoutMs, callback) {
  var remainingMs = timeoutMs;
  var startedAt = 0;
  var timerId = null;

  function clear() {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  }

  function schedule() {
    clear();
    startedAt = Date.now();
    timerId = setTimeout(function() {
      timerId = null;
      callback();
    }, remainingMs);
  }

  return {
    start: function() {
      remainingMs = timeoutMs;
      schedule();
    },
    pause: function() {
      if (timerId === null) return;
      remainingMs = Math.max(0, remainingMs - (Date.now() - startedAt));
      clear();
    },
    resume: function() {
      if (timerId !== null) return;
      schedule();
    },
    cancel: function() {
      clear();
    }
  };
}

function playbackConfig() {
  return {
    skipInterval: prefNumber("skip_interval", 5),
    previewThreshold: prefNumber("preview_threshold", 80),
    previewDuration: prefNumber("preview_duration", 60),
    fastPauseThreshold: prefNumber("fast_pause_threshold", 1),
    fastPauseDuration: prefNumber("fast_pause_duration", 5)
  };
}

function identifyCurrentMedia() {
  var source = getCurrentSource();
  appendDebugLog("[IINATraktScrobbler] Parser attempt source=" + (source.url || source.title || ""));
  var parsed = parser.parseMediaFromSource(source.url, source.title);
  logGuessitFailureOnce();
  currentMedia = parsed ? {
    source: source,
    parsed: parsed,
    mediaInfo: mediaInfoFromParsed(parsed),
    identifiedAt: new Date().toISOString()
  } : null;

  if (!parsed) {
    lastScrobbleStatus = createScrobbleStatus();
    setScrobbleStatus({
      status: "idle",
      verb: "",
      mediaLabel: "",
      detail: "The current file could not be classified."
    });
    log("Could not classify current media");
    debugOsd("Could not classify current media");
    return;
  }

  setScrobbleStatus({
    status: isScrobblingEnabled() ? "ready" : "disabled",
    verb: "",
    mediaLabel: currentMedia && currentMedia.mediaInfo ? mediaLabel(currentMedia.mediaInfo) : parsedLabel(parsed),
    detail: isScrobblingEnabled() ? "Watching for playback changes." : "Scrobbling is turned off.",
    reason: isScrobblingEnabled() ? "" : "disabled"
  });
  log("Parsed " + parsedLabel(parsed) + " via " + (parsed.parserSource || "unknown"));
  debugOsd("Parsed " + parsedLabel(parsed));
}

function clearTimer(name) {
  var timer = playbackState[name];
  if (timer && typeof timer.cancel === "function") {
    timer.cancel();
  }
  playbackState[name] = null;
}

function exitPreview() {
  if (!playbackState.preview) return;
  playbackState.preview = false;
  playbackState.scrobbleBuffer = null;
  clearTimer("previewTimer");
  log("Preview mode ended");
}

function exitFastPause() {
  if (!playbackState.fastPause) return;
  playbackState.fastPause = false;
  playbackState.scrobbleBuffer = null;
  clearTimer("fastPauseTimer");
  log("Fast-pause mode ended");
}

function resetPlaybackTracking() {
  exitPreview();
  exitFastPause();
  playbackState.prevSnapshot = null;
  playbackState.scrobbleBuffer = null;
  playbackState.lastScrobbleKey = "";
  playbackState.preview = false;
  playbackState.fastPause = false;
}

function buildLiveSnapshot() {
  if (!currentMedia || !currentMedia.mediaInfo) {
    return null;
  }

  var duration = Number(core.status.duration || 0);
  if (!isFinite(duration) || duration <= 0) {
    return null;
  }

  var position = Number(core.status.position || 0);
  if (!isFinite(position)) position = 0;
  if (position < 0) position = 0;
  if (position > duration) position = duration;

  var state = core.status.idle
    ? monitor.State.Stopped
    : (core.status.paused ? monitor.State.Paused : monitor.State.Playing);

  return {
    state: state,
    duration: duration,
    position: position,
    progress: monitor.computeProgress(position, duration),
    updatedAt: Date.now() / 1000,
    mediaInfo: cloneMediaInfo(currentMedia.mediaInfo)
  };
}

function buildStoppedSnapshot(prevSnapshot) {
  if (!prevSnapshot) return null;
  return {
    state: monitor.State.Stopped,
    duration: prevSnapshot.duration,
    position: prevSnapshot.position,
    progress: prevSnapshot.progress,
    updatedAt: Date.now() / 1000,
    mediaInfo: cloneMediaInfo(prevSnapshot.mediaInfo)
  };
}

function resyncCurrentPlayback(logMessage) {
  var snapshot = buildLiveSnapshot();
  if (!snapshot || !snapshot.mediaInfo || snapshot.state === monitor.State.Stopped) {
    return;
  }

  playbackState.lastScrobbleKey = "";
  if (logMessage) {
    log(logMessage);
  }
  queueScrobble(monitor.stateVerb(snapshot.state), snapshot);
}

function resyncCurrentPlaybackAfterAuth() {
  resyncCurrentPlayback("Re-syncing current playback after Trakt auth");
}

function setScrobblingEnabled(enabled) {
  var nextValue = !!enabled;
  var prevValue = isScrobblingEnabled();
  if (nextValue === prevValue) {
    queueSidebarRefresh(false);
    return;
  }

  persistPreferences({
    scrobble_enabled: nextValue
  });

  resetPlaybackTracking();
  playbackState.lastScrobbleKey = "";

  if (nextValue) {
    log("Trakt scrobbling enabled");
    importantOsd("Trakt scrobbling enabled");
    if (currentMedia && currentMedia.mediaInfo) {
      setScrobbleStatus({
        status: "ready",
        verb: "",
        mediaLabel: mediaLabel(currentMedia.mediaInfo),
        detail: "Watching for playback changes.",
        reason: ""
      });
    } else {
      setScrobbleStatus(createScrobbleStatus());
    }
    resyncCurrentPlayback("Re-syncing current playback after enabling scrobbling");
    return;
  }

  log("Trakt scrobbling disabled");
  importantOsd("Trakt scrobbling paused");
  setScrobbleStatus({
    status: "disabled",
    verb: "",
    mediaLabel: currentMedia && currentMedia.mediaInfo ? mediaLabel(currentMedia.mediaInfo) : "",
    detail: "Scrobbling is turned off.",
    reason: "disabled",
    progress: null
  });
}

function queueScrobble(verb, snapshot) {
  if (!isScrobblingEnabled()) {
    setScrobbleStatus({
      status: "disabled",
      verb: "",
      mediaLabel: snapshot && snapshot.mediaInfo ? mediaLabel(snapshot.mediaInfo) : "",
      detail: "Scrobbling is turned off.",
      reason: "disabled",
      progress: null
    });
    return;
  }

  var payload = cloneSnapshot(snapshot);
  if (!payload || !payload.mediaInfo) {
    return;
  }

  var scrobbleKey = [
    verb,
    monitor.mediaKey(payload.mediaInfo),
    String(Math.round(payload.progress * 100) / 100)
  ].join("|");

  if (playbackState.lastScrobbleKey === scrobbleKey) {
    return;
  }

  playbackState.lastScrobbleKey = scrobbleKey;
  setScrobbleStatus({
    status: "queued",
    verb: verb,
    mediaLabel: mediaLabel(payload.mediaInfo),
    detail: "Queued for Trakt at " + payload.progress.toFixed(2) + "%.",
    reason: "",
    progress: payload.progress
  });
  log("Scrobble " + verb + " queued for " + mediaLabel(payload.mediaInfo) + " at " + payload.progress.toFixed(2) + "%");
  playbackState.scrobbleChain = playbackState.scrobbleChain.then(async function() {
    setScrobbleStatus({
      status: "sending",
      verb: verb,
      mediaLabel: mediaLabel(payload.mediaInfo),
      detail: "Sending " + verb + " to Trakt.",
      reason: "",
      progress: payload.progress
    });

    try {
      var result = await trakt.scrobble(verb, payload.mediaInfo, payload.progress);
      if (result && result.ok) {
        setScrobbleStatus({
          status: "succeeded",
          verb: verb,
          mediaLabel: mediaLabel(payload.mediaInfo),
          detail: "Trakt accepted the " + verb + " scrobble.",
          reason: "",
          progress: payload.progress
        });
        log("Scrobble " + verb + " succeeded for " + mediaLabel(payload.mediaInfo));
        maybeShowScrobbleStatusOsd(verb);
        if (!firstScrobbleNoticeShown) {
          debugOsd("Scrobble flow active");
          firstScrobbleNoticeShown = true;
        }
        return;
      }

      if (result && result.skip) {
        if (result.reason === "missing-client-credentials" && !missingCredentialsNoticeShown) {
          importantOsd("Configure Trakt app credentials for this build");
          missingCredentialsNoticeShown = true;
        }
        if (result.reason === "auth-required" && !authRequiredNoticeShown) {
          importantOsd("Connect Trakt from the sidebar to start scrobbling");
          authRequiredNoticeShown = true;
        }
        setScrobbleStatus({
          status: "skipped",
          verb: verb,
          mediaLabel: mediaLabel(payload.mediaInfo),
          reason: result.reason,
          detail: result.reason === "auth-required"
            ? "Scrobble skipped until you connect Trakt from the sidebar."
            : ("Scrobble skipped: " + result.reason),
          progress: payload.progress
        });
        log("Scrobble skipped for " + mediaLabel(payload.mediaInfo) + ": " + result.reason);
        return;
      }

      if (result && result.duplicate) {
        setScrobbleStatus({
          status: "duplicate",
          verb: verb,
          mediaLabel: mediaLabel(payload.mediaInfo),
          detail: "Trakt reported this scrobble as a duplicate.",
          reason: "",
          progress: payload.progress
        });
        log("Scrobble duplicate ignored for " + mediaLabel(payload.mediaInfo));
        return;
      }

      if (result && result.notFound) {
        setScrobbleStatus({
          status: "unmatched",
          verb: verb,
          mediaLabel: mediaLabel(payload.mediaInfo),
          detail: "Trakt could not match this media identity.",
          reason: "missing-trakt-match",
          progress: payload.progress
        });
        log("Trakt rejected the scrobble because the media was not found: " + mediaLabel(payload.mediaInfo));
        return;
      }

      setScrobbleStatus({
        status: "unknown",
        verb: verb,
        mediaLabel: mediaLabel(payload.mediaInfo),
        detail: "Trakt returned no actionable result.",
        reason: "",
        progress: payload.progress
      });
      log("Scrobble returned no actionable result for " + mediaLabel(payload.mediaInfo));
    } catch (error) {
      setScrobbleStatus({
        status: "failed",
        verb: verb,
        mediaLabel: mediaLabel(payload.mediaInfo),
        detail: errStr(error),
        reason: "",
        progress: payload.progress
      });
      log("Scrobble failed for " + mediaLabel(payload.mediaInfo) + ": " + errStr(error));
      if (/Missing Trakt client credentials/.test(errStr(error)) && !missingCredentialsNoticeShown) {
        importantOsd("Configure Trakt app credentials for this build");
        missingCredentialsNoticeShown = true;
      }
    } finally {
      persistAuthStatus();
      queueSidebarRefresh(false);
    }
  }).catch(function(error) {
    setScrobbleStatus({
      status: "failed",
      verb: verb,
      mediaLabel: mediaLabel(payload.mediaInfo),
      detail: errStr(error),
      reason: "",
      progress: payload.progress
    });
    log("Scrobble queue failure: " + errStr(error));
  });
}

async function flushScrobbleQueue(reason, timeoutMs) {
  var timeout = Math.max(0, Number(timeoutMs || 0));
  var label = reason ? (" for " + reason) : "";
  if (timeout > 0) {
    log("Waiting up to " + timeout + "ms for pending scrobbles" + label);
  } else {
    log("Waiting for pending scrobbles" + label);
  }

  var chain = playbackState.scrobbleChain.catch(function(error) {
    log("Pending scrobble flush saw error: " + errStr(error));
  });

  if (!timeout) {
    await chain;
    return;
  }

  await Promise.race([
    chain,
    new Promise(function(resolve) {
      setTimeout(resolve, timeout);
    })
  ]);
}

function delayedScrobble(cleanup) {
  if (playbackState.scrobbleBuffer) {
    var buffered = cloneSnapshot(playbackState.scrobbleBuffer);
    queueScrobble(monitor.stateVerb(buffered.state), buffered);
  }
  if (typeof cleanup === "function") {
    cleanup();
  }
}

function executeAction(action, prevSnapshot, currentSnapshot) {
  if (action === "scrobble") {
    queueScrobble(monitor.stateVerb(currentSnapshot.state), currentSnapshot);
    return;
  }

  if (action === "stop_previous") {
    queueScrobble("stop", prevSnapshot);
    return;
  }

  if (action === "exit_preview") {
    exitPreview();
    return;
  }

  if (action === "enter_preview") {
    exitPreview();
    playbackState.preview = true;
    playbackState.scrobbleBuffer = cloneSnapshot(currentSnapshot);
    playbackState.previewTimer = createResumableTimer(playbackConfig().previewDuration * 1000, function() {
      delayedScrobble(exitPreview);
    });
    playbackState.previewTimer.start();
    log("Entered preview mode for " + mediaLabel(currentSnapshot.mediaInfo));
    return;
  }

  if (action === "pause_preview") {
    playbackState.scrobbleBuffer = cloneSnapshot(currentSnapshot);
    if (playbackState.previewTimer) {
      playbackState.previewTimer.pause();
    }
    return;
  }

  if (action === "resume_preview") {
    playbackState.scrobbleBuffer = cloneSnapshot(currentSnapshot);
    if (playbackState.previewTimer) {
      playbackState.previewTimer.resume();
    }
    return;
  }

  if (action === "enter_fast_pause") {
    playbackState.fastPause = true;
    playbackState.scrobbleBuffer = cloneSnapshot(currentSnapshot);
    clearTimer("fastPauseTimer");
    playbackState.fastPauseTimer = createResumableTimer(playbackConfig().fastPauseDuration * 1000, function() {
      delayedScrobble(exitFastPause);
    });
    playbackState.fastPauseTimer.start();
    log("Entered fast-pause mode");
    return;
  }

  if (action === "clear_buf") {
    clearTimer("fastPauseTimer");
    playbackState.scrobbleBuffer = null;
    return;
  }

  if (action === "delayed_play") {
    clearTimer("fastPauseTimer");
    playbackState.scrobbleBuffer = cloneSnapshot(currentSnapshot);
    playbackState.fastPauseTimer = createResumableTimer(playbackConfig().fastPauseDuration * 1000, function() {
      delayedScrobble(exitFastPause);
    });
    playbackState.fastPauseTimer.start();
    return;
  }

  if (action === "exit_fast_pause") {
    exitFastPause();
    return;
  }

  if (action === "ignore") {
    log("Ignoring transition for " + mediaLabel(currentSnapshot && currentSnapshot.mediaInfo));
    return;
  }

  log("Unhandled action: " + action);
}

function processTransition(prevSnapshot, currentSnapshot, reason) {
  var actions = monitor.decideActions(prevSnapshot, currentSnapshot, {
    preview: playbackState.preview,
    fastPause: playbackState.fastPause
  }, playbackConfig());

  if (!actions.length) {
    return;
  }

  log("Transition " + reason + ": " + actions.join(", "));
  actions.forEach(function(action) {
    executeAction(action, prevSnapshot, currentSnapshot);
  });
}

function handleStatusUpdate(reason) {
  if (!currentMedia || !currentMedia.mediaInfo) {
    queueSidebarRefresh(false);
    return;
  }

  var currentSnapshot = buildLiveSnapshot();
  if (!currentSnapshot) {
    queueSidebarRefresh(false);
    return;
  }

  var prevSnapshot = playbackState.prevSnapshot;
  processTransition(prevSnapshot, currentSnapshot, reason || "status");
  playbackState.prevSnapshot = currentSnapshot;
  queueSidebarRefresh(false);
}

async function finalizeCurrentMedia(reason) {
  if (!playbackState.prevSnapshot) {
    currentMedia = null;
    lastSourceSignature = "";
    resetPlaybackTracking();
    setScrobbleStatus({
      status: "idle",
      verb: "",
      mediaLabel: "",
      detail: "Waiting for playback."
    });
    return;
  }

  var prevSnapshot = playbackState.prevSnapshot;
  var stoppedSnapshot = buildStoppedSnapshot(prevSnapshot);
  processTransition(prevSnapshot, stoppedSnapshot, reason || "stop");
  playbackState.prevSnapshot = stoppedSnapshot;
  currentMedia = null;
  lastSourceSignature = "";
  queueSidebarRefresh(false);
  if (reason === "end-file") {
    await flushScrobbleQueue("end-file", 2500);
  }
  resetPlaybackTracking();
  queueSidebarRefresh(false);
}

function scheduleBootstrapTicks() {
  [250, 1000, 2000].forEach(function(delayMs) {
    setTimeout(function() {
      handleStatusUpdate("bootstrap:" + delayMs);
    }, delayMs);
  });
}

function ensurePollTimer() {
  if (pollTimer !== null) return;
  pollTimer = setInterval(function() {
    handleStatusUpdate("poll");
  }, POLL_INTERVAL_MS);
}

function ensureUiPollTimer() {
  if (uiPollTimer !== null) return;
  uiPollTimer = setInterval(function() {
    if (trakt.getAuthStatus().busy) {
      persistAuthStatus();
    }
    checkAuthActionRequest();
    queueSidebarRefresh(false);
  }, UI_POLL_INTERVAL_MS);
}

async function handleFileLoaded() {
  var source = getCurrentSource();
  var signature = source.url || source.title;
  if (signature && signature === lastSourceSignature && currentMedia) {
    return;
  }

  if (currentMedia && lastSourceSignature && signature && signature !== lastSourceSignature) {
    await finalizeCurrentMedia("new-file");
  } else {
    resetPlaybackTracking();
    currentMedia = null;
  }

  lastSourceSignature = signature;
  missingCredentialsNoticeShown = false;
  authRequiredNoticeShown = false;
  identifyCurrentMedia();
  scheduleBootstrapTicks();
}

appendDebugLog("[IINATraktScrobbler] --------------------------------------------------");
appendDebugLog("[IINATraktScrobbler] Session start");
log("Plugin main loaded");
appendDebugLog("[IINATraktScrobbler] Parser mode default=guessit-with-heuristic-fallback");
persistAuthStatus();
registerMenuItems();
ensurePollTimer();
ensureUiPollTimer();

event.on("iina.window-loaded", wrapEvent("iina.window-loaded", function() {
  initializeSidebar();
  debugOsd("Plugin loaded");
}));

event.on("iina.file-loaded", wrapEvent("iina.file-loaded", function() {
  return handleFileLoaded();
}));

event.on("mpv.pause.changed", wrapEvent("mpv.pause.changed", function() {
  handleStatusUpdate("pause.changed");
}));

event.on("mpv.time-pos.changed", wrapEvent("mpv.time-pos.changed", function() {
  handleStatusUpdate("time-pos.changed");
}));

event.on("mpv.duration.changed", wrapEvent("mpv.duration.changed", function() {
  handleStatusUpdate("duration.changed");
}));

event.on("mpv.end-file", wrapEvent("mpv.end-file", function() {
  return finalizeCurrentMedia("end-file");
}));
