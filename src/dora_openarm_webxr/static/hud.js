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

// Values are in viewer-space meters, so the panels follow the headset without
// reacting to a head turn. The timer and robot sit centered above and below the
// view; the temperature stays in the upper-right periphery. Exported so the
// preview harness can lay the panels out from the same numbers the headset uses.
// Every head-locked element sits on this one plane — the panels here, the
// reticle below, the wrist cameras, and the rear-view window in panorama.js.
// Mixed distances make the eyes reverge between neighbours, which reads as the
// HUD coming apart into layers rather than being one surface.
export const PANEL_DISTANCE = 1.2;

export const PANELS = [
  {
    id: "timer",
    canvas: { width: 320, height: 112 },
    distance: PANEL_DISTANCE,
    width: 0.25,
    centerX: 0,
    centerY: 0.45,
  },
  {
    // Kept in the upper-right periphery: visible at a glance without covering
    // either the central task area or the right wrist camera below it.
    id: "temperature",
    canvas: { width: 256, height: 72 },
    distance: PANEL_DISTANCE,
    width: 0.2,
    centerX: 0.55,
    centerY: 0.45,
  },
  {
    // One unit with the rear-view window on its right, at the foot of the
    // view. `centerX` is overwritten by layoutRearView once the window's size
    // is known, so the pair sits centered however wide the window is; the
    // value here only stands in for a session without a panorama. `centerY`
    // is the pair's shared center line and must match REAR_VIEW's.
    id: "robot",
    canvas: { width: 240, height: 340 },
    distance: PANEL_DISTANCE,
    width: 0.26,
    centerX: 0,
    centerY: -0.7,
  },
];
const RETICLE = { defaultDistance: PANEL_DISTANCE, angularSize: 0.012 };

// The figure rides lower than the lifter's travel alone would put it, so the
// arms have somewhere to go when they swing up: at full lift with a shoulder
// near its upper limit, the arm and its letter reach a long way above the hip,
// and the banner is what they would otherwise run into.
const LIFTER = {
  centerX: 120,
  minHipY: 178,
  travel: 55,
  spine: 36, // hip to shoulder
  neck: 28, // shoulder to the head's center
  headRadius: 17,
};

// The base is drawn from above while the body above it is drawn from the
// side, so the square can turn on the spot and read as a heading. Its center
// is the rotation axis, which is also where the lifter column stands, so the
// column is drawn from there and stays put while the square turns under it.
// A bare square is symmetric every 90 degrees and could not show a heading at
// all, so the head circle rides near the front edge and breaks that symmetry.
const BASE = {
  centerY: 246,
  half: 40,
  headOffset: 26,
  headRadius: 12,
};
// One panel carries the whole robot rather than three panels taking view
// space: the swerve base below, the upper body standing on it, and a banner
// naming which of the two the sticks are driving. Both halves are always
// drawn, because both are always there — a right-grip press only moves which
// one the operator is holding. The idle half is grayed, which is literal: the
// press freezes it where it stood. The banner sits under the base, at the foot
// of the panel: the figure grows upward as the lifter rises and the arms swing
// up, so the top is the edge that has to stay clear.
const IDLE = "#6e7681";
const IDLE_PALE = "#9198a1";
const MODE = {
  bannerHeight: 28,
  font: "bold 19px monospace",
  labelColor: "#0d1117",
  torso: {
    label: "TORSO",
    banner: "#58a6ff",
    torso: "#58a6ff",
    armRight: "#58a6ff",
    armLeft: "#a5d6ff",
    base: IDLE,
  },
  drive: {
    label: "DRIVE",
    banner: "#f0883e",
    torso: IDLE,
    armRight: IDLE,
    armLeft: IDLE_PALE,
    base: "#f0883e",
  },
};

// The arms hang off the shoulder inside the waist rotation, so what the panel
// shows is the shoulder angle against the torso rather than against the room —
// which is the angle that decides whether a grasp clears the body.
// A side view puts both arms on the same spot, so a symmetric two-handed pose
// would hide one stick behind the other and look identical to one arm having
// gone dead. Two tints drawn semi-transparent keep an exact overlap legible as
// an overlap: the tints blend rather than one simply winning.
const ARM = {
  length: 42,
  lineWidth: 7,
  alpha: 0.78,
  labelOffset: 17,
  // Nudges the two letters apart so both stay readable when the arms sit at
  // the same angle, which is exactly when the sticks overlap and the letters
  // are the only thing telling them apart. Applied square to the stick rather
  // than across the screen: a screen-horizontal nudge also runs along the arm,
  // which pushed one letter out to arm's length while dragging the other back
  // almost onto the tip as soon as the arms swung forward.
  labelSpread: 7,
  labelFont: "bold 18px monospace",
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
  #boardTemperature = null;
  #displayedBoardTemperature = null;
  // Matches the swerve lock's startup default: the upper body owns the sticks
  // until the first grip press, so the HUD is right before the first message.
  #baseEngaged = false;
  // Radians. Odometry starts its integral at zero when the dataflow comes up,
  // which is the base's homed heading, so a fresh session starts the square
  // square-on — the same neutral the operator feels themselves to be in.
  #baseHeading = 0;
  #displayedBaseHeading = 0;
  // Radians, zero hanging straight down. Both arms start there so an idle
  // panel reads as a robot at rest rather than one flung out sideways.
  #armRightJ1 = 0;
  #armLeftJ1 = 0;
  #displayedArmRightJ1 = 0;
  #displayedArmLeftJ1 = 0;
  // The gripper readout is drawn under the wrist videos rather than on these
  // panels -- it belongs beside the fingers it describes. This socket is still
  // the only one carrying it, so the message is handed straight on.
  #onGripperMode = null;

  constructor({ clears, reticleDistance, onGripperMode }) {
    this.#clears = clears;
    this.#onGripperMode = onGripperMode ?? null;
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
        } else if (message.type === "arm-j1-right") {
          this.setArmJ1("right", message.value);
        } else if (message.type === "arm-j1-left") {
          this.setArmJ1("left", message.value);
        } else if (message.type === "base-heading") {
          this.setBaseHeading(message.value);
        } else if (message.type === "mode") {
          this.setBaseEngaged(message.base_engaged);
        } else if (message.type === "theta-board-temperature") {
          this.setBoardTemperature(message.value_celsius);
        } else if (message.type === "gripper") {
          this.#onGripperMode?.(
            message.name,
            message.speed_rad_s,
            message.torque_nm,
          );
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

  setBoardTemperature(value) {
    if (!Number.isFinite(value) || value < -10 || value > 100) {
      return;
    }
    this.#boardTemperature = value;
    const displayed = Math.round(value);
    if (displayed !== this.#displayedBoardTemperature) {
      this.#displayedBoardTemperature = displayed;
      this.#stale = true;
    }
  }

  setArmJ1(side, radians) {
    if (!Number.isFinite(radians)) {
      return;
    }
    // Whole degrees only, as for the heading: these arrive on the leader tick
    // and a redraw the operator cannot see still costs a texture upload.
    const displayed = Math.round((radians * 180) / Math.PI);
    if (side === "right") {
      this.#armRightJ1 = radians;
      if (displayed !== this.#displayedArmRightJ1) {
        this.#displayedArmRightJ1 = displayed;
        this.#stale = true;
      }
    } else {
      this.#armLeftJ1 = radians;
      if (displayed !== this.#displayedArmLeftJ1) {
        this.#displayedArmLeftJ1 = displayed;
        this.#stale = true;
      }
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

  #drawTorso(context, colors) {
    const hipY = LIFTER.minHipY - this.#waistHeight * LIFTER.travel;
    const shoulderY = hipY - LIFTER.spine;
    const headY = shoulderY - LIFTER.neck;

    context.save();
    context.lineCap = "round";
    context.strokeStyle = colors.torso;
    context.fillStyle = colors.torso;
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

    const waistRadians = (this.#waistAngle * Math.PI) / 180;
    context.save();
    context.translate(LIFTER.centerX, hipY);
    context.rotate(waistRadians);
    context.beginPath();
    context.moveTo(0, 0);
    context.lineTo(0, shoulderY - hipY);
    context.stroke();
    context.lineWidth = 5;
    context.beginPath();
    context.arc(0, headY - hipY, LIFTER.headRadius, 0, Math.PI * 2);
    context.stroke();

    // Zero hangs the arm straight down and a positive angle swings it forward,
    // matching the waist, which leans forward on a positive angle too.
    context.lineWidth = ARM.lineWidth;
    context.font = ARM.labelFont;
    context.textAlign = "center";
    context.textBaseline = "middle";
    for (const arm of [
      { angle: this.#armLeftJ1, tint: colors.armLeft, label: "L", nudge: -1 },
      { angle: this.#armRightJ1, tint: colors.armRight, label: "R", nudge: 1 },
    ]) {
      const shoulder = shoulderY - hipY;
      const unitX = Math.sin(arm.angle);
      const unitY = Math.cos(arm.angle);

      context.globalAlpha = ARM.alpha;
      context.strokeStyle = arm.tint;
      context.beginPath();
      context.moveTo(0, shoulder);
      context.lineTo(unitX * ARM.length, shoulder + unitY * ARM.length);
      context.stroke();

      // Just past the tip, and upright: undoing the waist rotation keeps the
      // letters readable when the torso folds, and full opacity keeps them
      // crisp while the sticks themselves stay translucent to overlap well.
      const spread = arm.nudge * ARM.labelSpread;
      context.save();
      context.globalAlpha = 1;
      context.translate(
        unitX * (ARM.length + ARM.labelOffset) + unitY * spread,
        shoulder + unitY * (ARM.length + ARM.labelOffset) - unitX * spread,
      );
      context.rotate(-waistRadians);
      context.fillStyle = arm.tint;
      context.fillText(arm.label, 0, 0);
      context.restore();
    }
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
    // without the operator having to focus on the label to be sure. Under the
    // base rather than over the head: the figure only ever grows upward, so
    // this is the one edge it can never reach.
    const bannerY = panel.canvas.height - MODE.bannerHeight;
    context.fillStyle = mode.banner;
    context.fillRect(0, bannerY, panel.canvas.width, MODE.bannerHeight);
    context.fillStyle = MODE.labelColor;
    context.font = MODE.font;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(
      mode.label,
      panel.canvas.width / 2,
      bannerY + MODE.bannerHeight / 2,
    );

    // Base first: the column and the hip joint sit on top of it, so drawing
    // the body second keeps that junction readable at every heading.
    this.#drawBase(context, mode.base);
    this.#drawTorso(context, mode);
  }

  #drawTemperature() {
    const panel = PANELS.find(({ id }) => id === "temperature");
    const context = this.#contexts.get("temperature");
    context.clearRect(0, 0, panel.canvas.width, panel.canvas.height);
    if (this.#boardTemperature === null) {
      return;
    }

    context.fillStyle = "rgba(13, 17, 23, 0.78)";
    context.fillRect(0, 0, panel.canvas.width, panel.canvas.height);
    context.textBaseline = "middle";
    context.fillStyle = "#8b949e";
    context.font = "bold 19px monospace";
    context.textAlign = "left";
    context.fillText("THETA BOARD", 14, panel.canvas.height / 2);
    context.fillStyle = "#ffffff";
    context.font = "bold 30px monospace";
    context.textAlign = "right";
    context.fillText(
      `${this.#displayedBoardTemperature}°C`,
      panel.canvas.width - 14,
      panel.canvas.height / 2,
    );
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
    this.#drawTemperature();
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
        gl.uniform2f(this.#uniforms.u_center, panel.centerX, panel.centerY);
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
