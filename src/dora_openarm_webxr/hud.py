# Copyright 2026 Enactic, Inc.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.

"""Forward synchronized telemetry to the WebXR HUD and desktop monitor."""

import asyncio
from collections.abc import Callable
import math
import os
import sys
import time

from fastapi import FastAPI, WebSocket, WebSocketDisconnect


LIFTER_HEIGHT_INPUT = "waist_height"
WAIST_ANGLE_INPUT = "waist_angle"
BASE_ENGAGED_INPUT = "base_engaged"
BASE_POSE_INPUT = "base_pose"
HUD_UPDATE_INTERVAL = 1.0 / 30.0

# `base_pose` is an odometry triple [x_m, y_m, theta_rad]. The panel draws a
# heading, not a position, so only the third element is read.
BASE_POSE_HEADING_INDEX = 2

# `base_engaged` arrives as 0.0 or 1.0; anything at or above this reads as the
# base owning the sticks. Matches the swerve lock that publishes it.
BASE_ENGAGED_THRESHOLD = 0.5

# The top of each panel's own range: the lifter fully raised, and the waist
# folded fully forward.
WAIST_HEIGHT_MAX = 1.0
WAIST_ANGLE_MAX_DEGREES = 90.0


def _full_scale(name, default):
    """Read the raw input value that should read as the top of a panel's range.

    Sources publish robot units — millimetres of screw travel, or radians on a
    physical range wider than the logical one the panel draws — and the node
    stays unaware of any particular robot by taking that full-scale reading
    from the dataflow instead of hardcoding it. The default is the top of the
    panel range itself, which is the identity conversion, so a dataflow already
    publishing `0.0`-`1.0` and `0`-`90` degrees needs neither variable.

    A value that is not positive and finite would divide every reading by zero
    or smear it to infinity, so it is refused, loudly, in favor of the default.
    """
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError:
        value = math.nan
    if not math.isfinite(value) or value <= 0.0:
        print(
            f"{name}={raw!r} is not a positive number; "
            f"falling back on {default}",
            file=sys.stderr,
            flush=True,
        )
        return default
    return value


_waist_height_full_scale = _full_scale("WAIST_HEIGHT_FULL_SCALE", WAIST_HEIGHT_MAX)
_waist_angle_full_scale = _full_scale(
    "WAIST_ANGLE_FULL_SCALE", WAIST_ANGLE_MAX_DEGREES
)

_waist_height: float | None = None
_waist_sequence = 0
_waist_angle: float | None = None
_waist_angle_sequence = 0
_base_engaged: bool | None = None
_base_engaged_sequence = 0
_base_heading: float | None = None
_base_heading_sequence = 0
_state_event = asyncio.Event()


class TimerState:
    """Keep a timer that can be reconstructed by a newly connected monitor."""

    def __init__(self, clock: Callable[[], float] = time.perf_counter):
        """Initialize a stopped timer using a monotonic clock."""
        self._clock = clock
        self._running = False
        self._elapsed_seconds = 0.0
        self._started_at = 0.0

    def apply(self, action: str) -> bool:
        """Apply a Quest HUD action, returning whether the state changed."""
        now = self._clock()
        if action == "start":
            if self._running:
                return False
            self._started_at = now
            self._running = True
        elif action == "stop":
            if not self._running:
                return False
            self._elapsed_seconds += now - self._started_at
            self._running = False
        elif action == "reset":
            self._running = False
            self._elapsed_seconds = 0.0
            self._started_at = 0.0
        else:
            return False
        return True

    def snapshot(self) -> dict:
        """Return enough state for a browser to continue the timer locally."""
        elapsed = self._elapsed_seconds
        if self._running:
            elapsed += self._clock() - self._started_at
        return {
            "type": "timer-state",
            "running": self._running,
            "elapsed_milliseconds": max(0.0, elapsed * 1000.0),
        }


_timer = TimerState()
_timer_sequence = 0


def handle_event(event) -> bool:
    """Keep the latest lifter height, waist angle or teleoperation mode."""
    if event["type"] != "INPUT" or event["id"] not in (
        LIFTER_HEIGHT_INPUT,
        WAIST_ANGLE_INPUT,
        BASE_ENGAGED_INPUT,
        BASE_POSE_INPUT,
    ):
        return False

    index = BASE_POSE_HEADING_INDEX if event["id"] == BASE_POSE_INPUT else 0
    try:
        value = float(event["value"][index].as_py())
    except (IndexError, TypeError, ValueError):
        return True
    if not math.isfinite(value):
        return True

    global _base_engaged, _base_engaged_sequence
    global _base_heading, _base_heading_sequence
    global _waist_angle, _waist_angle_sequence, _waist_height, _waist_sequence
    if event["id"] == LIFTER_HEIGHT_INPUT:
        scaled = value / _waist_height_full_scale * WAIST_HEIGHT_MAX
        _waist_height = min(WAIST_HEIGHT_MAX, max(0.0, scaled))
        _waist_sequence += 1
    elif event["id"] == WAIST_ANGLE_INPUT:
        scaled = value / _waist_angle_full_scale * WAIST_ANGLE_MAX_DEGREES
        _waist_angle = min(WAIST_ANGLE_MAX_DEGREES, max(0.0, scaled))
        _waist_angle_sequence += 1
    elif event["id"] == BASE_POSE_INPUT:
        # Deliberately unclamped, unlike the two above. Heading wraps, and the
        # odometry that publishes it never normalizes its integral, so every
        # finite reading is a real one and a limit would only invent a stop.
        _base_heading = value
        _base_heading_sequence += 1
    else:
        # The publisher sends this only on the grip edge, so a repeat of the
        # value it already holds is not a change worth waking the socket for.
        engaged = value >= BASE_ENGAGED_THRESHOLD
        if engaged == _base_engaged:
            return True
        _base_engaged = engaged
        _base_engaged_sequence += 1
    _state_event.set()
    return True


def handle_timer_action(action: object) -> bool:
    """Apply a timer action emitted by the Quest HUD."""
    if not isinstance(action, str) or not _timer.apply(action):
        return False
    global _timer_sequence
    _timer_sequence += 1
    _state_event.set()
    return True


def register_routes(app: FastAPI, should_exit) -> None:
    """Register the HUD telemetry WebSocket before the static mount."""

    @app.websocket("/hud")
    async def _hud_endpoint(websocket: WebSocket):
        await websocket.accept()
        waist_sent = -1
        waist_angle_sent = -1
        heading_sent = -1
        mode_sent = -1
        timer_sent = -1
        last_sent_at = 0.0
        loop = asyncio.get_running_loop()
        try:
            while not should_exit():
                sent = False
                pose_changed = (
                    _waist_height is not None and _waist_sequence != waist_sent
                ) or (
                    _waist_angle is not None
                    and _waist_angle_sequence != waist_angle_sent
                ) or (
                    _base_heading is not None
                    and _base_heading_sequence != heading_sent
                )
                if pose_changed:
                    delay = HUD_UPDATE_INTERVAL - (loop.time() - last_sent_at)
                    if delay > 0:
                        await asyncio.sleep(delay)
                    if _waist_height is not None and _waist_sequence != waist_sent:
                        waist_sent = _waist_sequence
                        await websocket.send_json(
                            {"type": "waist-height", "value": _waist_height}
                        )
                    if (
                        _waist_angle is not None
                        and _waist_angle_sequence != waist_angle_sent
                    ):
                        waist_angle_sent = _waist_angle_sequence
                        await websocket.send_json(
                            {"type": "waist-angle", "value": _waist_angle}
                        )
                    if (
                        _base_heading is not None
                        and _base_heading_sequence != heading_sent
                    ):
                        heading_sent = _base_heading_sequence
                        await websocket.send_json(
                            {"type": "base-heading", "value": _base_heading}
                        )
                    last_sent_at = loop.time()
                    sent = True
                # Not rate limited with the pose above: the mode changes only
                # on a grip press, and it tells the operator which half of the
                # robot their sticks are about to move, so it goes out at once.
                # Sent on connect too, so a headset that reconnects mid-run
                # shows the current mode instead of the startup default.
                if _base_engaged is not None and _base_engaged_sequence != mode_sent:
                    mode_sent = _base_engaged_sequence
                    await websocket.send_json(
                        {"type": "mode", "base_engaged": _base_engaged}
                    )
                    sent = True
                # Always send an initial timer state. It lets a PC opened after
                # the Quest session started reconstruct the current clock.
                if _timer_sequence != timer_sent:
                    timer_sent = _timer_sequence
                    await websocket.send_json(_timer.snapshot())
                    sent = True
                if sent:
                    continue
                try:
                    await asyncio.wait_for(_state_event.wait(), timeout=1.0)
                except asyncio.TimeoutError:
                    continue
                _state_event.clear()
            await websocket.close()
        except WebSocketDisconnect:
            pass
