# Copyright 2026 Enactic, Inc.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.

"""Forward synchronized telemetry to the WebXR HUD and desktop monitor."""

import asyncio
from collections.abc import Callable
import math
import time

from fastapi import FastAPI, WebSocket, WebSocketDisconnect


WAIST_HEIGHT_INPUT = "waist_height"
HUD_UPDATE_INTERVAL = 1.0 / 30.0

_waist_height: float | None = None
_waist_sequence = 0
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
    """Keep the latest normalized waist height. Return whether it was ours."""
    if event["type"] != "INPUT" or event["id"] != WAIST_HEIGHT_INPUT:
        return False

    try:
        value = float(event["value"][0].as_py())
    except (IndexError, TypeError, ValueError):
        return True
    if not math.isfinite(value):
        return True

    global _waist_height, _waist_sequence
    _waist_height = min(1.0, max(0.0, value))
    _waist_sequence += 1
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
        timer_sent = -1
        last_sent_at = 0.0
        loop = asyncio.get_running_loop()
        try:
            while not should_exit():
                sent = False
                if _waist_height is not None and _waist_sequence != waist_sent:
                    delay = HUD_UPDATE_INTERVAL - (loop.time() - last_sent_at)
                    if delay > 0:
                        await asyncio.sleep(delay)
                    waist_sent = _waist_sequence
                    await websocket.send_json(
                        {"type": "waist-height", "value": _waist_height}
                    )
                    last_sent_at = loop.time()
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
