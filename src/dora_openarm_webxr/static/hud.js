// Copyright 2026 Enactic, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

// A compact head-locked timer and normalized lifter pose. The pose only uses
// the 0..1 value supplied to the node's `waist_height` Dora input.

const VERTEX_SHADER = `
attribute vec2 a_corner;
uniform mat4 u_projection;
uniform mat4 u_view;
uniform vec2 u_half_extent;
uniform vec2 u_center;
uniform float u_distance;
varying vec2 v_uv;
void main() {
  gl_Position = u_projection * u_view *
    vec4(a_corner * u_half_extent + u_center, -u_distance, 1.0);
  v_uv = vec2((a_corner.x + 1.0) * 0.5, (1.0 - a_corner.y) * 0.5);
}
`;

const FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D u_texture;
varying vec2 v_uv;
void main() {
  gl_FragColor = texture2D(u_texture, v_uv);
}
`;

// Values are in viewer-space meters, so both panels follow the headset without
// reacting to a head turn. The two sit centered above and below the view, an
// equal angle off the reticle, leaving the middle band clear for the work and
// the flanks clear for the wrist cameras. Exported so the preview harness can
// lay the panels out from the same numbers the headset uses.
export const PANELS = [
  {
    id: "timer",
    canvas: { width: 320, height: 112 },
    distance: 1.2,
    width: 0.25,
    centerX: 0,
    centerY: 0.45,
  },
  {
    id: "robot",
    canvas: { width: 200, height: 280 },
    distance: 1.2,
    width: 0.22,
    centerX: 0,
    centerY: -0.4,
  },
];
const RETICLE = { defaultDistance: 1.0, angularSize: 0.012 };

const LIFTER = {
  centerX: 100,
  minHipY: 145,
  travel: 52,
};

// The base is drawn from above while the body above it is drawn from the
// side, so the square can turn on the spot and read as a heading. Its center
// is the rotation axis, which is also where the lifter column stands, so the
// column is drawn from there and stays put while the square turns under it.
// A bare square is symmetric every 90 degrees and could not show a heading at
// all, so the head circle rides near the front edge and breaks that symmetry.
const BASE = {
  centerY: 224,
  half: 34,
  headOffset: 22,
  headRadius: 10,
};
// One panel carries the whole robot rather than three panels taking view
// space: the swerve base below, the upper body standing on it, and a banner
// naming which of the two the sticks are driving. Both halves are always
// drawn, because both are always there — a right-grip press only moves which
// one the operator is holding. The idle half is grayed, which is literal: the
// press freezes it where it stood. The banner clears the head at its highest,
// and the base clears the head at any heading, so nothing ever overlaps.
const IDLE = "#6e7681";
const MODE = {
  bannerHeight: 24,
  font: "bold 16px monospace",
  labelColor: "#0d1117",
  torso: { label: "TORSO", banner: "#58a6ff", torso: "#58a6ff", base: IDLE },
  drive: { label: "DRIVE", banner: "#f0883e", torso: IDLE, base: "#f0883e" },
};
const RESET_HOLD_MILLISECONDS = 1000;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader));
  }
  return shader;
}

function formatTime(milliseconds) {
  const tenths = Math.floor(milliseconds / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor(tenths / 10) % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(
    2,
    "0",
  )}.${tenths % 10}`;
}

class HudPanel {
  #gl = null;
  #program = null;
  #buffer = null;
  #corner = null;
  #uniforms = {};
  #textures = new Map();
  #reticleTexture = null;
  #canvases = new Map();
  #contexts = new Map();
  #clears = false;
  #reticleDistance = RETICLE.defaultDistance;
  #stale = true;
  #websocket = null;
  #buttonX = false;
  #buttonXPressedAt = 0;
  #resetHandled = false;

  #running = false;
  #elapsed = 0;
  #startedAt = 0;
  #lastTick = -1;

  #waistHeight = 0.5;
  #displayedWaistHeight = 50;
  #waistAngle = 0;
  #displayedWaistAngle = 0;
  // Matches the swerve lock's startup default: the upper body owns the sticks
  // until the first grip press, so the HUD is right before the first message.
  #baseEngaged = false;
  // Radians. Odometry starts its integral at zero when the dataflow comes up,
  // which is the base's homed heading, so a fresh session starts the square
  // square-on — the same neutral the operator feels themselves to be in.
  #baseHeading = 0;
  #displayedBaseHeading = 0;

  constructor({ clears, reticleDistance }) {
    this.#clears = clears;
    if (Number.isFinite(reticleDistance) && reticleDistance > 0) {
      this.#reticleDistance = reticleDistance;
    }
    for (const panel of PANELS) {
      const canvas = document.createElement("canvas");
      canvas.width = panel.canvas.width;
      canvas.height = panel.canvas.height;
      canvas.className = panel.id;
      this.#canvases.set(panel.id, canvas);
      this.#contexts.set(panel.id, canvas.getContext("2d"));
    }

    const websocket = new WebSocket(`wss://${location.host}/hud`);
    websocket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "waist-height") {
          this.setWaistHeight(message.value);
        } else if (message.type === "waist-angle") {
          this.setWaistAngle(message.value);
        } else if (message.type === "base-heading") {
          this.setBaseHeading(message.value);
        } else if (message.type === "mode") {
          this.setBaseEngaged(message.base_engaged);
        } else if (message.type === "timer-state") {
          this.setTimerState(message.running, message.elapsed_milliseconds);
        }
      } catch (error) {
        console.error(`cannot read a HUD message: ${error}`);
      }
    });
    this.#websocket = websocket;
  }

  attach(gl) {
    this.#gl = gl;
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program));
    }
    this.#program = program;
    this.#corner = gl.getAttribLocation(program, "a_corner");
    for (const name of [
      "u_projection",
      "u_view",
      "u_half_extent",
      "u_center",
      "u_distance",
      "u_texture",
    ]) {
      this.#uniforms[name] = gl.getUniformLocation(program, name);
    }

    this.#buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );

    for (const panel of PANELS) {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.#textures.set(panel.id, texture);
    }

    const reticle = document.createElement("canvas");
    reticle.width = 32;
    reticle.height = 32;
    const reticleContext = reticle.getContext("2d");
    reticleContext.fillStyle = "#7ee787";
    reticleContext.beginPath();
    reticleContext.arc(16, 16, 10, 0, Math.PI * 2);
    reticleContext.fill();
    this.#reticleTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.#reticleTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      reticle,
    );
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  #elapsedAt(now) {
    return this.#elapsed + (this.#running ? now - this.#startedAt : 0);
  }

  #start() {
    if (this.#running) {
      return;
    }
    this.#startedAt = performance.now();
    this.#running = true;
    this.#stale = true;
  }

  #stop() {
    if (!this.#running) {
      return;
    }
    this.#elapsed = this.#elapsedAt(performance.now());
    this.#running = false;
    this.#stale = true;
  }

  reset() {
    this.#running = false;
    this.#elapsed = 0;
    this.#startedAt = 0;
    this.#lastTick = -1;
    this.#stale = true;
  }

  setWaistHeight(value) {
    if (!Number.isFinite(value)) {
      return;
    }
    this.#waistHeight = Math.max(0, Math.min(1, value));
    const displayed = Math.round(this.#waistHeight * 100);
    if (displayed !== this.#displayedWaistHeight) {
      this.#displayedWaistHeight = displayed;
      this.#stale = true;
    }
  }

  setWaistAngle(value) {
    if (!Number.isFinite(value)) {
      return;
    }
    this.#waistAngle = Math.max(0, Math.min(90, value));
    const displayed = Math.round(this.#waistAngle);
    if (displayed !== this.#displayedWaistAngle) {
      this.#displayedWaistAngle = displayed;
      this.#stale = true;
    }
  }

  setBaseHeading(radians) {
    if (!Number.isFinite(radians)) {
      return;
    }
    this.#baseHeading = radians;
    // Redraw on whole degrees only. Odometry integrates every driver state
    // message, so the raw value never settles, and redrawing on each one
    // would re-upload the texture for a turn no one can see.
    const displayed = Math.round((radians * 180) / Math.PI);
    if (displayed !== this.#displayedBaseHeading) {
      this.#displayedBaseHeading = displayed;
      this.#stale = true;
    }
  }

  setBaseEngaged(value) {
    const engaged = value === true;
    if (engaged === this.#baseEngaged) {
      return;
    }
    this.#baseEngaged = engaged;
    this.#stale = true;
  }

  setTimerState(running, elapsedMilliseconds) {
    if (!Number.isFinite(elapsedMilliseconds)) {
      return;
    }
    this.#running = running === true;
    this.#elapsed = Math.max(0, elapsedMilliseconds);
    this.#startedAt = performance.now();
    this.#lastTick = -1;
    this.#stale = true;
  }

  setButton(xPressed, now = performance.now()) {
    const x = xPressed === true;
    let action = null;
    if (x && !this.#buttonX) {
      this.#buttonXPressedAt = now;
      this.#resetHandled = false;
      this.#stale = true;
    } else if (
      x &&
      !this.#resetHandled &&
      now - this.#buttonXPressedAt >= RESET_HOLD_MILLISECONDS
    ) {
      this.reset();
      this.#resetHandled = true;
      action = "reset";
    } else if (!x && this.#buttonX) {
      if (!this.#resetHandled && this.#running) {
        this.#stop();
        action = "stop";
      } else if (!this.#resetHandled) {
        this.#start();
        action = "start";
      }
      this.#buttonXPressedAt = 0;
      this.#resetHandled = false;
      this.#stale = true;
    }
    this.#buttonX = x;
    return action;
  }

  #drawBase(context, color) {
    context.save();
    context.translate(LIFTER.centerX, BASE.centerY);
    // Odometry counts a left turn positive about an upward axis. The canvas
    // counts a positive angle clockwise, its y axis pointing down, so the
    // sign flips here to keep a left turn reading as a left turn.
    context.rotate(-this.#baseHeading);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = 7;
    context.strokeRect(-BASE.half, -BASE.half, BASE.half * 2, BASE.half * 2);
    context.beginPath();
    context.arc(0, -BASE.headOffset, BASE.headRadius, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  #drawTorso(context, color) {
    const hipY = LIFTER.minHipY - this.#waistHeight * LIFTER.travel;
    const shoulderY = hipY - 24;
    const headY = hipY - 48;

    context.save();
    context.lineCap = "round";
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = 7;
    // From the base's center, which is the axis the square turns about, so
    // the column reads as mounted on the base rather than beside it.
    context.beginPath();
    context.moveTo(LIFTER.centerX, BASE.centerY);
    context.lineTo(LIFTER.centerX, hipY);
    context.stroke();

    context.beginPath();
    context.arc(LIFTER.centerX, hipY, 8, 0, Math.PI * 2);
    context.fill();

    context.save();
    context.translate(LIFTER.centerX, hipY);
    context.rotate((this.#waistAngle * Math.PI) / 180);
    context.beginPath();
    context.moveTo(0, 0);
    context.lineTo(0, shoulderY - hipY);
    context.moveTo(-24, shoulderY - hipY);
    context.lineTo(24, shoulderY - hipY);
    context.stroke();
    context.lineWidth = 5;
    context.beginPath();
    context.arc(0, headY - hipY, 14, 0, Math.PI * 2);
    context.stroke();
    context.restore();
    context.restore();
  }

  #drawRobot() {
    const panel = PANELS.find(({ id }) => id === "robot");
    const context = this.#contexts.get("robot");
    const mode = this.#baseEngaged ? MODE.drive : MODE.torso;

    context.clearRect(0, 0, panel.canvas.width, panel.canvas.height);
    context.fillStyle = "rgba(13, 17, 23, 0.78)";
    context.fillRect(0, 0, panel.canvas.width, panel.canvas.height);

    // Color carries the mode on its own, so it reads in peripheral vision
    // without the operator having to focus on the label to be sure.
    context.fillStyle = mode.banner;
    context.fillRect(0, 0, panel.canvas.width, MODE.bannerHeight);
    context.fillStyle = MODE.labelColor;
    context.font = MODE.font;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(mode.label, panel.canvas.width / 2, MODE.bannerHeight / 2);

    // Base first: the column and the hip joint sit on top of it, so drawing
    // the body second keeps that junction readable at every heading.
    this.#drawBase(context, mode.base);
    this.#drawTorso(context, mode.torso);
  }

  #draw(now) {
    const panel = PANELS.find(({ id }) => id === "timer");
    const context = this.#contexts.get("timer");
    context.clearRect(0, 0, panel.canvas.width, panel.canvas.height);
    context.fillStyle = "rgba(13, 17, 23, 0.78)";
    context.fillRect(0, 0, panel.canvas.width, panel.canvas.height);

    context.fillStyle = this.#running ? "#7ee787" : "#ffffff";
    context.font = "bold 56px monospace";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(
      formatTime(this.#elapsedAt(now)),
      panel.canvas.width / 2,
      panel.canvas.height / 2,
    );

    this.#drawRobot();
  }

  updateCanvas(now = performance.now()) {
    const tick = Math.floor(this.#elapsedAt(now) / 100);
    if (tick !== this.#lastTick) {
      this.#lastTick = tick;
      this.#stale = true;
    }
    if (!this.#stale) {
      return false;
    }
    this.#draw(now);
    this.#stale = false;
    return true;
  }

  get canvases() {
    return PANELS.map(({ id }) => this.#canvases.get(id));
  }

  #upload(now) {
    if (!this.updateCanvas(now)) {
      return;
    }
    const gl = this.#gl;
    gl.activeTexture(gl.TEXTURE0);
    for (const panel of PANELS) {
      gl.bindTexture(gl.TEXTURE_2D, this.#textures.get(panel.id));
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        this.#canvases.get(panel.id),
      );
    }
  }

  render(session, space, frame) {
    if (!this.#gl) {
      return;
    }
    const pose = frame.getViewerPose(space);
    if (!pose) {
      return;
    }
    const gl = this.#gl;
    const layer = session.renderState.baseLayer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
    if (this.#clears) {
      gl.clearColor(0.0, 0.0, 0.0, 0.0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    this.#upload(performance.now());
    gl.useProgram(this.#program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#buffer);
    gl.enableVertexAttribArray(this.#corner);
    gl.vertexAttribPointer(this.#corner, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1i(this.#uniforms.u_texture, 0);
    gl.activeTexture(gl.TEXTURE0);

    for (const view of pose.views) {
      const viewport = layer.getViewport(view);
      gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
      gl.uniformMatrix4fv(
        this.#uniforms.u_projection,
        false,
        view.projectionMatrix,
      );
      gl.uniformMatrix4fv(
        this.#uniforms.u_view,
        false,
        view.transform.inverse.matrix,
      );
      for (const panel of PANELS) {
        const halfWidth = panel.width / 2;
        const halfHeight =
          (halfWidth * panel.canvas.height) / panel.canvas.width;
        gl.uniform2f(this.#uniforms.u_half_extent, halfWidth, halfHeight);
        gl.uniform2f(
          this.#uniforms.u_center,
          panel.centerX,
          panel.centerY,
        );
        gl.uniform1f(this.#uniforms.u_distance, panel.distance);
        gl.bindTexture(gl.TEXTURE_2D, this.#textures.get(panel.id));
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }

      // Depth testing stays disabled, so sharing the camera plane cannot
      // z-fight; this later draw deterministically keeps the dot visible.
      const halfReticle = (RETICLE.angularSize * this.#reticleDistance) / 2;
      gl.uniform2f(this.#uniforms.u_half_extent, halfReticle, halfReticle);
      gl.uniform2f(this.#uniforms.u_center, 0, 0);
      gl.uniform1f(this.#uniforms.u_distance, this.#reticleDistance);
      gl.bindTexture(gl.TEXTURE_2D, this.#reticleTexture);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.disable(gl.BLEND);
  }

  close() {
    if (this.#websocket) {
      this.#websocket.close();
      this.#websocket = null;
    }
  }
}

export function createHudPanel(options) {
  return new HudPanel(options);
}
