// Copyright 2026 Enactic, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

import { createHudPanel } from "./hud.js";

const EYE_BY_PREFIX = { 0: "left", 1: "right" };
const states = {
  left: {
    canvas: document.getElementById("left-video"),
    queued: null,
    decoding: false,
  },
  right: {
    canvas: document.getElementById("right-video"),
    queued: null,
    decoding: false,
  },
};
const wristStates = {
  left: {
    canvas: document.getElementById("wrist-left-video"),
    queued: null,
    decoding: false,
  },
  right: {
    canvas: document.getElementById("wrist-right-video"),
    queued: null,
    decoding: false,
  },
};

const status = document.getElementById("status");
const placeholder = document.getElementById("placeholder");
const videoGrid = document.getElementById("video-grid");
const eyeControls = document.getElementById("eye-controls");
const hud = createHudPanel({ clears: false });
document.getElementById("hud").append(hud.canvas);

let stopped = false;
const sockets = new Set();
const reconnectTimers = new Set();
let receivedFrame = false;

function websocketUrl(path) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}${path}`;
}

function renderHud(now) {
  hud.updateCanvas(now);
  requestAnimationFrame(renderHud);
}
requestAnimationFrame(renderHud);

function decodeLatest(state) {
  if (state.decoding || !state.queued || stopped) {
    return;
  }
  const jpeg = state.queued;
  state.queued = null;
  state.decoding = true;
  createImageBitmap(jpeg)
    .then((bitmap) => {
      if (stopped) {
        bitmap.close();
        return;
      }
      const canvas = state.canvas;
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
      }
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      bitmap.close();
      state.onFrame();
    })
    .catch(() => {
      if (state.reportsErrors) {
        status.textContent = "Could not decode a camera frame";
      }
    })
    .finally(() => {
      state.decoding = false;
      decodeLatest(state);
    });
}

function queueFrame(group, name, bytes, onFrame, reportsErrors = false) {
  const state = group[name];
  if (!state) {
    return;
  }
  // One replaceable slot prevents a slow desktop decoder accumulating delay.
  state.queued = new Blob([bytes], { type: "image/jpeg" });
  state.onFrame = onFrame;
  state.reportsErrors = reportsErrors;
  decodeLatest(state);
}

function connectVideo(path, receive, { reportsStatus = true } = {}) {
  if (stopped) {
    return;
  }
  if (reportsStatus) {
    status.textContent = "Connecting…";
  }
  const websocket = new WebSocket(websocketUrl(path));
  websocket.binaryType = "arraybuffer";
  websocket.addEventListener("open", () => {
    if (reportsStatus) {
      status.textContent = receivedFrame
        ? "Live"
        : "Connected — waiting for video";
    }
  });
  websocket.addEventListener("message", receive);
  websocket.addEventListener("close", () => {
    sockets.delete(websocket);
    if (stopped) {
      return;
    }
    if (reportsStatus) {
      status.textContent = "Video disconnected — reconnecting…";
    }
    const timer = setTimeout(() => {
      reconnectTimers.delete(timer);
      connectVideo(path, receive, { reportsStatus });
    }, 1000);
    reconnectTimers.add(timer);
  });
  websocket.addEventListener("error", () => websocket.close());
  sockets.add(websocket);
}

function showCameraFrame() {
  if (!receivedFrame) {
    receivedFrame = true;
    placeholder.hidden = true;
  }
  status.textContent = "Live";
}

function receiveCameraFrame(event) {
  const message = new Uint8Array(event.data);
  const eye = EYE_BY_PREFIX[message[0]];
  if (eye) {
    queueFrame(states, eye, message.subarray(1), showCameraFrame, true);
  }
}

function receivePanoramaFrame(event) {
  queueFrame(states, "right", event.data, showCameraFrame, true);
}

function receiveWristFrame(event) {
  const message = new Uint8Array(event.data);
  const side = EYE_BY_PREFIX[message[0]];
  if (side && message.length > 1) {
    const state = wristStates[side];
    queueFrame(wristStates, side, message.subarray(1), () => {
      state.canvas.hidden = false;
    });
  }
}

function selectLayout(layout) {
  videoGrid.dataset.layout = layout;
  for (const button of eyeControls.querySelectorAll("button")) {
    button.classList.toggle("selected", button.dataset.layout === layout);
  }
}

for (const button of eyeControls.querySelectorAll("button")) {
  button.addEventListener("click", () => selectLayout(button.dataset.layout));
}

document.getElementById("fullscreen").addEventListener("click", () => {
  document.documentElement.requestFullscreen().catch(() => {});
});

fetch("/view_configuration")
  .then((response) => {
    if (!response.ok) {
      throw new Error(`configuration request failed: ${response.status}`);
    }
    return response.json();
  })
  .then((configuration) => {
    if (configuration.wrist_panels?.enabled !== false) {
      connectVideo("/wrist-video", receiveWristFrame, {
        reportsStatus: false,
      });
    }
    if (configuration.view === "theta360") {
      selectLayout("panorama");
      placeholder.textContent = "Waiting for a THETA 360 frame…";
      connectVideo("/theta-video", receivePanoramaFrame);
    } else if (configuration.view === "none") {
      videoGrid.hidden = true;
      placeholder.textContent = "This session has no camera view. HUD only.";
      status.textContent = "HUD monitor";
    } else {
      const stereo = configuration.view === "stereo";
      eyeControls.hidden = !stereo;
      selectLayout("right");
      connectVideo("/video", receiveCameraFrame);
    }
  })
  .catch((error) => {
    status.textContent = "Could not load the view configuration";
    placeholder.textContent = error.message;
  });

window.addEventListener("beforeunload", () => {
  stopped = true;
  for (const timer of reconnectTimers) {
    clearTimeout(timer);
  }
  for (const socket of sockets) {
    socket.close();
  }
  hud.close();
});
