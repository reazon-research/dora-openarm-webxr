// Copyright 2026 Enactic, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

// Draws the left and right wrist cameras as small head-locked panels. Each
// panel is rendered into both headset eyes; "left" and "right" describe the
// panel positions and robot cameras, not the headset eyes.

import { createVideoSource } from "./video-source.js";

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
uniform float u_opacity;
varying vec2 v_uv;
void main() {
  gl_FragColor = vec4(texture2D(u_texture, v_uv).rgb, u_opacity);
}
`;

const SIDES = ["left", "right"];
const DEFAULT_PANEL = {
  // Matches PANEL_DISTANCE in hud.js: every head-locked element shares one
  // plane, so the eyes never reverge moving between them.
  distance: 1.2,
  width: 0.38,
  leftCenter: [-0.55, 0.0],
  rightCenter: [0.55, 0.0],
  // How solid the panels are over the view they cover. Below 1 the scene
  // behind shows through, so a panel costs awareness of what is around it
  // rather than taking a bite out of it.
  opacity: 1.0,
  // How much larger a panel is drawn while its thumbstick zoom is on. The
  // panel grows about its own center, so where it hangs does not change.
  zoom: 2.0,
};

// Bounds on the configured zoom. Below 1 the button would shrink the panel,
// which is not what pressing it asks for, and a mistyped large value would
// leave one wrist video across the whole view with no way back but the
// button that caused it.
const ZOOM_RANGE = { minimum: 1.0, maximum: 4.0 };

// The gripper's force, as a strip immediately below each wrist video. Below
// rather than over it: the bottom of a wrist view is where the fingers and the
// object are, which is the last part of that image worth covering.
//
// Drawn under *both* videos, with the same numbers in each, because one grip
// sets the force for both arms. The operator reads it beside whichever hand
// they are already looking at rather than having to look away to the robot
// panel, which is the point of moving it here.
//
// Colour carries the state as the mode banner's does, so a softened gripper is
// noticeable without reading the text -- going for something heavy in soft mode
// fails quietly otherwise, and that is worth knowing before the attempt rather
// than after it slips.
const CAPTION = {
  // Wide enough for the longest label the node emits ("SOFT 100%") plus both
  // numbers, at the font below. The strip's height in the world follows this
  // aspect ratio, so the text is never stretched.
  texture: { width: 448, height: 56 },
  font: "bold 26px monospace",
  labelColor: "#0d1117",
  hard: "#8b949e",
  soft: "#d29922",
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
  #sources = { left: null, right: null };
  #sizes = {
    left: { width: 0, height: 0 },
    right: { width: 0, height: 0 },
  };
  #configuration = null;
  #clears = false;
  // Null until a gripper-mode node publishes. Nothing is drawn until then, so
  // a dataflow without that node shows the videos exactly as before.
  #gripperName = null;
  #gripperSpeed = 0;
  #gripperTorque = 0;
  #captionContext = null;
  #captionTexture = null;
  #captionStale = false;
  // Which panels are drawn enlarged, and the thumbstick state each was last
  // told, so the toggle happens once per press rather than once per frame.
  #zoomed = { left: false, right: false };
  #zoomPressed = { left: false, right: false };

  constructor(configuration, tracks, { clears }) {
    this.#configuration = configuration.wrist_panels || {};
    this.#clears = clears;
    for (const side of SIDES) {
      const track = tracks?.[`wrist-${side}`];
      this.#sources[side] = track ? createVideoSource(track) : null;
    }
  }

  setZoomButton(side, pressed) {
    // The thumbstick arrives as a level once per frame, the way the HUD's
    // X button does, so the press edge is found here: the panel toggles when
    // the button goes down and stays as it is until the next press. An absent
    // or asleep controller reports nothing, which reads as released and
    // leaves the panel wherever the last press put it.
    if (!(side in this.#zoomed)) {
      return;
    }
    const down = pressed === true;
    if (down && !this.#zoomPressed[side]) {
      this.#zoomed[side] = !this.#zoomed[side];
    }
    this.#zoomPressed[side] = down;
  }

  setGripperMode(name, speedRadS, torqueNm) {
    if (
      typeof name !== "string" ||
      !Number.isFinite(speedRadS) ||
      !Number.isFinite(torqueNm)
    ) {
      return;
    }
    if (
      name === this.#gripperName &&
      speedRadS === this.#gripperSpeed &&
      torqueNm === this.#gripperTorque
    ) {
      return;
    }
    this.#gripperName = name;
    this.#gripperSpeed = speedRadS;
    this.#gripperTorque = torqueNm;
    // Repainted on the next frame rather than here: this arrives on a socket
    // callback, which is not inside the GL context's frame.
    this.#captionStale = true;
  }

  #uploadCaption() {
    if (!this.#captionStale || this.#gripperName === null) {
      return;
    }
    const gl = this.#gl;
    const context = this.#captionContext;
    const { width, height } = CAPTION.texture;
    // "SOFT", "SOFT 60%" and "MEDIUM" all mean softened; only the default pair
    // is named HARD, which the node does in every one of its mappings.
    context.fillStyle =
      this.#gripperName === "HARD" ? CAPTION.hard : CAPTION.soft;
    context.fillRect(0, 0, width, height);
    context.fillStyle = CAPTION.labelColor;
    context.font = CAPTION.font;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(
      `${this.#gripperName}  ${this.#gripperTorque.toFixed(2)}Nm  ` +
        `${Math.round(this.#gripperSpeed)}r/s`,
      width / 2,
      height / 2,
    );
    gl.bindTexture(gl.TEXTURE_2D, this.#captionTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.#captionContext.canvas,
    );
    this.#captionStale = false;
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
      "u_opacity",
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

    const canvas = document.createElement("canvas");
    canvas.width = CAPTION.texture.width;
    canvas.height = CAPTION.texture.height;
    this.#captionContext = canvas.getContext("2d");
    // One canvas and one texture for both strips: the two carry identical text,
    // because one grip sets the force for both arms.
    this.#captionTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.#captionTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  #upload() {
    const gl = this.#gl;
    gl.activeTexture(gl.TEXTURE0);
    for (const side of SIDES) {
      const source = this.#sources[side];
      if (!source) {
        continue;
      }
      const size = source.upload(gl, this.#textures[side]);
      if (size) {
        this.#sizes[side] = size;
      }
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

    this.#upload();
    this.#uploadCaption();
    const distance = finiteNumber(
      this.#configuration.distance,
      DEFAULT_PANEL.distance,
    );
    const width = finiteNumber(this.#configuration.width, DEFAULT_PANEL.width);
    const configured = finiteNumber(
      this.#configuration.opacity,
      DEFAULT_PANEL.opacity,
    );
    const opacity = Math.min(1, Math.max(0.05, configured));
    const zoom = Math.min(
      ZOOM_RANGE.maximum,
      Math.max(
        ZOOM_RANGE.minimum,
        finiteNumber(this.#configuration.zoom, DEFAULT_PANEL.zoom),
      ),
    );
    // Only blended when it would do something. A fully solid panel is drawn
    // the way it always was, so nothing changes for a view that never asked
    // for transparency.
    if (opacity < 1) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    } else {
      gl.disable(gl.BLEND);
    }

    gl.useProgram(this.#program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#buffer);
    gl.enableVertexAttribArray(this.#corner);
    gl.vertexAttribPointer(this.#corner, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1f(this.#uniforms.u_distance, distance);
    gl.uniform1f(this.#uniforms.u_opacity, opacity);
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

      // Depth testing is off, so the later draw wins where two panels meet.
      // An enlarged panel goes last for that reason: it is the one the
      // operator just asked to look at.
      const order = [
        ...SIDES.filter((side) => !this.#zoomed[side]),
        ...SIDES.filter((side) => this.#zoomed[side]),
      ];
      for (const side of order) {
        const size = this.#sizes[side];
        if (size.width === 0) {
          continue;
        }
        const halfWidth = (width * (this.#zoomed[side] ? zoom : 1)) / 2;
        const halfHeight = (halfWidth * size.height) / size.width;
        const center = centerFor(this.#configuration, side);
        gl.uniform2f(this.#uniforms.u_half_extent, halfWidth, halfHeight);
        gl.uniform2f(this.#uniforms.u_center, center[0], center[1]);
        gl.bindTexture(gl.TEXTURE_2D, this.#textures[side]);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        if (this.#gripperName !== null) {
          const captionHalfHeight =
            (halfWidth * CAPTION.texture.height) / CAPTION.texture.width;
          gl.uniform2f(
            this.#uniforms.u_half_extent,
            halfWidth,
            captionHalfHeight,
          );
          // Flush against the bottom edge of the video above it, so the pair
          // reads as one unit however the panel is sized or placed.
          gl.uniform2f(
            this.#uniforms.u_center,
            center[0],
            center[1] - halfHeight - captionHalfHeight,
          );
          // Always solid, even where the videos are see-through: this is a
          // small strip, so it costs almost no awareness of the room, and it
          // is the one element here whose text has to stay legible over
          // whatever happens to be behind it.
          gl.uniform1f(this.#uniforms.u_opacity, 1.0);
          gl.bindTexture(gl.TEXTURE_2D, this.#captionTexture);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          gl.uniform1f(this.#uniforms.u_opacity, opacity);
        }
      }
    }
    // Handed back off, so the instruction and HUD passes after this one manage
    // their own blending as they did before.
    gl.disable(gl.BLEND);
  }

  close() {
    for (const side of SIDES) {
      if (this.#sources[side]) {
        this.#sources[side].close();
        this.#sources[side] = null;
      }
    }
  }
}

export function createWristPanels(configuration, tracks, options) {
  return new WristPanels(configuration, tracks, options);
}
