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

"""Dora camera inputs for WebRTC video tracks.

Keeps only the newest JPEG from the robot's head and wrist cameras. WebRTC
tracks consume those frames independently, so a slow encoder skips stale
frames instead of building latency.

The head image is the main camera view; the wrist images are drawn as small
head-locked panels at the left and right sides. :mod:`.webrtc` owns the tracks
that encode them. How the panels are placed is tuned in the view configuration.
"""

import argparse
import asyncio
import os
import pathlib

import yaml

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

# Used when no --view-configuration-file is given.
DEFAULT_VIEW_CONFIGURATION: dict = {
    "view": "mono",
    "session": {"mode": "immersive-ar"},
    "panel": {"lock": "room", "distance": 1.3, "width": 1.5},
    "wrist_panels": {
        "enabled": True,
        "distance": 1.0,
        "width": 0.38,
        "left_center": [-0.55, 0.0],
        "right_center": [0.55, 0.0],
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
_wrist_events: dict = {"left": asyncio.Event(), "right": asyncio.Event()}

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

    ``none`` and ``theta360`` use no head camera, ``stereo`` draws one image
    per eye, and everything else -- ``mono`` included -- draws the right one.
    The order is fixed because the browser tells the tracks apart by the
    order they were negotiated in.
    """
    view = _view_configuration.get("view")
    if view in ("none", "theta360"):
        return []
    if view == "stereo":
        return ["left", "right"]
    return ["right"]


def track_roles() -> list[str]:
    """Return the active Dora-camera WebRTC roles in negotiation order."""
    roles = [f"head-{eye}" for eye in eyes()]
    wrist = _view_configuration.get("wrist_panels") or {}
    if wrist.get("enabled", True):
        roles.extend(["wrist-left", "wrist-right"])
    return roles


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
        _wrist_frames[side] = event["value"].to_numpy(zero_copy_only=False).tobytes()
        _wrist_sequences[side] += 1
        _wrist_events[side].set()
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


async def wait_next_wrist(side: str, seen_sequence: int) -> tuple:
    """Wait for the newest wrist JPEG on ``side``."""
    while _wrist_sequences[side] == seen_sequence:
        _wrist_events[side].clear()
        await _wrist_events[side].wait()
    return _wrist_frames[side], _wrist_sequences[side]


async def wait_next_role(role: str, seen_sequence: int) -> tuple:
    """Wait for the newest JPEG belonging to a negotiated track role."""
    group, side = role.split("-", 1)
    if group == "head":
        return await wait_next(side, seen_sequence)
    if group == "wrist":
        return await wait_next_wrist(side, seen_sequence)
    raise ValueError(f"unknown video track role: {role}")


def reset() -> None:
    """Forget every stored frame. For tests, which reuse the module."""
    for eye in _frames:
        _frames[eye] = None
        _sequences[eye] = 0
        _events[eye] = asyncio.Event()
    for side in _wrist_frames:
        _wrist_frames[side] = None
        _wrist_sequences[side] = 0
        _wrist_events[side] = asyncio.Event()
