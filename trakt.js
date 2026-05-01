var traktKeys = require("./trakt_keys.js");

var API_ROOT = "https://api.trakt.tv";
var DEVICE_CODE_PATH = "/oauth/device/code";
var DEVICE_TOKEN_PATH = "/oauth/device/token";
var TOKEN_PATH = "/oauth/token";
var USER_SETTINGS_PATH = "/users/settings";
var TOKEN_FALLBACK_PATH = "@data/trakt-token.json";
var CACHE_PATH = "@data/trakt-cache.json";
var KEYCHAIN_SERVICE = "io.github.fahim.iinatraktscrobbler";
var KEYCHAIN_ACCOUNT = "trakt-oauth";
var AUTH_COOLDOWN_MS = 30000;
var TOKEN_REFRESH_MARGIN_SECONDS = 60;
var SEARCH_SCORE_THRESHOLD = 5;
var PROFILE_CACHE_TTL_MS = 5 * 60 * 1000;
var AUTH_REQUIRED_ERROR = "Trakt authorization required";

var runtime = {
  file: null,
  preferences: null,
  utils: null,
  logger: function() {},
  notify: function() {},
  tokenCache: undefined,
  searchCache: null,
  authPromise: null,
  authPrompt: "",
  authCode: "",
  authUrl: "",
  lastAuthFailureAt: 0,
  lastAuthFailureMessage: "",
  loggedCredentialMode: false,
  viewerProfile: null,
  viewerProfileFetchedAt: 0
};

function configure(options) {
  var settings = options || {};
  if (settings.file) runtime.file = settings.file;
  if (settings.preferences) runtime.preferences = settings.preferences;
  if (settings.utils) runtime.utils = settings.utils;
  if (typeof settings.logger === "function") runtime.logger = settings.logger;
  if (typeof settings.notify === "function") runtime.notify = settings.notify;
}

function log(message) {
  runtime.logger(String(message || ""));
}

function notify(message) {
  runtime.notify(String(message || ""));
}

function pref(key, fallbackValue) {
  if (!runtime.preferences) return fallbackValue;
  var value = runtime.preferences.get(key);
  return value === undefined || value === null ? fallbackValue : value;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function sleep(ms) {
  return new Promise(function(resolve) {
    setTimeout(resolve, ms);
  });
}

function readJson(path, fallbackValue) {
  if (!runtime.file || !runtime.file.exists(path)) {
    return fallbackValue;
  }

  try {
    return JSON.parse(runtime.file.read(path) || "null");
  } catch (_error) {
    return fallbackValue;
  }
}

function writeJson(path, value) {
  if (!runtime.file) return;
  runtime.file.write(path, JSON.stringify(value, null, 2));
}

function getClientId() {
  return traktKeys.getId() || String(pref("trakt_client_id", "") || "").trim();
}

function getClientSecret() {
  return traktKeys.getSecret() || String(pref("trakt_client_secret", "") || "").trim();
}

function hasCredentials() {
  return !!(getClientId() && getClientSecret());
}

function usingEmbeddedCredentials() {
  return traktKeys.hasEmbeddedCredentials();
}

function credentialMode() {
  if (usingEmbeddedCredentials()) return "bundled";
  if (hasCredentials()) return "override";
  return "missing";
}

function createAuthStatus(state, summary, detail, busy, extras) {
  var status = {
    state: state,
    summary: summary,
    detail: detail || "",
    busy: !!busy,
    connected: state === "connected",
    credentialMode: credentialMode()
  };

  Object.keys(extras || {}).forEach(function(key) {
    status[key] = extras[key];
  });

  return status;
}

function createAuthRequiredError() {
  return new Error(AUTH_REQUIRED_ERROR);
}

function isAuthRequiredError(error) {
  return !!error && String(error.message || error) === AUTH_REQUIRED_ERROR;
}

function clearViewerProfileCache() {
  runtime.viewerProfile = null;
  runtime.viewerProfileFetchedAt = 0;
}

function getTokenInfo() {
  var token = loadToken();
  if (!token || !token.access_token) {
    return null;
  }

  var createdAtSeconds = Number(token.created_at || 0);
  var expiresInSeconds = Number(token.expires_in || 0);
  var createdAtMs = createdAtSeconds > 0 ? (createdAtSeconds * 1000) : 0;
  var expiresAtMs = createdAtMs && expiresInSeconds
    ? (createdAtMs + (expiresInSeconds * 1000))
    : 0;
  var remainingSeconds = expiresAtMs
    ? Math.floor((expiresAtMs - Date.now()) / 1000)
    : 0;

  return {
    createdAt: createdAtMs ? new Date(createdAtMs).toISOString() : "",
    expiresAt: expiresAtMs ? new Date(expiresAtMs).toISOString() : "",
    expiresInSeconds: remainingSeconds,
    expired: isTokenExpired(token)
  };
}

function readTokenFromKeychain() {
  if (!runtime.utils || typeof runtime.utils.keyChainRead !== "function") {
    return "";
  }

  try {
    return runtime.utils.keyChainRead(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) || "";
  } catch (_error) {
    return "";
  }
}

function writeTokenToKeychain(rawValue) {
  if (!runtime.utils || typeof runtime.utils.keyChainWrite !== "function") {
    return false;
  }

  try {
    return runtime.utils.keyChainWrite(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, rawValue);
  } catch (_error) {
    return false;
  }
}

function loadToken() {
  if (runtime.tokenCache !== undefined) {
    return runtime.tokenCache;
  }

  var rawToken = readTokenFromKeychain();
  if (!rawToken) {
    rawToken = runtime.file && runtime.file.exists(TOKEN_FALLBACK_PATH)
      ? (runtime.file.read(TOKEN_FALLBACK_PATH) || "")
      : "";
  }

  if (!rawToken) {
    runtime.tokenCache = null;
    return runtime.tokenCache;
  }

  try {
    runtime.tokenCache = JSON.parse(rawToken);
  } catch (_error) {
    runtime.tokenCache = null;
  }

  return runtime.tokenCache;
}

function saveToken(token) {
  runtime.tokenCache = token || null;
  clearViewerProfileCache();
  var rawValue = JSON.stringify(runtime.tokenCache || {});
  if (!writeTokenToKeychain(rawValue)) {
    log("Warning: keychain write failed, falling back to @data token storage");
  }
  if (runtime.file) {
    runtime.file.write(TOKEN_FALLBACK_PATH, rawValue);
  }
}

function clearToken() {
  runtime.tokenCache = null;
  runtime.lastAuthFailureAt = 0;
  runtime.lastAuthFailureMessage = "";
  runtime.authCode = "";
  runtime.authUrl = "";
  clearViewerProfileCache();
  writeTokenToKeychain("");
  if (runtime.file) {
    runtime.file.write(TOKEN_FALLBACK_PATH, "");
  }
}

function isTokenExpired(token) {
  if (!token || !token.created_at || !token.expires_in) {
    return true;
  }

  var expiresAt = Number(token.created_at || 0) + Number(token.expires_in || 0) - TOKEN_REFRESH_MARGIN_SECONDS;
  return expiresAt <= nowSeconds();
}

function parseJson(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_error) {
    return {};
  }
}

function escapeAppleScriptString(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

async function copyToClipboard(text) {
  if (!runtime.utils || typeof runtime.utils.exec !== "function") {
    return false;
  }

  try {
    await runtime.utils.exec("/usr/bin/osascript", [
      "-e",
      'set the clipboard to "' + escapeAppleScriptString(text) + '"'
    ]);
    return true;
  } catch (_error) {
    return false;
  }
}

async function showManualAuthDialog(userCode, verificationUrl) {
  if (!runtime.utils || typeof runtime.utils.exec !== "function") {
    return false;
  }

  var script =
    'display dialog "Enter this code to authenticate with Trakt:"' +
    ' & linefeed & linefeed & "' + escapeAppleScriptString(userCode) + '"' +
    ' buttons {"OK"} default button "OK" with title "Trakt Scrobbler"';

  try {
    await runtime.utils.exec("/usr/bin/osascript", [
      "-e",
      script
    ]);
    return true;
  } catch (_error) {
    return false;
  }
}

async function copyPendingAuthCode() {
  if (!runtime.authCode) {
    return {
      ok: false,
      message: "No active code."
    };
  }

  var copied = await copyToClipboard(runtime.authCode);
  return copied
    ? { ok: true, message: "Code copied." }
    : { ok: false, message: "Copy failed. Copy manually." };
}

function encodeQuery(params) {
  var keys = Object.keys(params || {}).filter(function(key) {
    var value = params[key];
    return value !== undefined && value !== null && value !== "";
  });

  if (!keys.length) {
    return "";
  }

  return keys.map(function(key) {
    return encodeURIComponent(key) + "=" + encodeURIComponent(String(params[key]));
  }).join("&");
}

async function rawRequest(method, path, options) {
  if (!runtime.utils || typeof runtime.utils.exec !== "function") {
    throw new Error("utils.exec is unavailable");
  }

  var settings = options || {};
  var query = encodeQuery(settings.query || {});
  var url = API_ROOT + path + (query ? ("?" + query) : "");
  var marker = "__IINA_TRAKT_STATUS__:";
  var args = [
    "-sS",
    "-L",
    "-X", String(method || "GET").toUpperCase(),
    "-H", "Accept: application/json"
  ];

  Object.keys(settings.headers || {}).forEach(function(name) {
    args.push("-H", name + ": " + settings.headers[name]);
  });

  if (settings.body !== undefined) {
    args.push("--data", JSON.stringify(settings.body));
  }

  args.push("-w", "\n" + marker + "%{http_code}");
  args.push(url);

  log("HTTP " + String(method || "GET").toUpperCase() + " " + url);
  var response = await runtime.utils.exec("/usr/bin/curl", args);
  var stdout = response.stdout || "";
  var stderr = response.stderr || "";
  var markerIndex = stdout.lastIndexOf(marker);
  var rawBody = markerIndex >= 0 ? stdout.slice(0, markerIndex).trim() : stdout.trim();
  var statusCode = markerIndex >= 0 ? parseInt(stdout.slice(markerIndex + marker.length).trim(), 10) : 0;
  var body = parseJson(rawBody);

  if (response.status !== 0) {
    throw new Error(stderr || ("curl failed with status " + response.status));
  }

  return {
    statusCode: statusCode,
    body: body,
    rawBody: rawBody,
    url: url
  };
}

function getAuthStatus() {
  var mode = credentialMode();
  var token = loadToken();
  var tokenInfo = getTokenInfo();

  if (runtime.authPromise) {
    return createAuthStatus(
      "authorizing",
      "Waiting for Trakt authorization",
      runtime.authPrompt || "Complete the confirmation in your browser.",
      true,
      {
        deviceCode: runtime.authCode || "",
        verificationUrl: runtime.authUrl || "",
        token: tokenInfo
      }
    );
  }

  if (mode === "missing") {
    return createAuthStatus(
      "missing_credentials",
      "Trakt credentials unavailable",
      "This build has no bundled credentials and no local override is set.",
      false,
      {
        token: tokenInfo
      }
    );
  }

  if (token && token.access_token) {
    return createAuthStatus(
      "connected",
      "Connected to Trakt",
      mode === "bundled"
        ? "Using bundled Trakt app credentials."
        : "Using local Trakt credential override.",
      false,
      {
        token: tokenInfo
      }
    );
  }

  if (runtime.lastAuthFailureMessage) {
    return createAuthStatus(
      "error",
      "Trakt authorization failed",
      runtime.lastAuthFailureMessage,
      false,
      {
        token: tokenInfo
      }
    );
  }

  return createAuthStatus(
    "disconnected",
    "Not connected to Trakt",
    "Use Connect to start device authorization.",
    false,
    {
      token: tokenInfo
    }
  );
}

function normalizeViewerProfile(body) {
  var payload = body || {};
  var user = payload.user || payload.account || payload;
  var ids = user && user.ids ? user.ids : {};
  var username = String(
    (user && (user.username || user.slug)) ||
    ids.slug ||
    payload.username ||
    ""
  ).trim();

  if (!username) {
    return null;
  }

  var joinedAt =
    (payload.account && payload.account.joined_at) ||
    user.joined_at ||
    "";

  return {
    username: username,
    name: String((user && user.name) || payload.name || "").trim(),
    vip: !!((user && user.vip) || (payload.account && payload.account.vip)),
    joinedAt: joinedAt || ""
  };
}

async function getViewerProfile(options) {
  var settings = options || {};
  var authStatus = getAuthStatus();
  if (!authStatus.connected) {
    return null;
  }

  if (!settings.force &&
      runtime.viewerProfileFetchedAt &&
      (Date.now() - runtime.viewerProfileFetchedAt) < PROFILE_CACHE_TTL_MS) {
    return runtime.viewerProfile;
  }

  var response;
  try {
    response = await authedRequest("GET", USER_SETTINGS_PATH);
  } catch (error) {
    runtime.viewerProfileFetchedAt = Date.now();
    throw error;
  }

  if (response.statusCode >= 400) {
    runtime.viewerProfileFetchedAt = Date.now();
    throw new Error(response.body.error_description || response.body.error || "Failed to load Trakt account details");
  }

  runtime.viewerProfile = normalizeViewerProfile(response.body);
  runtime.viewerProfileFetchedAt = Date.now();
  return runtime.viewerProfile;
}

function requiredHeaders(accessToken) {
  var headers = {
    "Content-Type": "application/json",
    "trakt-api-key": getClientId(),
    "trakt-api-version": "2"
  };

  if (accessToken) {
    headers.Authorization = "Bearer " + accessToken;
  }

  return headers;
}

async function refreshAccessToken(token) {
  var refreshToken = token && token.refresh_token;
  if (!refreshToken) {
    throw new Error("Refresh token is missing");
  }

  var response = await rawRequest("POST", TOKEN_PATH, {
    headers: {
      "Content-Type": "application/json"
    },
    body: {
      refresh_token: refreshToken,
      client_id: getClientId(),
      client_secret: getClientSecret(),
      redirect_uri: "urn:ietf:wg:oauth:2.0:oob",
      grant_type: "refresh_token"
    }
  });

  if (response.statusCode !== 200) {
    clearToken();
    throw new Error(response.body.error_description || response.body.error || "Trakt token refresh failed");
  }

  saveToken(response.body);
  log("Refreshed Trakt access token");
  return response.body.access_token;
}

async function runDeviceAuth(options) {
  var settings = options || {};
  var now = Date.now();
  if (runtime.lastAuthFailureAt && (now - runtime.lastAuthFailureAt) < AUTH_COOLDOWN_MS) {
    throw new Error(runtime.lastAuthFailureMessage || "Recent Trakt auth failure");
  }

  if (runtime.authPromise) {
    return runtime.authPromise;
  }

  runtime.authPromise = (async function() {
    if (!hasCredentials()) {
      throw new Error("Missing Trakt client credentials");
    }

    var codeResponse = await rawRequest("POST", DEVICE_CODE_PATH, {
      headers: {
        "Content-Type": "application/json"
      },
      body: {
        client_id: getClientId()
      }
    });

    if (codeResponse.statusCode !== 200) {
      throw new Error(codeResponse.body.error_description || codeResponse.body.error || "Failed to request Trakt device code");
    }

    var codeData = codeResponse.body || {};
    var verificationUrl = String(codeData.verification_url || "");
    var userCode = String(codeData.user_code || "");
    var deviceCode = String(codeData.device_code || "");
    var intervalMs = Math.max(1000, Number(codeData.interval || 5) * 1000);
    var expiresAt = Date.now() + (Math.max(1, Number(codeData.expires_in || 900)) * 1000);
    runtime.authPrompt = "Open " + verificationUrl + " and enter code " + userCode + ".";
    runtime.authCode = userCode;
    runtime.authUrl = verificationUrl;

    log("Trakt device auth started: open " + verificationUrl + " and enter code " + userCode);
    await copyToClipboard(userCode);
    notify("Trakt auth code " + userCode + " copied to clipboard");
    if (runtime.utils && typeof runtime.utils.open === "function") {
      try {
        runtime.utils.open(verificationUrl);
      } catch (_error) {}
    }
    if (settings.showDialog) {
      await showManualAuthDialog(userCode, verificationUrl);
    }

    while (Date.now() < expiresAt) {
      await sleep(intervalMs);
      var tokenResponse = await rawRequest("POST", DEVICE_TOKEN_PATH, {
        headers: {
          "Content-Type": "application/json"
        },
        body: {
          code: deviceCode,
          client_id: getClientId(),
          client_secret: getClientSecret()
        }
      });

      if (tokenResponse.statusCode === 200) {
        saveToken(tokenResponse.body);
        runtime.authPrompt = "";
        runtime.authCode = "";
        runtime.authUrl = "";
        runtime.lastAuthFailureAt = 0;
        runtime.lastAuthFailureMessage = "";
        notify("Trakt auth complete");
        log("Trakt device auth completed");
        return tokenResponse.body.access_token;
      }

      if (tokenResponse.statusCode === 400) {
        continue;
      }

      throw new Error(tokenResponse.body.error_description || tokenResponse.body.error || "Trakt device token exchange failed");
    }

    throw new Error("Timed out waiting for Trakt authorization");
  })();

  try {
    return await runtime.authPromise;
  } catch (error) {
    runtime.authPrompt = "";
    runtime.authCode = "";
    runtime.authUrl = "";
    runtime.lastAuthFailureAt = Date.now();
    runtime.lastAuthFailureMessage = error && error.message ? error.message : String(error);
    notify(runtime.lastAuthFailureMessage);
    throw error;
  } finally {
    runtime.authPrompt = "";
    runtime.authCode = "";
    runtime.authUrl = "";
    runtime.authPromise = null;
  }
}

async function ensureAccessToken(options) {
  var settings = options || {};
  if (!hasCredentials()) {
    throw new Error("Missing Trakt client credentials");
  }

  if (!runtime.loggedCredentialMode) {
    if (usingEmbeddedCredentials()) {
      log("Using bundled Trakt app credentials");
    } else {
      log("Using local Trakt credential overrides");
    }
    runtime.loggedCredentialMode = true;
  }

  var token = loadToken();
  if (token && !isTokenExpired(token)) {
    return token.access_token;
  }

  if (token && token.refresh_token) {
    try {
      return await refreshAccessToken(token);
    } catch (error) {
      log("Token refresh failed: " + (error && error.message ? error.message : String(error)));
      clearToken();
    }
  }

  if (settings.interactive) {
    return runDeviceAuth(settings);
  }

  throw createAuthRequiredError();
}

async function beginInteractiveAuth(options) {
  var settings = options || {};
  if (settings.force) {
    clearToken();
  }

  await ensureAccessToken({
    interactive: true,
    showDialog: !!settings.showDialog
  });
  return getAuthStatus();
}

async function authedRequest(method, path, options) {
  var settings = options || {};
  var token = await ensureAccessToken({
    interactive: !!settings.interactive,
    showDialog: !!settings.showDialog
  });
  var response = await rawRequest(method, path, {
    headers: Object.assign({}, requiredHeaders(token), settings.headers || {}),
    query: settings.query,
    body: settings.body
  });

  if (response.statusCode === 401) {
    clearToken();
    token = await ensureAccessToken({
      interactive: !!settings.interactive,
      showDialog: !!settings.showDialog
    });
    response = await rawRequest(method, path, {
      headers: Object.assign({}, requiredHeaders(token), settings.headers || {}),
      query: settings.query,
      body: settings.body
    });
  }

  return response;
}

function loadSearchCache() {
  if (runtime.searchCache) {
    return runtime.searchCache;
  }

  var cache = readJson(CACHE_PATH, null);
  if (!cache || typeof cache !== "object") {
    cache = {
      movie: {},
      show: {}
    };
  }
  if (!cache.movie) cache.movie = {};
  if (!cache.show) cache.show = {};
  runtime.searchCache = cache;
  return runtime.searchCache;
}

function saveSearchCache() {
  if (!runtime.searchCache) return;
  writeJson(CACHE_PATH, runtime.searchCache);
}

function searchCacheKey(title, year) {
  return String(title || "").trim().toLowerCase() + "|" + String(year || "").trim();
}

function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function readCachedTraktId(value) {
  if (value && typeof value === "object") {
    return Number(value.trakt || 0);
  }

  return Number(value || 0);
}

function isVerifiedEpisodeCacheEntry(value) {
  return !!(value && typeof value === "object" && value.verified === true && Number(value.trakt || 0) > 0);
}

function createVerifiedEpisodeCacheEntry(traktId) {
  return {
    trakt: Number(traktId || 0),
    verified: true
  };
}

function episodeIdentityLabel(mediaInfo) {
  return String(mediaInfo.showTitle || mediaInfo.title || "Unknown Show") +
    " S" + String(mediaInfo.season || "?") +
    "E" + String(mediaInfo.episode || "?");
}

function titlesMatch(expected, actual) {
  var left = normalizeTitle(expected);
  var right = normalizeTitle(actual);
  if (!left || !right) return false;
  return left === right;
}

async function search(query, type, year, limit) {
  var response = await authedRequest("GET", "/search/" + type, {
    query: {
      query: query,
      field: "title",
      years: year || undefined,
      page: 1,
      limit: limit || 1
    }
  });

  if (response.statusCode >= 400) {
    throw new Error(response.body.error_description || response.body.error || ("Trakt search failed with status " + response.statusCode));
  }

  return Array.isArray(response.body) ? response.body : [];
}

async function fetchEpisodeForShow(traktId, season, episode) {
  var response = await authedRequest("GET", "/shows/" + Number(traktId) + "/seasons/" + Number(season) + "/episodes/" + Number(episode));

  if (response.statusCode === 404) {
    return null;
  }

  if (response.statusCode >= 400) {
    throw new Error(response.body.error_description || response.body.error || ("Trakt episode lookup failed with status " + response.statusCode));
  }

  return response.body || null;
}

async function verifyEpisodeCandidate(traktId, mediaInfo) {
  var episode = await fetchEpisodeForShow(traktId, mediaInfo.season, mediaInfo.episode);
  if (!episode) {
    log("Trakt episode candidate rejected: show=" + traktId + " missing " + episodeIdentityLabel(mediaInfo));
    return null;
  }

  var titleMatched = titlesMatch(mediaInfo.episodeTitle, episode.title);
  log(
    "Trakt episode candidate verified: show=" + traktId +
    " " + episodeIdentityLabel(mediaInfo) +
    (episode.title ? (' title="' + episode.title + '"') : "") +
    (mediaInfo.episodeTitle ? (" parsedTitleMatch=" + (titleMatched ? "yes" : "no")) : "")
  );

  return {
    trakt: Number(traktId || 0),
    titleMatched: titleMatched,
    episode: episode
  };
}

function summarizeSearchCandidate(result) {
  var show = result && result.show;
  if (!show || !show.ids) {
    return "invalid";
  }

  return "#" + String(show.ids.trakt || "?") +
    " " + String(show.title || "Unknown") +
    (show.year ? (" (" + show.year + ")") : "") +
    " score=" + String(Number(result.score || 0));
}

async function resolveEpisodeIds(mediaInfo, bucket, key) {
  var cached = bucket[key];
  var cachedId = readCachedTraktId(cached);

  if (cached === 0 || cached === -1 || cachedId === -1) {
    return null;
  }

  if (cachedId > 0) {
    if (isVerifiedEpisodeCacheEntry(cached)) {
      return { trakt: cachedId };
    }

    log("Trakt episode cache hit requires verification: show=" + cachedId + " for " + episodeIdentityLabel(mediaInfo));
    if (await verifyEpisodeCandidate(cachedId, mediaInfo)) {
      bucket[key] = createVerifiedEpisodeCacheEntry(cachedId);
      saveSearchCache();
      return { trakt: cachedId };
    }

    delete bucket[key];
    saveSearchCache();
    log("Trakt episode cache entry invalidated for " + episodeIdentityLabel(mediaInfo));
  }

  var title = mediaInfo.showTitle || mediaInfo.title;
  var year = mediaInfo.year || "";
  var results = await search(title, "show", year || undefined, 5);

  if ((!results || !results.length) && year) {
    results = await search(title, "show", undefined, 5);
  }

  if (!results || !results.length) {
    bucket[key] = -1;
    saveSearchCache();
    return null;
  }

  log("Trakt show search candidates for " + episodeIdentityLabel(mediaInfo) + ": " + results.map(summarizeSearchCandidate).join(" | "));

  var verified = [];
  for (var index = 0; index < results.length; index += 1) {
    var candidate = results[index] || {};
    var show = candidate.show;
    var score = Number(candidate.score || 0);
    if (score < SEARCH_SCORE_THRESHOLD || !show || !show.ids || !show.ids.trakt) {
      continue;
    }

    var match = await verifyEpisodeCandidate(show.ids.trakt, mediaInfo);
    if (!match) {
      continue;
    }

    verified.push(match);
    if (match.titleMatched) {
      bucket[key] = createVerifiedEpisodeCacheEntry(match.trakt);
      saveSearchCache();
      return { trakt: match.trakt };
    }
  }

  if (verified.length) {
    bucket[key] = createVerifiedEpisodeCacheEntry(verified[0].trakt);
    saveSearchCache();
    return { trakt: verified[0].trakt };
  }

  bucket[key] = -1;
  saveSearchCache();
  return null;
}

async function getTraktIds(mediaInfo) {
  var type = mediaInfo && mediaInfo.type;
  if (type !== "movie" && type !== "episode") {
    return null;
  }

  var cache = loadSearchCache();
  var title = type === "episode" ? (mediaInfo.showTitle || mediaInfo.title) : mediaInfo.title;
  var year = mediaInfo.year || "";
  var bucket = type === "episode" ? cache.show : cache.movie;
  var key = searchCacheKey(title, year);
  var cached = bucket[key];
  var cachedId = readCachedTraktId(cached);

  if (cached === 0 || cached === -1 || cachedId === -1) {
    return null;
  }
  if (type === "episode") {
    return resolveEpisodeIds(mediaInfo, bucket, key);
  }
  if (cachedId > 0) {
    return { trakt: cachedId };
  }

  var requiredType = type === "episode" ? "show" : "movie";
  var results = await search(title, requiredType, year || undefined);

  if ((!results || !results.length) && year) {
    results = await search(title, requiredType, undefined);
  }

  if (!results || !results.length) {
    bucket[key] = -1;
    saveSearchCache();
    return null;
  }

  var first = results[0] || {};
  var score = Number(first.score || 0);
  if (score < SEARCH_SCORE_THRESHOLD || !first[requiredType] || !first[requiredType].ids) {
    bucket[key] = -1;
    saveSearchCache();
    return null;
  }

  var traktId = Number(first[requiredType].ids.trakt || 0);
  if (!traktId) {
    bucket[key] = -1;
    saveSearchCache();
    return null;
  }

  bucket[key] = traktId;
  saveSearchCache();
  return { trakt: traktId };
}

async function prepareScrobblePayload(mediaInfo) {
  var ids = await getTraktIds(mediaInfo);
  if (!ids) {
    return null;
  }

  if (mediaInfo.type === "movie") {
    return {
      movie: {
        ids: ids
      }
    };
  }

  if (!mediaInfo.season || !mediaInfo.episode) {
    return null;
  }

  return {
    show: {
      ids: ids
    },
    episode: {
      season: Number(mediaInfo.season),
      number: Number(mediaInfo.episode)
    }
  };
}

async function scrobble(verb, mediaInfo, progress) {
  if (!hasCredentials()) {
    return {
      ok: false,
      skip: true,
      reason: "missing-client-credentials"
    };
  }

  var payload;
  try {
    payload = await prepareScrobblePayload(mediaInfo);
  } catch (error) {
    if (isAuthRequiredError(error)) {
      return {
        ok: false,
        skip: true,
        reason: "auth-required"
      };
    }
    throw error;
  }
  if (!payload) {
    return {
      ok: false,
      skip: true,
      reason: "missing-trakt-match"
    };
  }

  payload.progress = Number(progress || 0);
  var response;
  try {
    response = await authedRequest("POST", "/scrobble/" + verb, {
      body: payload
    });
  } catch (error) {
    if (isAuthRequiredError(error)) {
      return {
        ok: false,
        skip: true,
        reason: "auth-required"
      };
    }
    throw error;
  }

  if (response.statusCode === 404) {
    return {
      ok: false,
      notFound: true,
      body: response.body
    };
  }

  if (response.statusCode === 409) {
    return {
      ok: false,
      duplicate: true,
      body: response.body
    };
  }

  if (response.statusCode >= 400) {
    throw new Error(response.body.error_description || response.body.error || ("Trakt scrobble failed with status " + response.statusCode));
  }

  return {
    ok: true,
    body: response.body
  };
}

function signOut() {
  clearToken();
  return getAuthStatus();
}

module.exports = {
  beginInteractiveAuth: beginInteractiveAuth,
  configure: configure,
  clearToken: clearToken,
  getAuthStatus: getAuthStatus,
  getTokenInfo: getTokenInfo,
  getViewerProfile: getViewerProfile,
  hasCredentials: hasCredentials,
  isAuthRequiredError: isAuthRequiredError,
  signOut: signOut,
  usingEmbeddedCredentials: usingEmbeddedCredentials,
  ensureAccessToken: ensureAccessToken,
  getTraktIds: getTraktIds,
  prepareScrobblePayload: prepareScrobblePayload,
  scrobble: scrobble,
  copyPendingAuthCode: copyPendingAuthCode
};
