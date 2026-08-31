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
ARM_RIGHT_J1_INPUT = "arm_right_j1"
ARM_LEFT_J1_INPUT = "arm_left_j1"
GRIPPER_MODE_INPUT = "gripper_mode"
HUD_UPDATE_INTERVAL = 1.0 / 30.0

# `base_pose` is an odometry triple [x_m, y_m, theta_rad]. The panel draws a
# heading, not a position, so only the third element is read.
BASE_POSE_HEADING_INDEX = 2

# The arm inputs are whole joint vectors. Only the shoulder joint is drawn, and
# it leads that vector.
ARM_J1_INDEX = 0

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
            f"{name}={raw!r} is not a positive number; falling back on {default}",
            file=sys.stderr,
            flush=True,
        )
        return default
    return value


def _sign_scale(name):
    """Read a multiplier for an input, defaulting to leaving it alone.

    Separate from `_full_scale` because this one must accept a negative: arms
    are mounted mirrored, so one side reports a lift the other reports as a
    drop, and a side view has to undo that to draw both swinging together.
    Which side is inverted is a fact about the robot, not about this node, so
    the dataflow says it. Zero is refused for being a way to silently pin an
    input to nothing rather than a scale anyone means.
    """
    raw = os.getenv(name)
    if raw is None:
        return 1.0
    try:
        value = float(raw)
    except ValueError:
        value = math.nan
    if not math.isfinite(value) or value == 0.0:
        print(
            f"{name}={raw!r} is not a non-zero number; falling back on 1.0",
            file=sys.stderr,
            flush=True,
        )
        return 1.0
    return value


_waist_height_full_scale = _full_scale("WAIST_HEIGHT_FULL_SCALE", WAIST_HEIGHT_MAX)
_waist_angle_full_scale = _full_scale("WAIST_ANGLE_FULL_SCALE", WAIST_ANGLE_MAX_DEGREES)
_arm_right_j1_scale = _sign_scale("ARM_RIGHT_J1_SCALE")
_arm_left_j1_scale = _sign_scale("ARM_LEFT_J1_SCALE")

_waist_height: float | None = None
_waist_sequence = 0
_waist_angle: float | None = None
_waist_angle_sequence = 0
_base_engaged: bool | None = None
_base_engaged_sequence = 0
_base_heading: float | None = None
_base_heading_sequence = 0
_arm_right_j1: float | None = None
_arm_right_j1_sequence = 0
_arm_left_j1: float | None = None
_arm_left_j1_sequence = 0
# The gripper's selected force/speed pair and the label naming it. One sequence
# for the three, because they only ever change together.
_gripper_name: str | None = None
_gripper_speed: float | None = None
_gripper_torque: float | None = None
_gripper_sequence = 0
_board_temperature: float | None = None
_board_temperature_sequence = 0
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


def _handle_gripper_mode(event) -> bool:
    """Keep the gripper's selected limits and the label naming them.

    The label is carried on the wire rather than derived here: this node never
    reads the arm config, so it has no way to know that 0.5 Nm is "soft" on a
    particular robot, or which of three levels that is.
    """
    global _gripper_name, _gripper_sequence, _gripper_speed, _gripper_torque
    try:
        row = event["value"][0].as_py()
        name = str(row["name"])
        speed = float(row["speed_rad_s"])
        torque = float(row["torque_nm"])
    except (IndexError, KeyError, TypeError, ValueError):
        return True
    if not (math.isfinite(speed) and math.isfinite(torque)):
        return True
    if (name, speed, torque) == (_gripper_name, _gripper_speed, _gripper_torque):
        return True
    _gripper_name = name
    _gripper_speed = speed
    _gripper_torque = torque
    _gripper_sequence += 1
    _state_event.set()
    return True


def handle_event(event) -> bool:
    """Keep the latest lifter height, waist angle, gripper or teleop mode."""
    if event["type"] != "INPUT" or event["id"] not in (
        LIFTER_HEIGHT_INPUT,
        WAIST_ANGLE_INPUT,
        BASE_ENGAGED_INPUT,
        BASE_POSE_INPUT,
        ARM_RIGHT_J1_INPUT,
        ARM_LEFT_J1_INPUT,
        GRIPPER_MODE_INPUT,
    ):
        return False

    # A struct rather than a number, so it is read here instead of through the
    # shared float-at-index path below -- and it must not reach that path's
    # closing `else`, which reads anything left over as `base_engaged`.
    if event["id"] == GRIPPER_MODE_INPUT:
        return _handle_gripper_mode(event)

    if event["id"] == BASE_POSE_INPUT:
        index = BASE_POSE_HEADING_INDEX
    elif event["id"] in (ARM_RIGHT_J1_INPUT, ARM_LEFT_J1_INPUT):
        index = ARM_J1_INDEX
    else:
        index = 0
    try:
        value = float(event["value"][index].as_py())
    except (IndexError, TypeError, ValueError):
        return True
    if not math.isfinite(value):
        return True

    global _base_engaged, _base_engaged_sequence
    global _arm_left_j1, _arm_left_j1_sequence
    global _arm_right_j1, _arm_right_j1_sequence
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
    elif event["id"] == ARM_RIGHT_J1_INPUT:
        # Unclamped for the same reason as the heading: a shoulder sweeps most
        # of a turn, and this node is not the place that knows its limits.
        _arm_right_j1 = value * _arm_right_j1_scale
        _arm_right_j1_sequence += 1
    elif event["id"] == ARM_LEFT_J1_INPUT:
        _arm_left_j1 = value * _arm_left_j1_scale
        _arm_left_j1_sequence += 1
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


def set_board_temperature(value: float) -> bool:
    """Keep the latest THETA main-board temperature in degrees Celsius."""
    try:
        temperature = float(value)
    except (TypeError, ValueError):
        return False
    if not math.isfinite(temperature) or not -10.0 <= temperature <= 100.0:
        return False

    global _board_temperature, _board_temperature_sequence
    if temperature == _board_temperature:
        return False
    _board_temperature = temperature
    _board_temperature_sequence += 1
    _state_event.set()
    return True


def _pose_stream():
    """Return every rate-limited pose value as (message type, value, sequence).

    Read through a function rather than captured once, so the socket sees the
    values as they are after it waits out the frame interval rather than the
    ones that were current when it decided to wait.
    """
    return (
        ("waist-height", _waist_height, _waist_sequence),
        ("waist-angle", _waist_angle, _waist_angle_sequence),
        ("base-heading", _base_heading, _base_heading_sequence),
        ("arm-j1-right", _arm_right_j1, _arm_right_j1_sequence),
        ("arm-j1-left", _arm_left_j1, _arm_left_j1_sequence),
    )


def register_routes(app: FastAPI, should_exit) -> None:
    """Register the HUD telemetry WebSocket before the static mount."""

    @app.websocket("/hud")
    async def _hud_endpoint(websocket: WebSocket):
        await websocket.accept()
        pose_sent: dict[str, int] = {}
        mode_sent = -1
        gripper_sent = -1
        temperature_sent = -1
        timer_sent = -1
        last_sent_at = 0.0
        loop = asyncio.get_running_loop()

        def stale():
            """Pose values that have moved since this socket last sent them."""
            return [
                (name, value, sequence)
                for name, value, sequence in _pose_stream()
                if value is not None and pose_sent.get(name) != sequence
            ]

        try:
            while not should_exit():
                sent = False
                if stale():
                    delay = HUD_UPDATE_INTERVAL - (loop.time() - last_sent_at)
                    if delay > 0:
                        await asyncio.sleep(delay)
                    # Recomputed after the wait: whatever arrived while this
                    # slept is what the panel should draw, not what was
                    # pending when it decided to sleep.
                    for name, value, sequence in stale():
                        pose_sent[name] = sequence
                        await websocket.send_json({"type": name, "value": value})
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
                # Not rate limited either, and for the same reason: it changes
                # only on a grip transition, and it tells the operator how hard
                # the gripper is about to squeeze. Sent on connect too, so a
                # headset that reconnects mid-run shows the pair actually in
                # force rather than the startup default.
                if _gripper_name is not None and _gripper_sequence != gripper_sent:
                    gripper_sent = _gripper_sequence
                    await websocket.send_json(
                        {
                            "type": "gripper",
                            "name": _gripper_name,
                            "speed_rad_s": _gripper_speed,
                            "torque_nm": _gripper_torque,
                        }
                    )
                    sent = True
                if (
                    _board_temperature is not None
                    and _board_temperature_sequence != temperature_sent
                ):
                    temperature_sent = _board_temperature_sequence
                    await websocket.send_json(
                        {
                            "type": "theta-board-temperature",
                            "value_celsius": _board_temperature,
                        }
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
