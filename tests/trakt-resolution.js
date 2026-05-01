const assert = require("assert");
const path = require("path");

const TOKEN_PATH = "@data/trakt-token.json";
const CACHE_PATH = "@data/trakt-cache.json";

function makeToken() {
  return {
    access_token: "token",
    refresh_token: "refresh",
    created_at: Math.floor(Date.now() / 1000),
    expires_in: 3600
  };
}

function makeFile(store) {
  return {
    exists(filePath) {
      return Object.prototype.hasOwnProperty.call(store, filePath);
    },
    read(filePath) {
      return Object.prototype.hasOwnProperty.call(store, filePath) ? store[filePath] : "";
    },
    write(filePath, value) {
      store[filePath] = String(value);
    }
  };
}

function makeUtils(routeHandler, calls) {
  return {
    keyChainRead() {
      return JSON.stringify(makeToken());
    },
    keyChainWrite() {
      return true;
    },
    async exec(binary, args) {
      if (binary !== "/usr/bin/curl") {
        throw new Error("Unexpected binary: " + binary);
      }

      const methodIndex = args.indexOf("-X");
      const method = methodIndex >= 0 ? args[methodIndex + 1] : "GET";
      const url = new URL(args[args.length - 1]);
      calls.push(method + " " + url.pathname + url.search);

      const response = routeHandler({
        method,
        url
      });

      return {
        status: 0,
        stderr: "",
        stdout: JSON.stringify(response.body) + "\n__IINA_TRAKT_STATUS__:" + String(response.statusCode)
      };
    }
  };
}

function loadFreshTrakt(store, routeHandler, logs) {
  const modulePath = path.resolve(__dirname, "../trakt.js");
  delete require.cache[modulePath];
  const trakt = require("../trakt.js");
  const calls = [];

  trakt.configure({
    file: makeFile(store),
    preferences: {
      get() {
        return undefined;
      }
    },
    utils: makeUtils(routeHandler, calls),
    logger(message) {
      logs.push(String(message));
    },
    notify() {}
  });

  return {
    trakt,
    calls
  };
}

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .catch(function(error) {
      error.message = name + ": " + error.message;
      throw error;
    });
}

async function run() {
  await test("repairs a stale cached show id by verifying episode candidates", async function() {
    const store = {};
    const logs = [];
    store[CACHE_PATH] = JSON.stringify({
      movie: {},
      show: {
        "game changer|": 172377
      }
    });
    store[TOKEN_PATH] = JSON.stringify(makeToken());

    const { trakt, calls } = loadFreshTrakt(store, function(request) {
      if (request.url.pathname === "/shows/172377/seasons/5/episodes/4") {
        return { statusCode: 404, body: {} };
      }
      if (request.url.pathname === "/search/show") {
        return {
          statusCode: 200,
          body: [
            {
              score: 10,
              show: {
                title: "Game Changer",
                year: 2021,
                ids: { trakt: 172377 }
              }
            },
            {
              score: 10,
              show: {
                title: "Game Changer",
                year: 2019,
                ids: { trakt: 153142 }
              }
            }
          ]
        };
      }
      if (request.url.pathname === "/shows/153142/seasons/5/episodes/4") {
        return {
          statusCode: 200,
          body: {
            title: "Name a Number",
            season: 5,
            number: 4
          }
        };
      }
      throw new Error("Unhandled request: " + request.method + " " + request.url.pathname + request.url.search);
    }, logs);

    const mediaInfo = {
      type: "episode",
      title: "Game Changer",
      showTitle: "Game Changer",
      season: 5,
      episode: 4,
      episodeTitle: "Name A Number"
    };

    const ids = await trakt.getTraktIds(mediaInfo);
    assert.deepStrictEqual(ids, { trakt: 153142 });

    const cache = JSON.parse(store[CACHE_PATH]);
    assert.deepStrictEqual(cache.show["game changer|"], {
      trakt: 153142,
      verified: true
    });

    const payload = await trakt.prepareScrobblePayload(mediaInfo);
    assert.deepStrictEqual(payload, {
      show: {
        ids: { trakt: 153142 }
      },
      episode: {
        season: 5,
        number: 4
      }
    });

    assert(calls.some(function(call) {
      return call.indexOf("/shows/172377/seasons/5/episodes/4") >= 0;
    }));
    assert(calls.some(function(call) {
      return call.indexOf("/search/show") >= 0;
    }));
    assert(calls.some(function(call) {
      return call.indexOf("/shows/153142/seasons/5/episodes/4") >= 0;
    }));
    assert(logs.some(function(line) {
      return line.indexOf("Trakt episode cache entry invalidated") >= 0;
    }));
  });

  await test("prefers the candidate whose episode title matches the parsed title", async function() {
    const store = {};
    const logs = [];
    store[CACHE_PATH] = JSON.stringify({ movie: {}, show: {} });
    store[TOKEN_PATH] = JSON.stringify(makeToken());

    const { trakt } = loadFreshTrakt(store, function(request) {
      if (request.url.pathname === "/search/show") {
        return {
          statusCode: 200,
          body: [
            {
              score: 10,
              show: {
                title: "The Show",
                year: 2020,
                ids: { trakt: 111 }
              }
            },
            {
              score: 10,
              show: {
                title: "The Show",
                year: 2024,
                ids: { trakt: 222 }
              }
            }
          ]
        };
      }
      if (request.url.pathname === "/shows/111/seasons/1/episodes/2") {
        return {
          statusCode: 200,
          body: {
            title: "Pilot",
            season: 1,
            number: 2
          }
        };
      }
      if (request.url.pathname === "/shows/222/seasons/1/episodes/2") {
        return {
          statusCode: 200,
          body: {
            title: "The Real One",
            season: 1,
            number: 2
          }
        };
      }
      throw new Error("Unhandled request: " + request.method + " " + request.url.pathname + request.url.search);
    }, logs);

    const ids = await trakt.getTraktIds({
      type: "episode",
      title: "The Show",
      showTitle: "The Show",
      season: 1,
      episode: 2,
      episodeTitle: "The Real One"
    });

    assert.deepStrictEqual(ids, { trakt: 222 });
    const cache = JSON.parse(store[CACHE_PATH]);
    assert.deepStrictEqual(cache.show["the show|"], {
      trakt: 222,
      verified: true
    });
    assert(logs.some(function(line) {
      return line.indexOf('parsedTitleMatch=yes') >= 0;
    }));
  });

  await test("reuses a verified episode cache entry without hitting the network", async function() {
    const store = {};
    const logs = [];
    store[CACHE_PATH] = JSON.stringify({
      movie: {},
      show: {
        "game changer|": {
          trakt: 153142,
          verified: true
        }
      }
    });
    store[TOKEN_PATH] = JSON.stringify(makeToken());

    const { trakt, calls } = loadFreshTrakt(store, function() {
      throw new Error("verified cache should not trigger network lookups");
    }, logs);

    const ids = await trakt.getTraktIds({
      type: "episode",
      title: "Game Changer",
      showTitle: "Game Changer",
      season: 5,
      episode: 4,
      episodeTitle: "Name A Number"
    });

    assert.deepStrictEqual(ids, { trakt: 153142 });
    assert.deepStrictEqual(calls, []);
  });

  console.log("trakt resolution tests passed");
}

run().catch(function(error) {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
