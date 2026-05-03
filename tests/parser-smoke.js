const assert = require("assert");
const parser = require("../parser");

parser.configure({
  loadGuessitModule: function() {
    return require("../vendor/guessit-js.compat.js");
  }
});

var samples = [
  {
    input: "/Users/fahim/Videos/Altered Carbon/Season 01/Altered.Carbon.S01E01.Out.of.the.Past.1080p.NF.WEB-DL.mkv",
    expected: {
      kind: "episode",
      showTitle: "Altered Carbon",
      season: 1,
      episode: 1,
      episodeTitle: "Out Of The Past"
    }
  },
  {
    input: "/Users/fahim/Movies/Dune.Part.Two.2024.2160p.WEB-DL.mkv",
    expected: {
      kind: "movie",
      title: "Dune Part Two",
      year: 2024
    }
  },
  {
    input: "file:///Users/fahim/TV/Severance/Season%2002/Severance.S02E03.Who%20Is%20Alive%3F.mkv",
    expected: {
      kind: "episode",
      showTitle: "Severance",
      season: 2,
      episode: 3,
      episodeTitle: "Who Is Alive?"
    }
  },
  {
    input: "/Users/fahim/media/Arrested Development (2003) [tvdb-72173]/Season 01/Arrested Development 1x06 Visiting Ours.mkv",
    expected: {
      kind: "episode",
      showTitle: "Arrested Development",
      season: 1,
      episode: 6,
      episodeTitle: "Visiting Ours"
    }
  },
  {
    input: "/Users/fahim/TV/Arrested Development/Season 1/Arrested Development 1x19 Best Man for the Gob.mkv",
    expected: {
      kind: "episode",
      showTitle: "Arrested Development",
      season: 1,
      episode: 19,
      episodeTitle: "Best Man For The Gob"
    }
  }
];

samples.forEach(function(sample) {
  var parsed = parser.parseMediaFromSource(sample.input, "");
  assert(parsed, "Expected parser to return a result for " + sample.input);
  assert.strictEqual(parsed.parserSource, "guessit", "Expected guessit parserSource for " + sample.input);
  Object.keys(sample.expected).forEach(function(key) {
    assert.strictEqual(
      parsed[key],
      sample.expected[key],
      "Unexpected " + key + " for " + sample.input
    );
  });
});

console.log("parser smoke tests passed");
