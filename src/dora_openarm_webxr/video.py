# Copyright 2026 Enactic, Inc.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Camera video downlinks for the WebXR front-end.

Takes JPEG images from the robot's head and wrist cameras and forwards
them to the VR device. The head image is the main camera view; the wrist
images are drawn as small head-locked panels in the lower corners.

Frames go on their own WebSocket so they never delay the pose messages
that feed IK. How the panel is placed is tuned in
``example/view_camera.yaml``.
"""

import argparse
import asyncio
import os
import pathlib
import yaml

from fastapi import FastAPI, WebSocket, WebSocketDisconnect


# dora-rs input IDs mapped to the eye that the frame is rendered on.
# The default mono view uses only the right eye; the stereo view uses
# both.
CAMERA_INPUTS = {
    "camera_head_left": "left",
    "camera_head_right": "right",
}

# Wrist sides name panels, not headset eyes. Both panels are rendered to
# both eyes so the operator can fuse them at a comfortable depth.
WRIST_CAMERA_INPUTS = {
    "camera_wrist_left": "left",
    "camera_wrist_right": "right",
}

# Each frame is sent as a binary WebSocket message prefixed with one byte
# identifying its eye (head stereo) or panel side (wrist), then the JPEG.
CAMERA_PREFIX = {"left": b"\x00", "right": b"\x01"}

# Used when no --view-configuration-file is given.
DEFAULT_VIEW_CONFIGURATION: dict = {
    "view": "mono",
    "session": {"mode": "immersive-ar"},
    "panel": {"lock": "room", "distance": 1.3, "width": 1.5},
    "wrist_panels": {
        "enabled": True,
        "distance": 1.0,
        "width": 0.38,
        "left_center": [-0.55, -0.32],
        "right_center": [0.55, -0.32],
    },
}

_frames: dict = {"left": None, "right": None}
# Incremented on every frame so that the video endpoint can tell a new
# frame from a repeated one and always send the most recent one.
_sequences: dict = {"left": 0, "right": 0}
_frame_event = asyncio.Event()

_wrist_frames: dict = {"left": None, "right": None}
_wrist_sequences: dict = {"left": 0, "right": 0}
_wrist_frame_event = asyncio.Event()

_view_configuration: dict = DEFAULT_VIEW_CONFIGURATION


def add_arguments(parser: argparse.ArgumentParser) -> None:
    """Add the camera view options to the node's argument parser."""
    parser.add_argument(
        "--view-configuration-file",
        type=pathlib.Path,
        default=os.getenv("VIEW_CONFIGURATION_FILE"),
        help="YAML file with the camera panel parameters",
    )


def configure(args: argparse.Namespace) -> None:
    """Read the view configuration at startup if a file was given.

    Read once; restart the dataflow to apply a change.
    """
    path = getattr(args, "view_configuration_file", None)
    if path is None:
        return
    global _view_configuration
    try:
        with open(path, encoding="utf-8") as input:
            _view_configuration = yaml.safe_load(input)
    except (OSError, yaml.YAMLError) as error:
        # Keep the default so a broken file cannot stop the node.
        print(f"cannot read {path}: {error}", flush=True)


def view_configuration() -> dict:
    """Return the view configuration read at startup."""
    return _view_configuration


def _store_frame(event, inputs, frames, sequences, frame_event) -> bool:
    """Store the latest JPEG for one camera group."""
    if event["type"] != "INPUT" or event["id"] not in inputs:
        return False
    camera = inputs[event["id"]]
    # The camera node sends JPEG data as a uint8 array.
    frames[camera] = event["value"].to_numpy(zero_copy_only=False).tobytes()
    sequences[camera] += 1
    frame_event.set()
    return True


def handle_event(event) -> bool:
    """Store a camera frame. Return whether the event was ours."""
    return _store_frame(
        event, CAMERA_INPUTS, _frames, _sequences, _frame_event
    ) or _store_frame(
        event,
        WRIST_CAMERA_INPUTS,
        _wrist_frames,
        _wrist_sequences,
        _wrist_frame_event,
    )


def register_routes(app: FastAPI, should_exit) -> None:
    """Register the camera routes on the node's Web application.

    ``should_exit`` is a callable so this module need not know how the
    node shuts its server down.
    """

    @app.get("/view_configuration")
    async def _view_configuration_endpoint():
        """Serve the camera panel parameters to the WebXR front-end."""
        return _view_configuration

    @app.websocket("/video")
    async def _video_endpoint(websocket: WebSocket):
        await websocket.accept()
        stereo = _view_configuration.get("view") == "stereo"
        eyes = ["left", "right"] if stereo else ["right"]
        sent = {eye: -1 for eye in eyes}
        try:
            while not should_exit():
                try:
                    await asyncio.wait_for(_frame_event.wait(), timeout=1.0)
                except asyncio.TimeoutError:
                    # Loop so shutdown is noticed.
                    continue
                _frame_event.clear()
                if any(_frames[eye] is None for eye in eyes):
                    continue
                if all(_sequences[eye] == sent[eye] for eye in eyes):
                    continue
                # Together, so the eyes never show different frames.
                for eye in eyes:
                    sent[eye] = _sequences[eye]
                    await websocket.send_bytes(CAMERA_PREFIX[eye] + _frames[eye])
            await websocket.close()
        except WebSocketDisconnect:
            pass

    @app.websocket("/wrist-video")
    async def _wrist_video_endpoint(websocket: WebSocket):
        """Send each wrist's newest JPEG without delaying pose messages."""
        await websocket.accept()
        sides = ["left", "right"]
        sent = {side: -1 for side in sides}
        try:
            while not should_exit():
                sent_frame = False
                for side in sides:
                    if (
                        _wrist_frames[side] is None
                        or _wrist_sequences[side] == sent[side]
                    ):
                        continue
                    sent[side] = _wrist_sequences[side]
                    await websocket.send_bytes(
                        CAMERA_PREFIX[side] + _wrist_frames[side]
                    )
                    sent_frame = True
                if sent_frame:
                    continue
                try:
                    await asyncio.wait_for(_wrist_frame_event.wait(), timeout=1.0)
                except asyncio.TimeoutError:
                    continue
                _wrist_frame_event.clear()
            await websocket.close()
        except WebSocketDisconnect:
            pass
