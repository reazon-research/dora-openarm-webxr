# dora-openarm-webxr

A [dora-rs](https://dora-rs.ai) node that reads the pose and
controller state of a VR device such as Meta Quest 3 or PICO 4 through
[WebXR](https://developer.mozilla.org/en-US/docs/Web/API/WebXR_Device_API)
and publishes them to a dora-rs dataflow. You can use it for OpenArm
teleoperation with a VR device.

Everything the VR device and this node say to each other rides one
WebRTC peer connection: controller poses arrive on an unreliable data
channel, and the head camera leaves on video tracks. Poses are dropped
rather than retransmitted, because only the newest pose is worth
anything to a robot.

## Install

```bash
pip install dora-openarm-webxr
```

## Setup

This dora-rs node starts a Web server because WebXR runs as JavaScript
in the Web browser on a VR device. The VR device connects to this
server to stream its pose and controller state.

WebXR requires HTTPS of any page it runs in, so a node that serves the
page itself needs a certificate. A self-signed certificate is enough
because the dora-rs node and the VR device communicate only within your
local network. You can generate one with
[`example/prepare_tls.sh`](example/prepare_tls.sh):

```bash
git clone https://github.com/enactic/dora-openarm-webxr.git
cd dora-openarm-webxr
example/prepare_tls.sh ${YOUR_HOST_NAME}
```

Replace `${YOUR_HOST_NAME}` with a host name that your VR device can
resolve. A `.local` host name configured automatically by Avahi is a
convenient choice. You can check whether your `.local` host name is
available with the following command:

```bash
avahi-resolve --name $(hostname).local
```

If it resolves to your host's IP address, you can generate the
self-signed certificate with the following command line:

```bash
example/prepare_tls.sh $(hostname).local
```

This writes `server.crt` and `server.key` (and the `root.*` files used
to sign them) into the `example/` directory.

You can run
[`example/dataflow_mujoco.yaml`](example/dataflow_mujoco.yaml) with the
generated self-signed certificate by the following command lines:

```bash
pip install dora-rs-cli
dora build example/dataflow_mujoco.yaml
TLS_CERTIFICATE_FILE=server.crt TLS_KEY_FILE=server.key dora run example/dataflow_mujoco.yaml
```

Open http://localhost:8000/ on the local machine for
[dora-openarm-data-collection-ui](https://github.com/enactic/dora-openarm-data-collection-ui).

Open `https://$(hostname).local:8443/` in the Web browser on your VR
device, not in the browser on your local machine. Because the
certificate is self-signed, the Web browser shows a security
warning. You can continue to the page from its "Advanced" options.

Press the "Start" button on the page to start teleoperation with your
VR device.

## WebRTC-only mode

By default this node serves the page itself, which is why it needs a
certificate. Pass `--offer` (or set `OFFER`) to run it as a pure WebRTC
peer instead, with **no HTTP server and no certificate at all**: another
service hosts the page and brokers signaling, and this node only runs
the robot side of the connection.

This is what removes the certificate from the robot machine. WebRTC
authenticates itself with a self-signed certificate and an SDP
fingerprint rather than a CA, so the peer that answers needs nothing
installed; the HTTPS that WebXR insists on is the hosting service's
problem, and it already has a certificate a browser trusts. No
`prepare_tls.sh`, and no security warning to step through on the
headset.

- `--offer` / `OFFER` — the browser's SDP offer, handed in at startup.
  Just the bare SDP; the type is always `offer`.
- `--answer-host` / `ANSWER_HOST` (default `127.0.0.1`) and
  `--answer-port` / `ANSWER_PORT` — the TCP host and port this node
  connects to and writes the answer SDP to (then closes). The service
  listening there wraps it back into an `answer` and relays it to the
  browser.
- `--connect-timeout` / `CONNECT_TIMEOUT` (default 60) — how long to
  wait for the browser to connect after the answer is sent. If the
  connection never comes up, the node exits instead of holding a dead
  peer, so a supervisor can restart it for a fresh offer.
- `--ice-servers` / `ICE_SERVERS` — the ICE servers to build the peer
  with, as JSON in the form a browser `RTCPeerConnection` takes:
  `[{"urls": [...], "username": ..., "credential": ...}]`. This is how
  the hosting service passes the short-lived TURN credentials it mints,
  for networks where a direct path cannot be counted on — TURN needs
  credentials, so it cannot live in a default. Unset or empty, the node
  uses a public STUN server only.

This is a **one-shot** connection: the offer is fixed at startup, so the
node runs that single peer for its whole life and reconnecting means
restarting the node. When the browser disconnects, the node exits, since
no other browser can ever take its place. `--host`, `--port` and the TLS
options are ignored in this mode.

The page hosted elsewhere is told how to draw itself over the connection
rather than over HTTP: the node pushes the view configuration and the
calibration flag on a reliable `control` data channel as soon as it
opens. A page this node never served still gets the right view.

## Head camera

This dora-rs node can also show the robot's head camera in the VR
device, so that the operator sees the robot's workspace while
teleoperating.

The node accepts JPEG images on the `camera_head_right` input and
forwards them to the VR device, where they are drawn on a panel locked
to the room: straight ahead of where the headset was when the session
started, at eye height. Both eyes see the same image, and the panel
stays put when the operator moves their head. See
[`example/dataflow_mujoco_camera.yaml`](example/dataflow_mujoco_camera.yaml)
and
[`example/dataflow_mujoco_camera_stereo.yaml`](example/dataflow_mujoco_camera_stereo.yaml).

How the panel is drawn is described by a view configuration file,
passed with `--view-configuration-file`. The node reads it once when
it starts, so restart the dataflow to apply a change. Two keys describe
the view, and they are independent: `view` says how many images are
drawn, `panel.lock` says what they hang off.

`view` is `mono` (one image, from `camera_head_right`), `stereo` (one
per eye, which also needs `camera_head_left`) or `none` (no camera at
all: the operator sees the passthrough and only the controller poses are
used).

`panel.lock` is `room` (the panel stays where the headset was looking
when the session started, so a head turn looks away from it) or `head`
(the panel travels with the operator's gaze).

The example files pair them the two useful ways:

- [`example/view_camera.yaml`](example/view_camera.yaml) — the default
  `mono` view above, locked to the `room`. Parameters: the session mode,
  the panel distance and the panel width (the height follows the image
  aspect ratio).
- [`example/view_camera_stereo.yaml`](example/view_camera_stereo.yaml)
  — the `stereo` view, locked to the `head`, for a side-by-side stereo
  camera such as a ZED Mini.
  [`example/zed_view_parameters.py`](example/zed_view_parameters.py)
  works its camera and alignment parameters out from a ZED camera's
  factory calibration.

Both files also take `pose.frame_offset`: the neutral hand position
relative to the `arm_origin` site in meters, overriding the built-in
default of `[-0.085, 0, -0.14]`.

They also take `pose.neck_pivot_offset`: the operator's eyes to the
neck's rotation axis, in the headset's own frame, overriding the
built-in default of `[0.0, -0.075, 0.080]`. Hand positions are made
relative to that pivot rather than to the headset itself, so turning the
head does not swing the target along the arc the headset travels.
Anatomy varies, so tune it per operator, or measure it as described in
[Calibrating the neck pivot](#calibrating-the-neck-pivot) below;
`[0, 0, 0]` goes back to subtracting the headset position. A measured
offset in `--neck-pivot-file` wins over this one.

## Wrist cameras

JPEG frames received on `camera_wrist_left` and `camera_wrist_right` are shown
as two small, head-locked panels at the left and right sides of the WebXR view.
Each panel is rendered to both headset eyes; the side names identify the
robot camera and panel position, not a headset eye. The wrist stream is
independent of the main head-camera stream and does not delay pose messages.

Wrist panels are enabled by default and remain invisible until their inputs
provide frames. Their viewer-space placement can be tuned in the same view
configuration file used for the head camera:

```yaml
wrist_panels:
  enabled: true
  distance: 1.0
  width: 0.38
  left_center: [-0.55, 0.0]
  right_center: [0.55, 0.0]
```

Distances and centers are in meters; positive x is right and positive y is up.
Set `enabled: false` to avoid opening the wrist video stream. In the Dora
dataflow, give both camera inputs `queue_size: 1` so stale frames are dropped
instead of building latency.

## Head-locked HUD

Every camera mode, including `mono`, `stereo` and `theta360`, shows a compact
timer at the upper center and a normalized lifter pose at the upper right of
the operator's view. The panels omit labels and numeric pose values to keep
the view clear. On the left controller, tap X to start or stop the timer, or
hold X for one second to reset it. A reset hold does not also trigger start or
stop when the button is released. Y remains reserved for neck calibration. A
small green reticle stays fixed at the center of the WebXR and desktop monitor
views. In WebXR it is drawn at the same depth as the configured camera panel.

The lifter pose displays the latest value received on the optional
`waist_height` Dora input. The input is a scalar normalized to `0.0`
(minimum) through `1.0` (maximum); out-of-range values are clamped. The
node does not infer this value from the headset pose. Until an input is
received, the pose starts at the midpoint value `0.5`. The optional
`waist_angle` input tilts the upper body from `0` degrees (upright) through
`90` degrees (forward); it defaults to upright.

Sources often publish robot units rather than the panel's. Set
`WAIST_HEIGHT_FULL_SCALE` and `WAIST_ANGLE_FULL_SCALE` to the raw input value
that should read as the top of a panel's range — the lifter fully raised, or
the waist folded fully forward — and the node scales each reading onto the
range above. A lifter publishing millimetres over a 504 mm screw takes
`WAIST_HEIGHT_FULL_SCALE: 504`; a waist publishing radians on a physical
0-150 degree range takes `WAIST_ANGLE_FULL_SCALE: 2.618`. Both default to the
top of the panel range itself, which is the identity conversion, so a dataflow
already publishing normalized values needs neither. A value that is not
positive and finite is refused with a message on stderr and the default is
used, rather than dividing every reading by zero. Keeping these in the
dataflow is what lets the node draw the pose without knowing the robot.

Below the body the same panel draws the swerve base as a square seen from
above, with a filled circle at its front edge for the robot's head. The square
turns with the heading in the optional `base_pose` input, an `[x, y, theta]`
triple of which only `theta`, in radians, is read. Unlike the poses above it
is not clamped, because a heading wraps and the odometry that publishes it
does not normalize its integral. It starts at zero, which is the base's homed
heading, so a session opens with the square facing the operator's own
forward.

Two sticks hang from the shoulder for the arms, drawn from the optional
`arm_right_j1` and `arm_left_j1` inputs. Each is a whole joint vector whose
first element, the shoulder joint, is the only one read; it is an angle in
radians, zero hanging straight down and positive swinging forward, the way the
waist leans on a positive angle too. Like the heading it is not clamped. The
sticks are drawn inside the waist rotation, so the angle the panel shows is
the arm against the torso rather than against the room. Arms are often mounted
mirrored, one side reporting as a lift what the other reports as a drop; set
`ARM_RIGHT_J1_SCALE` or `ARM_LEFT_J1_SCALE` to `-1` for whichever side is
inverted, so both swing together. Each defaults to `1`, and a zero or
unreadable setting is refused on stderr rather than pinning an arm to nothing.
A side view puts both arms in the same place, so they are drawn in two tints
at partial transparency: an exact overlap blends instead of hiding one stick,
which would otherwise look the same as an arm whose input has stopped. Each
stick is lettered `L` or `R` at its tip in its own color, drawn upright
through a waist fold and nudged apart horizontally, so the two stay legible
even when the arms hold the same angle.

A banner under the base names which half of the robot the joysticks are
driving, from the optional `base_engaged` input, a scalar that reads as engaged
at or above `0.5`. It sits at the foot of the panel rather than over the head
because the figure only ever grows upward, as the lifter rises and the arms
swing up, so the bottom is the one edge it can never reach. Both halves of the
robot are always drawn, since both are always there; only the coloring moves. A `TORSO` banner draws the body live in blue over a gray
base, meaning the sticks move the lifter and waist. A `DRIVE` banner draws the
base live in amber under a gray body, meaning a grip press has handed the
sticks to the base and frozen the upper body where it stood. The node does not
derive this from the grip button it publishes, so the panel always shows the
state of whichever node owns the handover. Until an input is received the
panel shows `TORSO`, matching that node's startup default.

### Rear-view window

The panorama already holds the whole sphere as one texture, so the view behind
costs no extra bandwidth and no camera motion: it is the same image sampled
half a turn around. It is drawn as a framed window beside the robot panel at
the foot of the view.

It behaves like a mirror bolted to the robot. It does not follow the head, so
it shows the same thing however the operator looks around; it is flipped left
to right, so something behind and to the left appears on the left; and it is
aimed below the horizon, at the floor the base is about to back over.

Tune it in the view configuration's `theta360` section:

```yaml
theta360:
  rear_view_field_of_view_deg: 120  # horizontal slice of the scene behind
  rear_view_pitch_down_deg: 50      # how far below the horizon it looks
  rear_view_width_m: 0.56           # size at the distance it hangs; the robot
  rear_view_height_m: 0.3131        # panel shifts to keep the pair centered
  rear_view_opacity: 0.75           # below 1 the view ahead shows through
```

Each falls back to a default in `static/panorama.js`. The frame stays solid at
any opacity, so the window's edge reads however faint its contents are. The
window is part of the panorama, so it appears only in the `theta360` view and
only in WebXR. `wrist_panels.opacity` does the same for the wrist cameras, and
defaults to `1`.

### One head-locked plane

The timer, the robot panel, the rear-view window, the wrist cameras and the
reticle all hang at the same distance, `PANEL_DISTANCE` in `static/hud.js`.
Mixed distances make the eyes reverge moving between neighbours, which reads as
the HUD coming apart into layers rather than being one surface. The panorama
itself is the exception, and correctly so: it is a sphere at infinity.

## Desktop monitor

Open `https://${HOST_NAME}:8443/monitor` on a PC to watch the camera view
without starting another WebXR session. The page draws the same timer and
lifter-pose HUD over the live image, with wrist-camera frames in the lower
corners. Timer start, stop and reset actions from
the Quest X button are retained by the server, so a monitor opened partway
through a run immediately continues from the current value.

The stereo view defaults to the right eye and offers left-eye and split-screen
buttons. The THETA view is shown as its flat equirectangular preview. Since this
page consumes the application's camera streams, it does not include the Quest
passthrough background or Horizon OS interface.

For example, wire an independently normalized waist signal into the
WebXR node with:

```yaml
inputs:
  waist_height: waist-normalizer/waist_height
  waist_angle: waist-controller/waist_angle
```

## Calibrating the neck pivot

Rather than guessing the offset, measure it: the operator turns their
head, and the node fits the one point that stayed put through the turn.

Calibration is off unless you ask for it. Start the dataflow with
`--calibration`, or `CALIBRATION` in its YAML, for a session that
measures. Without it the Y button is an ordinary button: nothing is
collected and the hands never stop.

```bash
TLS_CERTIFICATE_FILE=server.crt TLS_KEY_FILE=server.key \
  CALIBRATION=true dora run example/dataflow_mujoco.yaml
```

1. Start a session as above. The headset shows what to do, so the
   operator needs nothing else in front of them.
2. Have the operator stand facing the workspace with their feet
   planted.
3. Press and hold the **Y button** on the left controller. The run
   starts at once: the panel turns green and the hands stop following,
   though the gripper still follows the trigger, so leave the triggers
   alone until the run is over.
4. Keeping the body still and the button down, turn the head slowly
   some 40 degrees **side to side**, twice over, and then some 40
   degrees **up and down**, twice over. Four to six seconds in all.
5. Release Y. The fit runs at that moment and the result appears on the
   panel.

Both turn directions are needed: a rotation says nothing about the
offset along the axis it turns about, so shaking only sideways leaves
the vertical offset unmeasured. The lower bounds are a hundred poses
and some 20 degrees about every axis, so the run above has a wide
margin over both.

An accepted run is applied immediately, so the operator can turn their
head and see for themselves whether the target now stays put. It is
also written to `--neck-pivot-file`, which defaults to `neck_pivot.yaml`
in the directory the node runs in, and read back from there at startup:

```yaml
# Measured by dora-openarm-webxr --calibration.
pose:
  neck_pivot_offset: [0.004, -0.081, 0.076]
```

So calibrate once with `--calibration`, then run without it and the
measurement is still in use. The node says so when it reads the file,
and the same document can be pasted into the view configuration file
instead. The node's output carries the run either way:

```
neck pivot calibration applied from 412 poses: the pivot held to 6.1 mm while the headset moved 47.2 mm.
  neck_pivot_offset: [0.004, -0.081, 0.076]
  Written to neck_pivot.yaml, which this node reads at startup.
```

The smaller the distance the pivot held to, and the larger the one the
headset moved, the better the run.

A refused run changes nothing and says on the panel, and on the node's
output, what to do differently: hold Y down longer, add the turn that is
missing, or keep the body still and turn only the head. Holding Y again
starts a fresh run, so it can be repeated until it takes.

## Debug

You can use [Immersive Web
Emulator](https://chromewebstore.google.com/detail/immersive-web-emulator/cgffilbpcibhmcfbgggfhfolhkfbhmik)
and Chrome to debug this node without a VR device.

## Inputs

This dora-rs node accepts the following optional data. Camera inputs provide
the VR image; `waist_height` drives the HUD pose independently of the camera.

| Input                | Type      | Description                                                              |
|----------------------|-----------|--------------------------------------------------------------------------|
| `camera_head_right`  | `uint8[]` | A JPEG image of the robot's head camera.                                 |
| `camera_head_left`   | `uint8[]` | A JPEG image for the left eye. Only used by the stereo view.             |
| `camera_wrist_right` | `uint8[]` | A JPEG image shown in the right-side wrist panel for both eyes.          |
| `camera_wrist_left`  | `uint8[]` | A JPEG image shown in the left-side wrist panel for both eyes.           |
| `waist_height`       | `float32` | Optional normalized lifter height. Values are clamped to `0.0`–`1.0` and displayed in the head-locked HUD. |
| `waist_angle`        | `float32` | Optional upper-body angle in degrees. Values are clamped to `0`–`90`, where `0` is upright. |

## Outputs

This dora-rs node outputs the following data. Pose, trigger, grip and
joystick outputs are sent on each `frame` message received from the VR
device. Button outputs are sent only when the corresponding button is
included in a `frame` message. `pose_reference` is sent whenever the
headset is tracked, even while the controllers are off, and the
controller poses are sent only when it is.

| Output             | Type              | Description                                                                                                                                    |
|--------------------|-------------------|------------------------------------------------------------------------------------------------------------------------------------------------|
| `status`           | `string`          | `"ready"` when a WebXR session is started.                                                                                                      |
| `vr_receive_times` | `int64`           | The timestamp in nanoseconds when a frame is received from the VR device.                                                                       |
| `pose_right`       | `float32[7]`      | The pose of the right controller as `[x, y, z, qw, qx, qy, qz]`, expressed in the scene's `arm_origin` site frame. Position is in meters and orientation is a quaternion. |
| `pose_left`        | `float32[7]`      | The pose of the left controller. The format is the same as `pose_right`.                                                                        |
| `pose_reference`   | `float32[7]`      | The pose of the headset, in the WebXR reference space (x right, y up, -z forward). The hand poses are made relative to this pose, so it is unrotated and unsmoothed and left in the WebXR frame for consumers that drive something from head motion such as a neck. |
| `trigger_right`    | `float32`         | The value of the right trigger from `0.0` (released) to `1.0` (fully pressed).                                                                  |
| `trigger_left`     | `float32`         | The value of the left trigger from `0.0` (released) to `1.0` (fully pressed).                                                                   |
| `grip_right`       | `float32`         | The value of the right grip (squeeze) button from `0.0` (released) to `1.0` (fully pressed).                                                    |
| `grip_left`        | `float32`         | The value of the left grip. The format is the same as `grip_right`.                                                                             |
| `joystick_x_right` | `float32`         | The X axis value of the right joystick.                                                                                                         |
| `joystick_y_right` | `float32`         | The Y axis value of the right joystick.                                                                                                         |
| `joystick_x_left`  | `float32`         | The X axis value of the left joystick.                                                                                                          |
| `joystick_y_left`  | `float32`         | The Y axis value of the left joystick.                                                                                                          |
| `button_a`         | `bool`            | Whether the A button is pressed or not.                                                                                                         |
| `button_b`         | `bool`            | Whether the B button is pressed or not.                                                                                                         |
| `button_x`         | `bool`            | Whether the X button is pressed or not.                                                                                                         |
| `button_y`         | `bool`            | Whether the Y button is pressed or not.                                                                                                         |
| `command`          | `string`          | `"quit"` when the node exits, if `--quit-button` is given -- whatever ended the node: the quit button, the browser leaving, or an error. A [dora-openarm-quitter](https://github.com/enactic/dora-openarm-quitter) node wired to this output ends the rest of the dataflow with it. Nothing else is ever published here. |

`button_y` is published whatever the press does here. In a session
started with `--calibration` it also runs a [neck pivot
calibration](#calibrating-the-neck-pivot) for as long as it is held,
and the hand poses stop until it is released. Without that option the
press does nothing but reach the output, so a dataflow that wires the
button to something the operator holds down is unaffected.

## Command line options

You can configure this dora-rs node by the following command line
options. Each option also has a corresponding environment variable
that is used as the default value. Setting the environment variable is
useful in a dora-rs dataflow YAML.

| Option                   | Environment variable   | Default     | Description                                                                       |
|--------------------------|------------------------|-------------|-----------------------------------------------------------------------------------|
| `--host`                 | `HOST`                 | `0.0.0.0`   | The host that the Web server listens on.                                          |
| `--port`                 | `PORT`                 | `8443`      | The port that the Web server listens on.                                          |
| `--tls-certificate-file` | `TLS_CERTIFICATE_FILE` | (required)  | The TLS certificate file for HTTPS. Required because WebXR requires HTTPS, unless `--offer` is given. |
| `--tls-key-file`         | `TLS_KEY_FILE`         | (required)  | The TLS key file for the certificate file. Required unless `--offer` is given.    |
| `--offer`                | `OFFER`                | (none)      | The browser's SDP offer. Runs the node as a pure WebRTC peer with no HTTP server and no certificate. See [WebRTC-only mode](#webrtc-only-mode). |
| `--answer-host`          | `ANSWER_HOST`          | `127.0.0.1` | The host to write the SDP answer to in WebRTC-only mode.                          |
| `--answer-port`          | `ANSWER_PORT`          | (required with `--offer`) | The port to write the SDP answer to in WebRTC-only mode.            |
| `--connect-timeout`      | `CONNECT_TIMEOUT`      | `60`        | Seconds to wait for the browser to connect in WebRTC-only mode.                   |
| `--quit-button`          | `QUIT_BUTTON`          | (none)      | The controller button (`a`, `b`, `x` or `y`) that shuts the node down when pressed. Giving this option also publishes `"quit"` on the `command` output whenever the node exits, even by an error rather than the button. May be repeated for several buttons; the environment variable takes a comma-separated list. |
| `--view-configuration-file` | `VIEW_CONFIGURATION_FILE` | (none)  | The YAML file that describes how the head camera is drawn in the VR device. Read once when the node starts. |
| `--calibration`          | `CALIBRATION`          | off         | Measure the neck pivot with the Y button, and show the instructions for it in the headset. Off unless asked for. |
| `--neck-pivot-file`      | `NECK_PIVOT_FILE`      | `neck_pivot.yaml` | The YAML file a measured neck pivot offset is written to, and read back from at startup. |

## License

Licensed under the Apache License 2.0. See [LICENSE](LICENSE) for details.

Copyright 2026 Enactic, Inc.

## Code of Conduct

All participation in the OpenArm project is governed by our [Code of Conduct](CODE_OF_CONDUCT.md).
