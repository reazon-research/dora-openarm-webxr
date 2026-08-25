// Copyright 2026 Enactic, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

// Draws the left and right wrist cameras as small head-locked panels. Each
// panel is rendered into both headset eyes; "left" and "right" describe the
// panel positions and robot cameras, not the headset eyes.

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

// Must match CAMERA_PREFIX in video.py.
const SIDES = ["left", "right"];
const SIDE_BY_PREFIX = { 0: "left", 1: "right" };
const DEFAULT_PANEL = {
  // Matches PANEL_DISTANCE in hud.js: every head-locked element shares one
  // plane, so the eyes never reverge moving between them.
  distance: 1.2,
  width: 0.38,
  leftCenter: [-0.55, 0.0],
  rightCenter: [0.55, 0.0],
};

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader));
  }
  return shader;
}

function finiteNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function centerFor(configuration, side) {
  const fallback =
    side === "left" ? DEFAULT_PANEL.leftCenter : DEFAULT_PANEL.rightCenter;
  const configured = configuration[`${side}_center`];
  if (!Array.isArray(configured) || configured.length < 2) {
    return fallback;
  }
  return [
    finiteNumber(configured[0], fallback[0]),
    finiteNumber(configured[1], fallback[1]),
  ];
}

class WristPanels {
  #gl = null;
  #program = null;
  #buffer = null;
  #corner = null;
  #uniforms = {};
  #textures = {};
  #pending = { left: null, right: null };
  #sizes = {
    left: { width: 0, height: 0 },
    right: { width: 0, height: 0 },
  };
  #decodeSequences = { left: 0, right: 0 };
  #configuration = null;
  #clears = false;
  #websocket = null;
  #closed = false;

  constructor(configuration, { clears }) {
    this.#configuration = configuration.wrist_panels || {};
    this.#clears = clears;

    const websocket = new WebSocket(`wss://${location.host}/wrist-video`);
    websocket.binaryType = "arraybuffer";
    websocket.addEventListener("message", (event) => {
      const message = new Uint8Array(event.data);
      const side = SIDE_BY_PREFIX[message[0]];
      if (!side || message.length < 2) {
        return;
      }
      const sequence = ++this.#decodeSequences[side];
      const jpeg = message.subarray(1);
      createImageBitmap(new Blob([jpeg], { type: "image/jpeg" }))
        .then((bitmap) => {
          if (this.#closed || sequence !== this.#decodeSequences[side]) {
            bitmap.close();
            return;
          }
          if (this.#pending[side]) {
            this.#pending[side].close();
          }
          this.#pending[side] = bitmap;
        })
        .catch(() => {});
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

    for (const side of SIDES) {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.#textures[side] = texture;
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  #upload() {
    const gl = this.#gl;
    gl.activeTexture(gl.TEXTURE0);
    for (const side of SIDES) {
      const bitmap = this.#pending[side];
      if (!bitmap) {
        continue;
      }
      gl.bindTexture(gl.TEXTURE_2D, this.#textures[side]);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        bitmap,
      );
      this.#sizes[side] = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      this.#pending[side] = null;
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
    gl.disable(gl.BLEND);

    this.#upload();
    const distance = finiteNumber(
      this.#configuration.distance,
      DEFAULT_PANEL.distance,
    );
    const width = finiteNumber(this.#configuration.width, DEFAULT_PANEL.width);

    gl.useProgram(this.#program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#buffer);
    gl.enableVertexAttribArray(this.#corner);
    gl.vertexAttribPointer(this.#corner, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1f(this.#uniforms.u_distance, distance);
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

      for (const side of SIDES) {
        const size = this.#sizes[side];
        if (size.width === 0) {
          continue;
        }
        const halfWidth = width / 2;
        const halfHeight = (halfWidth * size.height) / size.width;
        const center = centerFor(this.#configuration, side);
        gl.uniform2f(this.#uniforms.u_half_extent, halfWidth, halfHeight);
        gl.uniform2f(this.#uniforms.u_center, center[0], center[1]);
        gl.bindTexture(gl.TEXTURE_2D, this.#textures[side]);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    }
  }

  close() {
    this.#closed = true;
    if (this.#websocket) {
      this.#websocket.close();
      this.#websocket = null;
    }
    for (const side of SIDES) {
      this.#decodeSequences[side] += 1;
      if (this.#pending[side]) {
        this.#pending[side].close();
        this.#pending[side] = null;
      }
    }
  }
}

export function createWristPanels(configuration, options) {
  return new WristPanels(configuration, options);
}
