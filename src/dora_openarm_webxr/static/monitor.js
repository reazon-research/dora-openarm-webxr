// Copyright 2026 Enactic, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

import { connect } from "./connection.js";
import { createHudPanel } from "./hud.js";

const states = {
  left: { canvas: document.getElementById("left-video"), video: null },
  right: { canvas: document.getElementById("right-video"), video: null },
};
const wristStates = {
  left: { canvas: document.getElementById("wrist-left-video"), video: null },
  right: { canvas: document.getElementById("wrist-right-video"), video: null },
};

const status = document.getElementById("status");
const placeholder = document.getElementById("placeholder");
const videoGrid = document.getElementById("video-grid");
const eyeControls = document.getElementById("eye-controls");
const hud = createHudPanel({ clears: false });
document.getElementById("hud").append(...hud.canvases);

let stopped = false;
let connection = null;
let reconnectTimer = null;
let receivedFrame = false;
let selectedProtocol = "unknown transport";

function renderHud(now) {
  hud.updateCanvas(now);
  requestAnimationFrame(renderHud);
}
requestAnimationFrame(renderHud);

function detachVideo(state) {
  if (!state.video) {
    return;
  }
  state.cancelFrame?.();
  state.video.pause();
  state.video.srcObject = null;
  state.video = null;
  state.cancelFrame = null;
}

function detachAllVideos() {
  for (const group of [states, wristStates]) {
    for (const state of Object.values(group)) {
      detachVideo(state);
    }
  }
}

function attachVideo(state, track, onFrame) {
  if (!track) {
    return;
  }
  detachVideo(state);
  const video = document.createElement("video");
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([track]);
  state.video = video;

  const draw = () => {
    if (stopped || state.video !== video || video.readyState < 2) {
      return;
    }
    const canvas = state.canvas;
    if (
      canvas.width !== video.videoWidth ||
      canvas.height !== video.videoHeight
    ) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    canvas.getContext("2d").drawImage(video, 0, 0);
    onFrame();
  };

  if ("requestVideoFrameCallback" in video) {
    let request = null;
    const onVideoFrame = () => {
      draw();
      request = video.requestVideoFrameCallback(onVideoFrame);
    };
    request = video.requestVideoFrameCallback(onVideoFrame);
    state.cancelFrame = () => video.cancelVideoFrameCallback(request);
  } else {
    let request = null;
    const onAnimationFrame = () => {
      draw();
      request = requestAnimationFrame(onAnimationFrame);
    };
    request = requestAnimationFrame(onAnimationFrame);
    state.cancelFrame = () => cancelAnimationFrame(request);
  }
  video.play().catch((error) => {
    status.textContent = `Could not play WebRTC video: ${error}`;
  });
}

function showCameraFrame() {
  if (!receivedFrame) {
    receivedFrame = true;
    placeholder.hidden = true;
  }
  status.textContent = `Live over WebRTC (${selectedProtocol})`;
}

function showWristFrame(side) {
  wristStates[side].canvas.hidden = false;
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

function applyTracks(opened) {
  const configuration = opened.configuration;
  const tracks = opened.tracks;
  selectedProtocol = opened.protocol;
  receivedFrame = false;
  placeholder.hidden = false;
  videoGrid.hidden = false;
  status.textContent = `WebRTC connected (${selectedProtocol}) — waiting for video`;

  if (configuration.wrist_panels?.enabled !== false) {
    for (const side of ["left", "right"]) {
      attachVideo(wristStates[side], tracks[`wrist-${side}`], () =>
        showWristFrame(side),
      );
    }
  }

  if (configuration.view === "theta360") {
    selectLayout("panorama");
    placeholder.textContent = "Waiting for a THETA 360 frame…";
    attachVideo(states.right, tracks.theta, showCameraFrame);
  } else if (configuration.view === "none") {
    placeholder.textContent = "This session has no main camera view. HUD only.";
    status.textContent = `WebRTC connected (${selectedProtocol}) — HUD and wrist views`;
  } else {
    const stereo = configuration.view === "stereo";
    eyeControls.hidden = !stereo;
    selectLayout("right");
    attachVideo(states.right, tracks["head-right"], showCameraFrame);
    if (stereo) {
      attachVideo(states.left, tracks["head-left"], showCameraFrame);
    }
  }
}

function scheduleReconnect(message) {
  if (stopped || reconnectTimer !== null) {
    return;
  }
  status.textContent = message;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectMonitor();
  }, 1000);
}

async function connectMonitor() {
  status.textContent = "Connecting WebRTC…";
  try {
    const opened = await connect({
      onState: (state) => {
        status.textContent = state;
      },
    });
    if (stopped) {
      opened.close();
      return;
    }
    connection = opened;
    opened.onClose(() => {
      if (connection !== opened) {
        return;
      }
      connection = null;
      detachAllVideos();
      scheduleReconnect("WebRTC disconnected — reconnecting…");
    });
    applyTracks(opened);
  } catch (error) {
    scheduleReconnect(`WebRTC connection failed: ${error}`);
  }
}

connectMonitor();

window.addEventListener("beforeunload", () => {
  stopped = true;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
  }
  detachAllVideos();
  connection?.close();
  hud.close();
});
