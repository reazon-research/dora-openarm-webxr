// Copyright 2026 Enactic, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

// A small head-locked timer and normalized lifter pose. The pose only displays
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

const CANVAS = { width: 1024, height: 512 };

// Upper-left and away from the center of gaze. Values are in viewer-space
// meters, so the panel follows the headset without reacting to a head turn.
const PANEL = {
  distance: 1.2,
  width: 0.56,
  centerX: -0.62,
  centerY: 0.3,
};
const RETICLE = { distance: 1.0, size: 0.012 };

const BUTTONS = [
  {
    id: "timer",
    label: "X  TAP: START / STOP    HOLD: RESET",
    x: 56,
    y: 398,
    width: 912,
    height: 76,
  },
];

const LIFTER = {
  centerX: 810,
  groundY: 350,
  minHipY: 292,
  travel: 95,
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
  #texture = null;
  #reticleTexture = null;
  #canvas = null;
  #context = null;
  #clears = false;
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

  constructor({ clears }) {
    this.#clears = clears;
    this.#canvas = document.createElement("canvas");
    this.#canvas.width = CANVAS.width;
    this.#canvas.height = CANVAS.height;
    this.#context = this.#canvas.getContext("2d");

    const websocket = new WebSocket(`wss://${location.host}/hud`);
    websocket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "waist-height") {
          this.setWaistHeight(message.value);
        } else if (message.type === "waist-angle") {
          this.setWaistAngle(message.value);
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

    this.#texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.#texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

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

  #drawButton(button) {
    const context = this.#context;
    const active = this.#running || this.#buttonX;
    context.fillStyle = active ? "rgba(66, 190, 120, 0.95)" : "#30363d";
    context.fillRect(button.x, button.y, button.width, button.height);
    context.lineWidth = 3;
    context.strokeStyle = "#8b949e";
    context.strokeRect(button.x, button.y, button.width, button.height);
    context.fillStyle = "#ffffff";
    context.font = "bold 32px sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(
      button.label,
      button.x + button.width / 2,
      button.y + button.height / 2,
    );
  }

  #drawLifter() {
    const context = this.#context;
    const hipY = LIFTER.minHipY - this.#waistHeight * LIFTER.travel;
    const shoulderY = hipY - 31;
    const headY = hipY - 61;

    context.fillStyle = "#8b949e";
    context.font = "bold 28px sans-serif";
    context.textAlign = "left";
    context.fillText("LIFTER", 620, 58);
    context.fillStyle = "#ffffff";
    context.font = "bold 40px sans-serif";
    context.textAlign = "right";
    context.fillText(`${Math.round(this.#waistHeight * 100)}%`, 968, 58);
    context.fillStyle = "#8b949e";
    context.font = "22px sans-serif";
    context.fillText(`WAIST ${Math.round(this.#waistAngle)}°`, 968, 96);

    context.save();
    context.lineCap = "round";
    context.strokeStyle = "#484f58";
    context.lineWidth = 3;
    context.setLineDash([8, 7]);
    context.beginPath();
    context.moveTo(682, LIFTER.minHipY - LIFTER.travel);
    context.lineTo(682, LIFTER.minHipY);
    context.stroke();
    context.setLineDash([]);

    context.fillStyle = "#8b949e";
    context.font = "22px sans-serif";
    context.textAlign = "right";
    context.fillText("MAX", 664, LIFTER.minHipY - LIFTER.travel);
    context.fillText("MIN", 664, LIFTER.minHipY);

    context.strokeStyle = "#58a6ff";
    context.fillStyle = "#58a6ff";
    context.lineWidth = 8;
    context.beginPath();
    context.moveTo(LIFTER.centerX - 48, LIFTER.groundY);
    context.lineTo(LIFTER.centerX + 48, LIFTER.groundY);
    context.moveTo(LIFTER.centerX, LIFTER.groundY);
    context.lineTo(LIFTER.centerX, hipY);
    context.stroke();

    context.beginPath();
    context.arc(LIFTER.centerX, hipY, 10, 0, Math.PI * 2);
    context.fill();

    context.save();
    context.translate(LIFTER.centerX, hipY);
    context.rotate((this.#waistAngle * Math.PI) / 180);
    context.beginPath();
    context.moveTo(0, 0);
    context.lineTo(0, shoulderY - hipY);
    context.moveTo(-34, shoulderY - hipY);
    context.lineTo(34, shoulderY - hipY);
    context.stroke();
    context.lineWidth = 6;
    context.beginPath();
    context.arc(0, headY - hipY, 18, 0, Math.PI * 2);
    context.stroke();
    context.restore();
    context.restore();
  }

  #draw(now) {
    const context = this.#context;
    context.clearRect(0, 0, CANVAS.width, CANVAS.height);
    context.fillStyle = "rgba(13, 17, 23, 0.78)";
    context.fillRect(0, 0, CANVAS.width, CANVAS.height);

    context.fillStyle = "#8b949e";
    context.font = "bold 32px sans-serif";
    context.textAlign = "left";
    context.textBaseline = "middle";
    context.fillText("TIMER", 56, 58);
    context.fillStyle = this.#running ? "#7ee787" : "#ffffff";
    context.font = "bold 88px monospace";
    context.fillText(formatTime(this.#elapsedAt(now)), 56, 136);

    this.#drawLifter();

    BUTTONS.forEach((button) => {
      this.#drawButton(button);
    });
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

  get canvas() {
    return this.#canvas;
  }

  #upload(now) {
    if (!this.updateCanvas(now)) {
      return;
    }
    const gl = this.#gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.#texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.#canvas,
    );
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
    const halfWidth = PANEL.width / 2;
    const halfHeight = (halfWidth * CANVAS.height) / CANVAS.width;
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
      gl.uniform2f(this.#uniforms.u_half_extent, halfWidth, halfHeight);
      gl.uniform2f(this.#uniforms.u_center, PANEL.centerX, PANEL.centerY);
      gl.uniform1f(this.#uniforms.u_distance, PANEL.distance);
      gl.bindTexture(gl.TEXTURE_2D, this.#texture);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      const halfReticle = RETICLE.size / 2;
      gl.uniform2f(this.#uniforms.u_half_extent, halfReticle, halfReticle);
      gl.uniform2f(this.#uniforms.u_center, 0, 0);
      gl.uniform1f(this.#uniforms.u_distance, RETICLE.distance);
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
