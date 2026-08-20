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

Frames leave on their own WebRTC video track, one per eye, so they never
delay the pose messages that feed IK. This module only keeps the newest
frame per eye; :mod:`.webrtc` owns the tracks that encode them. How the
panel is placed is tuned in ``example/view_camera.yaml``.
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

# Each wrist frame is sent as a binary WebSocket message prefixed with one
# byte identifying its panel side, then the JPEG.
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
# Incremented on every frame so that a track can tell a new frame from a
# repeated one and always encode the most recent one.
_sequences: dict = {"left": 0, "right": 0}
# One event per eye, because each eye has its own track waiting on it.
# A shared event would need every waiter to agree on when to clear it.
_events: dict = {"left": asyncio.Event(), "right": asyncio.Event()}

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


def eyes() -> list:
    """Return the eyes this view draws, in track negotiation order.

    ``none`` shows no camera at all, ``stereo`` draws one image per eye,
    and everything else -- ``mono`` included -- draws the right one only.
    The order is fixed because the browser tells the tracks apart by the
    order they were negotiated in.
    """
    view = _view_configuration.get("view")
    if view == "none":
        return []
    if view == "stereo":
        return ["left", "right"]
    return ["right"]


def handle_event(event) -> bool:
    """Store a head or wrist camera frame. Return whether it was ours."""
    if event["type"] != "INPUT":
        return False
    camera_id = event["id"]
    if camera_id in CAMERA_INPUTS:
        eye = CAMERA_INPUTS[camera_id]
        # The camera node sends JPEG data as a uint8 array.
        _frames[eye] = event["value"].to_numpy(zero_copy_only=False).tobytes()
        _sequences[eye] += 1
        _events[eye].set()
        return True
    if camera_id in WRIST_CAMERA_INPUTS:
        side = WRIST_CAMERA_INPUTS[camera_id]
        _wrist_frames[side] = event["value"].to_numpy(
            zero_copy_only=False
        ).tobytes()
        _wrist_sequences[side] += 1
        _wrist_frame_event.set()
        return True
    return False


async def wait_next(eye: str, seen_sequence: int) -> tuple:
    """Wait for a frame of ``eye`` newer than ``seen_sequence``, return it.

    Returns the JPEG payload and its sequence number. A slow encoder
    skips ahead to the newest frame rather than building a queue, which
    is the right trade for teleoperation video.
    """
    while _sequences[eye] == seen_sequence:
        _events[eye].clear()
        await _events[eye].wait()
    return _frames[eye], _sequences[eye]


def register_routes(app: FastAPI, should_exit) -> None:
    """Register the wrist-camera WebSocket on the node's Web application."""

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


def reset() -> None:
    """Forget every stored frame. For tests, which reuse the module."""
    for eye in _frames:
        _frames[eye] = None
        _sequences[eye] = 0
        _events[eye] = asyncio.Event()
    global _wrist_frame_event
    for side in _wrist_frames:
        _wrist_frames[side] = None
        _wrist_sequences[side] = 0
    _wrist_frame_event = asyncio.Event()
