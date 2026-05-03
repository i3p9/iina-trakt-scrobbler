var State = {
  Stopped: 0,
  Paused: 1,
  Playing: 2
};

var SCROBBLE_VERBS = {
  0: "stop",
  1: "pause",
  2: "start"
};

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function computeProgress(position, duration) {
  var total = Number(duration || 0);
  if (!isFinite(total) || total <= 0) return 0;
  var current = clamp(Number(position || 0), 0, total);
  return round2((current * 100) / total);
}

function stateVerb(state) {
  return SCROBBLE_VERBS[state] || "start";
}

function mediaKey(mediaInfo) {
  if (!mediaInfo) return "";
  if (mediaInfo.type === "episode") {
    return [
      "episode",
      normalizeText(mediaInfo.showTitle || mediaInfo.title),
      Number(mediaInfo.season || 0),
      Number(mediaInfo.episode || 0),
      Number(mediaInfo.year || 0)
    ].join("|");
  }

  return [
    "movie",
    normalizeText(mediaInfo.title),
    Number(mediaInfo.year || 0)
  ].join("|");
}

function createTransition(prev, current) {
  var elapsedRealtime = current.updatedAt - prev.updatedAt;
  var progressDelta = current.progress - prev.progress;
  var expectedProgressDelta = 0;

  if (prev.duration === current.duration && current.state === State.Playing && current.duration > 0) {
    expectedProgressDelta = (100 * elapsedRealtime) / current.duration;
  }

  return {
    prev: prev,
    current: current,
    isSameMedia: mediaKey(prev.mediaInfo) === mediaKey(current.mediaInfo),
    stateChanged: prev.state !== current.state,
    elapsedRealtime: elapsedRealtime,
    progress: progressDelta,
    absProgress: Math.abs(progressDelta),
    expectedProgressDelta: expectedProgressDelta,
    progressSkipped: progressDelta - expectedProgressDelta,
    absProgressSkipped: Math.abs(progressDelta - expectedProgressDelta),
    fromPlayingToPaused: prev.state === State.Playing && current.state === State.Paused
  };
}

function shouldIgnoreEndRollover(prev, current) {
  if (!prev || !current) return false;
  if (mediaKey(prev.mediaInfo) !== mediaKey(current.mediaInfo)) return false;

  var prevDuration = Number(prev.duration || 0);
  var prevPosition = Number(prev.position || 0);
  var currentPosition = Number(current.position || 0);
  var currentProgress = Number(current.progress || 0);
  var remaining = prevDuration - prevPosition;

  if (!isFinite(prevDuration) || prevDuration <= 0) return false;
  if (!isFinite(prevPosition) || !isFinite(currentPosition) || !isFinite(currentProgress)) return false;

  return remaining <= 15 && currentPosition < 1 && currentProgress < 1;
}

function decideActions(prev, current, flags, config) {
  var options = config || {};
  var skipInterval = Number(options.skipInterval || 5);
  var previewThreshold = Number(options.previewThreshold || 80);
  var fastPauseThreshold = Number(options.fastPauseThreshold || 1);
  var state = flags || {};
  var actions = [];

  if (!prev && !current) {
    return actions;
  }

  if (!prev || !current) {
    if (state.preview) {
      actions.push("exit_preview");
    }
    if (state.fastPause) {
      actions.push("exit_fast_pause");
    }
    if (current) {
      if (current.progress > previewThreshold) {
        if (current.state !== State.Stopped) {
          actions.push("enter_preview");
        } else {
          actions.push("ignore");
        }
      } else {
        actions.push("scrobble");
      }
    }
    return actions;
  }

  var transition = createTransition(prev, current);

  if (!transition.isSameMedia || prev.state === State.Stopped) {
    if (state.preview) {
      actions.push("exit_preview");
    } else if (prev.state !== State.Stopped) {
      actions.push("stop_previous");
    }
    if (state.fastPause) {
      actions.push("exit_fast_pause");
    }
    if (current.progress > previewThreshold) {
      if (current.state !== State.Stopped) {
        actions.push("enter_preview");
      } else {
        actions.push("ignore");
      }
    } else if (!transition.isSameMedia || transition.stateChanged || transition.absProgressSkipped > skipInterval) {
      actions.push("scrobble");
    }
    return actions;
  }

  if (!transition.stateChanged && transition.absProgressSkipped <= skipInterval) {
    return actions;
  }

  if (state.preview) {
    if (current.state === State.Stopped) {
      actions.push("exit_preview");
    } else if (transition.fromPlayingToPaused) {
      actions.push("pause_preview");
    } else if (current.state === State.Playing) {
      actions.push("resume_preview");
    } else {
      actions.push("invalid_state");
    }
    return actions;
  }

  if (state.fastPause) {
    if (current.state === State.Stopped || transition.absProgressSkipped > skipInterval) {
      actions.push("scrobble");
      actions.push("exit_fast_pause");
    } else if (current.state === State.Playing) {
      actions.push("exit_fast_pause");
    }
    return actions;
  }

  if (transition.fromPlayingToPaused) {
    actions.push("enter_fast_pause");
    return actions;
  }

  actions.push("scrobble");
  return actions;
}

module.exports = {
  State: State,
  computeProgress: computeProgress,
  stateVerb: stateVerb,
  mediaKey: mediaKey,
  createTransition: createTransition,
  decideActions: decideActions,
  shouldIgnoreEndRollover: shouldIgnoreEndRollover
};
