// Copyright 2026 Enactic, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

// Draws a mono equirectangular THETA preview around the viewer. Only the
// headset orientation is used, so translation cannot create false parallax.

const VERTEX_SHADER = `
attribute vec2 a_corner;
varying vec2 v_ndc;
void main() {
  v_ndc = a_corner;
  gl_Position = vec4(a_corner, 1.0, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D u_texture;
uniform vec2 u_projection_scale;
uniform vec2 u_projection_offset;
uniform vec4 u_orientation;
uniform float u_yaw_offset;
uniform float u_opacity;
varying vec2 v_ndc;

vec3 rotateByQuaternion(vec3 point, vec4 quaternion) {
  return point + 2.0 * cross(
    quaternion.xyz,
    cross(quaternion.xyz, point) + quaternion.w * point
  );
}

void main() {
  vec3 viewDirection = normalize(vec3(
    (v_ndc.x + u_projection_offset.x) / u_projection_scale.x,
    (v_ndc.y + u_projection_offset.y) / u_projection_scale.y,
    -1.0
  ));
  vec3 direction = rotateByQuaternion(viewDirection, u_orientation);
  float longitude = atan(direction.x, -direction.z);
  float latitude = asin(clamp(direction.y, -1.0, 1.0));
  vec2 uv = vec2(
    fract(0.5 + longitude / 6.28318530718 + u_yaw_offset),
    0.5 - latitude / 3.14159265359
  );
  gl_FragColor = vec4(texture2D(u_texture, uv).rgb, u_opacity);
}
`;

// A rear-view window beside the robot panel at the foot of the view. Placed in
// viewer-space meters, like the HUD panels, rather than as a fraction of the
// display: the two sit shoulder to shoulder and have to keep agreeing on a
// baseline, which they cannot do in different coordinate systems. The window
// is shorter than the panel and centered against it, so keep `centerY` in step
// with the panel's own, and `centerX` in step with the width of both, or the
// pair stops sitting centered in the view.
//
// The whole sphere is already resident as a texture, so looking behind costs
// no bandwidth and no robot motion: it is the same image sampled half a turn
// around. That is the one thing a panorama can do that a steerable camera
// cannot, and it is why this is a few uniforms rather than a second downlink.
export const REAR_VIEW = {
  // centerX is computed by layoutRearView, never set by hand: it depends on
  // how wide the window and the panel beside it are, and the two have to stay
  // centered in the view as a pair.
  centerX: 0,
  centerY: -0.7,
  distance: 1.2,
  width: 0.56,
  height: 0.3131,
  // Between the window and the panel.
  gap: 0.06,
  // Narrower than the headset's own field of view, so the window is a zoomed
  // look behind rather than the whole rear hemisphere squeezed into a corner.
  // Defaults only. Both are meant to be tuned per robot and per task, so the
  // view configuration file owns them: set `rear_view_field_of_view_deg` and
  // `rear_view_pitch_down_deg` in its `theta360` section, beside the yaw
  // offset. A value outside its range falls back to the default here rather
  // than producing a projection that cannot exist.
  fieldOfViewDegrees: 120,
  // How solid the window is over the view it covers. Below 1 the scene in
  // front shows through it, so the window costs the operator awareness of what
  // is ahead rather than taking a bite out of it. Its frame stays solid, so
  // the edge is still readable however faint the contents are.
  opacity: 0.75,
  pitchDownDegrees: 50,
  borderPixels: 3,
  borderColor: [0.35, 0.65, 1.0, 1.0],
};

// Where the window lands on one eye, from its viewer-space placement. This
// inverts the ray reconstruction the fragment shader does: that shader turns a
// pixel into a direction, and this turns a point at `distance` back into
// pixels, so the window lines up with a HUD panel given the same numbers.
function rearViewportRect(view, viewport) {
  const scaleX = view.projectionMatrix[0];
  const scaleY = view.projectionMatrix[5];
  const offsetX = view.projectionMatrix[8];
  const offsetY = view.projectionMatrix[9];
  const distance = REAR_VIEW.distance;
  const toPixels = (value, scale, offset, origin, size) =>
    origin + ((scale * (value / distance) - offset + 1) / 2) * size;

  const left = toPixels(
    REAR_VIEW.centerX - REAR_VIEW.width / 2,
    scaleX, offsetX, viewport.x, viewport.width,
  );
  const right = toPixels(
    REAR_VIEW.centerX + REAR_VIEW.width / 2,
    scaleX, offsetX, viewport.x, viewport.width,
  );
  const bottom = toPixels(
    REAR_VIEW.centerY - REAR_VIEW.height / 2,
    scaleY, offsetY, viewport.y, viewport.height,
  );
  const top = toPixels(
    REAR_VIEW.centerY + REAR_VIEW.height / 2,
    scaleY, offsetY, viewport.y, viewport.height,
  );

  // Clamped so a narrow headset field of view shrinks the window rather than
  // scissoring outside its own eye and drawing over the other one.
  const x0 = Math.round(Math.max(left, viewport.x));
  const x1 = Math.round(Math.min(right, viewport.x + viewport.width));
  const y0 = Math.round(Math.max(bottom, viewport.y));
  const y1 = Math.round(Math.min(top, viewport.y + viewport.height));
  if (x1 - x0 < 1 || y1 - y0 < 1) {
    return null;
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

// Size the window from the view configuration and place it beside the robot
// panel, moving the panel too so the two stay centered in the view as a pair.
// Called once at session setup, by whoever owns both — the window cannot do it
// alone, since it takes the panel's width to know where either of them goes.
export function layoutRearView(configuration, robotPanel) {
  const setting = (key, fallback, lowest, highest) => {
    const value = configuration?.theta360?.[key];
    return Number.isFinite(value) && value >= lowest && value <= highest
      ? value
      : fallback;
  };
  REAR_VIEW.width = setting("rear_view_width_m", REAR_VIEW.width, 0.05, 2);
  REAR_VIEW.height = setting("rear_view_height_m", REAR_VIEW.height, 0.05, 2);
  if (!robotPanel) {
    REAR_VIEW.centerX = 0;
    return;
  }
  const group = robotPanel.width + REAR_VIEW.gap + REAR_VIEW.width;
  robotPanel.centerX = -group / 2 + robotPanel.width / 2;
  REAR_VIEW.centerX = group / 2 - REAR_VIEW.width / 2;
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader));
  }
  return shader;
}

class PanoramaView {
  #gl = null;
  #program = null;
  #buffer = null;
  #corner = null;
  #uniforms = {};
  #texture = null;
  #hasTexture = false;
  #pending = null;
  #queued = null;
  #decoding = false;
  #closed = false;
  #configuration = null;
  #websocket = null;

  constructor(configuration) {
    this.#configuration = configuration;
    const websocket = new WebSocket("wss://" + location.host + "/theta-video");
    websocket.binaryType = "arraybuffer";
    websocket.addEventListener("message", (event) => {
      // A single replaceable slot: never accumulate a decode backlog.
      this.#queued = new Blob([event.data], { type: "image/jpeg" });
      this.#decodeLatest();
    });
    this.#websocket = websocket;
  }

  #decodeLatest() {
    if (this.#decoding || !this.#queued || this.#closed) {
      return;
    }
    const jpeg = this.#queued;
    this.#queued = null;
    this.#decoding = true;
    createImageBitmap(jpeg)
      .then((bitmap) => {
        if (this.#closed) {
          bitmap.close();
          return;
        }
        if (this.#pending) {
          this.#pending.close();
        }
        this.#pending = bitmap;
      })
      .catch(() => {})
      .finally(() => {
        this.#decoding = false;
        this.#decodeLatest();
      });
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
      "u_texture",
      "u_projection_scale",
      "u_projection_offset",
      "u_orientation",
      "u_yaw_offset",
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
    this.#texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.#texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // CLAMP also supports the future 1920x960 non-power-of-two preview.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  #upload() {
    if (!this.#pending) {
      return;
    }
    const bitmap = this.#pending;
    this.#pending = null;
    const gl = this.#gl;
    gl.bindTexture(gl.TEXTURE_2D, this.#texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    bitmap.close();
    this.#hasTexture = true;
  }

  render(session, space, frame) {
    if (!this.#gl) {
      return;
    }
    const pose = frame.getViewerPose(space);
    if (!pose) {
      return;
    }
    this.#upload();
    if (!this.#hasTexture) {
      return;
    }

    const gl = this.#gl;
    const layer = session.renderState.baseLayer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
    gl.clearColor(0.0, 0.0, 0.0, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.#program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#buffer);
    gl.enableVertexAttribArray(this.#corner);
    gl.vertexAttribPointer(this.#corner, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.#texture);
    gl.uniform1i(this.#uniforms.u_texture, 0);
    const yawOffset =
      (this.#configuration.theta360?.yaw_offset_deg || 0) / 360.0;
    gl.uniform1f(this.#uniforms.u_yaw_offset, yawOffset);
    // The panorama itself is the world, never seen through.
    gl.uniform1f(this.#uniforms.u_opacity, 1);

    for (const view of pose.views) {
      const viewport = layer.getViewport(view);
      gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
      gl.uniform2f(
        this.#uniforms.u_projection_scale,
        view.projectionMatrix[0],
        view.projectionMatrix[5],
      );
      gl.uniform2f(
        this.#uniforms.u_projection_offset,
        view.projectionMatrix[8],
        view.projectionMatrix[9],
      );
      const orientation = view.transform.orientation;
      gl.uniform4f(
        this.#uniforms.u_orientation,
        orientation.x,
        orientation.y,
        orientation.z,
        orientation.w,
      );
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    this.#renderRearView(pose, layer, yawOffset);
  }

  #rearSetting(key, fallback, lowest, highest) {
    const value = this.#configuration.theta360?.[key];
    return Number.isFinite(value) && value >= lowest && value <= highest
      ? value
      : fallback;
  }

  #renderRearView(pose, layer, yawOffset) {
    const gl = this.#gl;
    const fieldOfView = this.#rearSetting(
      "rear_view_field_of_view_deg",
      REAR_VIEW.fieldOfViewDegrees,
      1,
      179,
    );
    const pitchDown = this.#rearSetting(
      "rear_view_pitch_down_deg",
      REAR_VIEW.pitchDownDegrees,
      -90,
      90,
    );
    const opacity = this.#rearSetting(
      "rear_view_opacity",
      REAR_VIEW.opacity,
      0.05,
      1,
    );
    // Half a turn in texture space is exactly the view behind, so the window
    // reuses the panorama shader untouched — same program, same texture, three
    // uniforms different.
    gl.uniform1f(this.#uniforms.u_yaw_offset, yawOffset + 0.5);
    gl.uniform2f(this.#uniforms.u_projection_offset, 0, 0);
    // Held against the robot instead of following the head. A mirror bolted to
    // a vehicle shows the same thing however the driver turns; sliding its
    // contents as the operator looked around would make it useless for judging
    // what is behind while backing up. The only rotation is the fixed downward
    // tilt, about x, which is negative because a positive turn about x aims up.
    const halfPitch = (-pitchDown * Math.PI) / 360;
    gl.uniform4f(
      this.#uniforms.u_orientation,
      Math.sin(halfPitch),
      0,
      0,
      Math.cos(halfPitch),
    );
    gl.uniform1f(this.#uniforms.u_opacity, opacity);
    // Blended over the panorama already drawn, which is what the window is
    // see-through *to*. Turned back off below so the wrist and HUD passes
    // manage their own blending as they did before.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const halfFov = (fieldOfView * Math.PI) / 360;
    const scale = 1 / Math.tan(halfFov);
    const border = REAR_VIEW.borderPixels;
    gl.enable(gl.SCISSOR_TEST);
    for (const view of pose.views) {
      const viewport = layer.getViewport(view);
      const rect = rearViewportRect(view, viewport);
      if (!rect) {
        continue;
      }
      const { x, y, width, height } = rect;

      // The frame is four scissored clears, which need no second program.
      // Four rather than one covering the lot: a clear cannot blend, so
      // painting the whole rectangle would put an opaque backing behind the
      // window and there would be nothing left to see through it to.
      gl.clearColor(...REAR_VIEW.borderColor);
      for (const strip of [
        [x - border, y - border, border, height + border * 2],
        [x + width, y - border, border, height + border * 2],
        [x, y + height, width, border],
        [x, y - border, width, border],
      ]) {
        gl.scissor(...strip);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }

      gl.scissor(x, y, width, height);
      gl.viewport(x, y, width, height);
      // Negative x flips the ray, so the window reads like a car's rear-view
      // mirror: something behind and to the left shows on the left, which is
      // what the operator needs when steering the base backward.
      gl.uniform2f(this.#uniforms.u_projection_scale, -scale, (scale * width) / height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
  }

  close() {
    this.#closed = true;
    this.#queued = null;
    if (this.#pending) {
      this.#pending.close();
      this.#pending = null;
    }
    if (this.#websocket) {
      this.#websocket.close();
      this.#websocket = null;
    }
  }
}

export function createPanoramaView(configuration) {
  return new PanoramaView(configuration);
}
