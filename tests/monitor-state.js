const assert = require("assert");
const monitor = require("../monitor");

const CONFIG = {
  skipInterval: 5,
  previewThreshold: 80,
  fastPauseThreshold: 1
};

function state(mediaInfo, progress, stateValue, updatedAt, duration) {
  const total = duration || 120;
  return {
    progress: progress,
    mediaInfo: mediaInfo,
    state: stateValue,
    duration: total,
    updatedAt: updatedAt,
    position: (progress / 100) * total
  };
}

function expectActions(name, prev, current, flags, expected) {
  const actual = monitor.decideActions(prev, current, flags || {}, CONFIG);
  assert.deepStrictEqual(actual, expected, name);
}

function test(name, fn) {
  fn();
}

const episodeA = {
  type: "episode",
  title: "Breaking Bad",
  showTitle: "Breaking Bad",
  season: 5,
  episode: 13
};

const episodeB = {
  type: "episode",
  title: "Better Call Saul",
  showTitle: "Better Call Saul",
  season: 2,
  episode: 8
};

test("initial playing state scrobbles", function() {
  expectActions(
    "expected initial playback to scrobble",
    null,
    state(episodeA, 30, monitor.State.Playing, 1),
    {},
    ["scrobble"]
  );
});

test("initial late playback enters preview", function() {
  expectActions(
    "expected late-start playback to enter preview",
    null,
    state(episodeA, 90, monitor.State.Playing, 1),
    {},
    ["enter_preview"]
  );
});

test("small steady progress does not emit actions", function() {
  expectActions(
    "steady playback should not re-scrobble",
    state(episodeA, 30, monitor.State.Playing, 1),
    state(episodeA, 30.5, monitor.State.Playing, 1.6),
    {},
    []
  );
});

test("switching media stops previous and scrobbles current", function() {
  expectActions(
    "switching media should stop previous and scrobble current",
    state(episodeA, 25, monitor.State.Playing, 10),
    state(episodeB, 5, monitor.State.Playing, 11),
    {},
    ["stop_previous", "scrobble"]
  );
});

test("preview mode pauses and resumes cleanly", function() {
  expectActions(
    "pausing during preview should pause the preview timer",
    state(episodeA, 90, monitor.State.Playing, 1),
    state(episodeA, 90.2, monitor.State.Paused, 2),
    { preview: true },
    ["pause_preview"]
  );

  expectActions(
    "resuming during preview should resume the preview timer",
    state(episodeA, 90.2, monitor.State.Paused, 2),
    state(episodeA, 90.4, monitor.State.Playing, 3),
    { preview: true },
    ["resume_preview"]
  );
});

test("preview mode exits when playback stops", function() {
  expectActions(
    "stopping during preview should exit preview",
    state(episodeA, 91, monitor.State.Playing, 3),
    state(episodeA, 91, monitor.State.Stopped, 4),
    { preview: true },
    ["exit_preview"]
  );
});

test("fast pause enters on an immediate pause", function() {
  expectActions(
    "quick pause should enter fast-pause mode",
    state(episodeA, 10, monitor.State.Playing, 1),
    state(episodeA, 10.2, monitor.State.Paused, 1.4),
    {},
    ["enter_fast_pause"]
  );
});

test("fast pause resumes with delayed play", function() {
  expectActions(
    "quick resume should just exit fast-pause mode",
    state(episodeA, 10.2, monitor.State.Paused, 1.4),
    state(episodeA, 10.3, monitor.State.Playing, 2),
    { fastPause: true },
    ["exit_fast_pause"]
  );
});

test("fast pause exits on a large progress jump", function() {
  expectActions(
    "a seek while in fast-pause mode should scrobble and exit fast pause",
    state(episodeA, 10.2, monitor.State.Paused, 1.4),
    state(episodeA, 40, monitor.State.Playing, 4),
    { fastPause: true },
    ["scrobble", "exit_fast_pause"]
  );
});

test("clears preview and fast-pause state when playback disappears", function() {
  expectActions(
    "missing current snapshot should exit transient modes",
    state(episodeA, 10, monitor.State.Paused, 1),
    null,
    { preview: true, fastPause: true },
    ["exit_preview", "exit_fast_pause"]
  );
});

test("computeProgress clamps safely", function() {
  assert.strictEqual(monitor.computeProgress(30, 120), 25);
  assert.strictEqual(monitor.computeProgress(999, 120), 100);
  assert.strictEqual(monitor.computeProgress(-5, 120), 0);
  assert.strictEqual(monitor.computeProgress(1, 0), 0);
});

test("ignores end-of-file rollover reset to zero", function() {
  const nearEnd = state(episodeA, 99.9, monitor.State.Playing, 100, 120);
  const resetToZero = state(episodeA, 0, monitor.State.Playing, 101, 120);
  assert.strictEqual(monitor.shouldIgnoreEndRollover(nearEnd, resetToZero), true);
});

test("does not treat ordinary seeks as end-of-file rollover", function() {
  const midPlayback = state(episodeA, 60, monitor.State.Playing, 100, 120);
  const resetToZero = state(episodeA, 0, monitor.State.Playing, 101, 120);
  assert.strictEqual(monitor.shouldIgnoreEndRollover(midPlayback, resetToZero), false);
});

console.log("monitor state tests passed");
