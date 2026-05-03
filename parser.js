var guessitModule = null;
var guessitLoadError = null;
var guessitModuleLoader = null;
var guessitRuntimeError = null;

var VIDEO_EXTENSION_RE = /\.(mkv|mp4|m4v|avi|mov|wmv|mpg|mpeg|ts|m2ts|webm|flv)$/i;
var EPISODE_PATTERNS = [
  /\bS(\d{1,2})\s*E(\d{1,2})(?:\s*E\d{1,2})?\b/i,
  /\b(\d{1,2})x(\d{1,2})(?:x\d{1,2})?\b/i,
  /\bSeason\s*(\d{1,2})\s*Episode\s*(\d{1,2})\b/i
];
var YEAR_RE = /\b(19\d{2}|20\d{2})\b/;
var NOISE_RE = /\b(?:2160p|1080p|720p|480p|4k|8k|bluray|blu-ray|bdrip|brrip|dvdrip|webrip|web[- ]?dl|hdrip|hdtv|remux|x264|x265|h\.?264|h\.?265|hevc|av1|aac(?:2\.0)?|ac3|eac3|dts(?:-?hd)?|truehd|ddp(?:5\.1|7\.1)?|atmos|10bit|8bit|proper|repack|extended|unrated|criterion|amzn|nf|dsnp|hmax|max|atvp|multi|subs?|dubbed|yts|rarbg|internal|limited|readnfo|complete)\b/i;
var SEASON_FOLDER_RE = /^season[\s._-]*\d+$/i;
var GENERIC_FOLDER_RE = /^(tv|shows|series|movies|films|video|videos)$/i;

function safeDecode(text) {
  if (!text) return "";
  try {
    return decodeURIComponent(text);
  } catch (_error) {
    return text;
  }
}

function getPathFromUrl(url) {
  var raw = String(url || "");
  if (/^[a-z]+:\/\//i.test(raw)) {
    raw = raw.replace(/[?#].*$/, "");
  }
  var value = safeDecode(raw);
  value = value.replace(/^file:\/\//i, "");
  return value;
}

function stripExtension(name) {
  return String(name || "").replace(VIDEO_EXTENSION_RE, "");
}

function normalizeWhitespace(text) {
  return String(text || "")
    .replace(/[\[\]{}()]/g, " ")
    .replace(/[._]+/g, " ")
    .replace(/\s+-\s+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function trimNoise(text) {
  var value = normalizeWhitespace(text);
  var match = value.match(NOISE_RE);
  if (match && typeof match.index === "number") {
    value = value.slice(0, match.index).trim();
  }
  return value.replace(/[-\s]+$/g, "").trim();
}

function extractYear(text) {
  var match = String(text || "").match(YEAR_RE);
  return match ? parseInt(match[1], 10) : null;
}

function removeYear(text) {
  return normalizeWhitespace(String(text || "").replace(YEAR_RE, " "));
}

function prettifyTitle(text) {
  var value = trimNoise(text);
  return value.replace(/\b([A-Za-z])([A-Za-z']*)\b/g, function(_match, first, rest) {
    return first.toUpperCase() + rest.toLowerCase();
  });
}

function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function splitSegments(path) {
  return String(path || "")
    .split("/")
    .filter(function(part) { return !!part; });
}

function findSeriesFolder(segments) {
  for (var index = segments.length - 1; index >= 0; index -= 1) {
    var candidate = stripExtension(safeDecode(segments[index]));
    var cleaned = normalizeWhitespace(candidate);
    if (!cleaned) continue;
    if (SEASON_FOLDER_RE.test(cleaned)) continue;
    if (GENERIC_FOLDER_RE.test(cleaned)) continue;
    return cleaned;
  }
  return "";
}

function buildEpisodeLookupKey(showTitle, year, season, episode) {
  return ["episode", slugify(showTitle), year || "", season || "", episode || ""].join("|");
}

function buildMovieLookupKey(title, year) {
  return ["movie", slugify(title), year || ""].join("|");
}

function heuristicParseEpisodeFromName(baseName, parentSegments) {
  var cleanedName = normalizeWhitespace(baseName);
  var match = null;

  for (var index = 0; index < EPISODE_PATTERNS.length; index += 1) {
    match = cleanedName.match(EPISODE_PATTERNS[index]);
    if (match) break;
  }

  if (!match || typeof match.index !== "number") return null;

  var rawShowTitle = cleanedName.slice(0, match.index).trim();
  var rawEpisodeTitle = cleanedName.slice(match.index + match[0].length).trim();
  var season = parseInt(match[1], 10);
  var episode = parseInt(match[2], 10);
  var parentShowTitle = findSeriesFolder(parentSegments);
  var year = extractYear(rawShowTitle) || extractYear(parentShowTitle);
  var showTitle = prettifyTitle(removeYear(rawShowTitle || parentShowTitle));
  var episodeTitle = prettifyTitle(trimNoise(rawEpisodeTitle));

  if (!showTitle && parentShowTitle) {
    showTitle = prettifyTitle(removeYear(parentShowTitle));
  }

  if (!showTitle) return null;

  return {
    kind: "episode",
    showTitle: showTitle,
    season: season,
    episode: episode,
    episodeTitle: episodeTitle || "",
    year: year,
    lookupKey: buildEpisodeLookupKey(showTitle, year, season, episode),
    parserSource: "heuristic"
  };
}

function heuristicParseMovieFromName(baseName, parentSegments) {
  var cleanedName = normalizeWhitespace(baseName);
  if (!cleanedName) return null;

  var yearMatch = cleanedName.match(YEAR_RE);
  var noiseMatch = cleanedName.match(NOISE_RE);
  var cutIndex = cleanedName.length;
  var year = null;

  if (yearMatch && typeof yearMatch.index === "number") {
    year = parseInt(yearMatch[1], 10);
    cutIndex = Math.min(cutIndex, yearMatch.index);
  }
  if (noiseMatch && typeof noiseMatch.index === "number") {
    cutIndex = Math.min(cutIndex, noiseMatch.index);
  }

  var rawTitle = cleanedName.slice(0, cutIndex).trim();
  var parentTitle = findSeriesFolder(parentSegments);
  var title = prettifyTitle(removeYear(rawTitle || parentTitle));

  if (!title && parentTitle) {
    title = prettifyTitle(removeYear(parentTitle));
  }
  if (!title) return null;

  return {
    kind: "movie",
    title: title,
    year: year || extractYear(parentTitle),
    lookupKey: buildMovieLookupKey(title, year || extractYear(parentTitle)),
    parserSource: "heuristic"
  };
}

function heuristicParseNameLike(value) {
  var path = getPathFromUrl(value);
  var segments = splitSegments(path);
  var fileName = segments.length ? segments[segments.length - 1] : path;
  var baseName = stripExtension(fileName);
  var parentSegments = segments.slice(0, -1);
  var episode = heuristicParseEpisodeFromName(baseName, parentSegments);
  var movie = heuristicParseMovieFromName(baseName, parentSegments);

  if (episode) return episode;
  if (movie) return movie;

  var fallbackTitle = prettifyTitle(baseName);
  if (!fallbackTitle) return null;

  return {
    kind: "unknown",
    title: fallbackTitle,
    lookupKey: buildMovieLookupKey(fallbackTitle, null),
    parserSource: "heuristic"
  };
}

function heuristicParseMediaFromSource(url, title) {
  var fromUrl = heuristicParseNameLike(url || "");
  var fromTitle = heuristicParseNameLike(title || "");

  if (fromUrl && fromUrl.kind !== "unknown") return fromUrl;
  if (fromTitle && fromTitle.kind !== "unknown") return fromTitle;
  return fromUrl || fromTitle || null;
}

function getGuessit() {
  if (guessitModule) return guessitModule;
  if (guessitLoadError) return null;

  try {
    if (typeof guessitModuleLoader !== "function") {
      throw new Error("Guessit module loader is not configured");
    }
    guessitModule = guessitModuleLoader();
  } catch (error) {
    guessitLoadError = error;
    guessitModule = null;
  }

  return guessitModule;
}

function getDiagnostics() {
  if (guessitModule && guessitRuntimeError) {
    return {
      guessitAvailable: true,
      guessitStatus: "runtime-failed",
      guessitLoadError: null,
      guessitError: (guessitRuntimeError && guessitRuntimeError.message) || String(guessitRuntimeError)
    };
  }

  if (guessitModule) {
    return {
      guessitAvailable: true,
      guessitStatus: "loaded",
      guessitLoadError: null,
      guessitError: null
    };
  }

  if (guessitLoadError) {
    return {
      guessitAvailable: false,
      guessitStatus: "load-failed",
      guessitLoadError: (guessitLoadError && guessitLoadError.message) || String(guessitLoadError),
      guessitError: null
    };
  }

  if (typeof guessitModuleLoader !== "function") {
    return {
      guessitAvailable: false,
      guessitStatus: "unconfigured",
      guessitLoadError: "Guessit module loader is not configured",
      guessitError: null
    };
  }

  return {
    guessitAvailable: false,
    guessitStatus: "not-loaded",
    guessitLoadError: null,
    guessitError: null
  };
}

function pickFirstText(value) {
  if (Array.isArray(value)) return pickFirstText(value[0]);
  if (value === null || value === undefined) return "";
  return String(value);
}

function pickFirstNumber(value) {
  if (Array.isArray(value)) return pickFirstNumber(value[0]);
  if (value === null || value === undefined || value === "") return null;
  var parsed = parseInt(value, 10);
  return isNaN(parsed) ? null : parsed;
}

function normalizeGuessitText(value) {
  var text = safeDecode(pickFirstText(value));
  if (!text) return "";
  return prettifyTitle(text);
}

function pickEpisodeTitleCandidate(values, showTitle) {
  var candidates = Array.isArray(values) ? values : [values];
  var normalizedShowTitle = prettifyTitle(showTitle || "").toLowerCase();
  var best = "";

  for (var index = 0; index < candidates.length; index += 1) {
    var rawValue = pickFirstText(candidates[index]);
    if (!rawValue || /%[0-9A-F]{2}/i.test(rawValue)) continue;

    var normalized = prettifyTitle(safeDecode(rawValue));
    if (!normalized) continue;
    if (!best) {
      best = normalized;
    }
    if (normalized.toLowerCase() !== normalizedShowTitle) {
      return normalized;
    }
  }

  return best;
}

function chooseEpisodeTitle(guess, fallback) {
  var showTitle = normalizeGuessitText(guess.title) || (fallback && fallback.kind === "episode" ? fallback.showTitle : "");
  var title = pickEpisodeTitleCandidate(guess.episode_title || guess.alternative_title || "", showTitle);
  if (!title) {
    return fallback && fallback.kind === "episode" ? (fallback.episodeTitle || "") : "";
  }
  return title;
}

function chooseMovieTitle(guess, fallback) {
  var baseTitle = normalizeGuessitText(guess.title);
  var fallbackTitle = fallback && fallback.kind === "movie" ? (fallback.title || "") : "";
  var part = pickFirstNumber(guess.part);

  if (fallbackTitle && (!baseTitle || (part && fallbackTitle.length > baseTitle.length))) {
    return fallbackTitle;
  }
  if (part && baseTitle) {
    return baseTitle + " Part " + part;
  }
  return baseTitle || fallbackTitle;
}

function normalizeGuessitResult(rawGuess, fallback) {
  if (!rawGuess || typeof rawGuess !== "object") return null;

  var kind = pickFirstText(rawGuess.type).toLowerCase();
  if (kind === "episode") {
    var showTitle = normalizeGuessitText(rawGuess.title) || (fallback && fallback.kind === "episode" ? fallback.showTitle : "");
    var season = pickFirstNumber(rawGuess.season);
    var episode = pickFirstNumber(rawGuess.episode);
    var year = pickFirstNumber(rawGuess.year) || (fallback ? fallback.year || null : null);
    var episodeTitle = chooseEpisodeTitle(rawGuess, fallback);

    if (!showTitle || episode === null) return null;
    if (season === null) {
      season = fallback && fallback.kind === "episode" && fallback.season ? fallback.season : 1;
    }

    return {
      kind: "episode",
      showTitle: showTitle,
      season: season,
      episode: episode,
      episodeTitle: episodeTitle || "",
      year: year,
      lookupKey: buildEpisodeLookupKey(showTitle, year, season, episode),
      parserSource: "guessit"
    };
  }

  if (kind === "movie") {
    var title = chooseMovieTitle(rawGuess, fallback);
    var movieYear = pickFirstNumber(rawGuess.year) || (fallback ? fallback.year || null : null);

    if (!title) return null;

    return {
      kind: "movie",
      title: title,
      year: movieYear,
      lookupKey: buildMovieLookupKey(title, movieYear),
      parserSource: "guessit"
    };
  }

  return null;
}

function tryGuessitParse(value) {
  var api = getGuessit();
  if (!api || typeof api.guessit !== "function") return null;

  var candidate = getPathFromUrl(value);
  if (!candidate) return null;

  try {
    guessitRuntimeError = null;
    return api.guessit(candidate);
  } catch (error) {
    guessitRuntimeError = error;
    return null;
  }
}

function parseNameLikeWithGuessit(value) {
  var fallback = heuristicParseNameLike(value);
  var rawGuess = tryGuessitParse(value);
  var normalized = normalizeGuessitResult(rawGuess, fallback);

  if (normalized) return normalized;
  return fallback;
}

function parseMediaFromSource(url, title) {
  var fromUrl = parseNameLikeWithGuessit(url || "");
  var fromTitle = parseNameLikeWithGuessit(title || "");

  if (fromUrl && fromUrl.kind !== "unknown") return fromUrl;
  if (fromTitle && fromTitle.kind !== "unknown") return fromTitle;
  return fromUrl || fromTitle || null;
}

module.exports = {
  configure: function(options) {
    var settings = options || {};
    if (typeof settings.loadGuessitModule === "function") {
      guessitModuleLoader = settings.loadGuessitModule;
      guessitModule = null;
      guessitLoadError = null;
    }
  },
  getDiagnostics: getDiagnostics,
  parseMediaFromSource: parseMediaFromSource,
  heuristicParseMediaFromSource: heuristicParseMediaFromSource
};
