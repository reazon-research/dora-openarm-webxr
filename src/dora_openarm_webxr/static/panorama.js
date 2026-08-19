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
  gl_FragColor = texture2D(u_texture, uv);
}
`;

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
    gl.uniform1f(
      this.#uniforms.u_yaw_offset,
      (this.#configuration.theta360?.yaw_offset_deg || 0) / 360.0,
    );

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
