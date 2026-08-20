# Copyright 2026 Enactic, Inc.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.

"""Forward normalized Dora telemetry to the head-locked WebXR HUD."""

import asyncio
import math

from fastapi import FastAPI, WebSocket, WebSocketDisconnect


WAIST_HEIGHT_INPUT = "waist_height"
HUD_UPDATE_INTERVAL = 1.0 / 30.0

_waist_height: float | None = None
_sequence = 0
_value_event = asyncio.Event()


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

    global _waist_height, _sequence
    _waist_height = min(1.0, max(0.0, value))
    _sequence += 1
    _value_event.set()
    return True


def register_routes(app: FastAPI, should_exit) -> None:
    """Register the HUD telemetry WebSocket before the static mount."""

    @app.websocket("/hud")
    async def _hud_endpoint(websocket: WebSocket):
        await websocket.accept()
        sent = -1
        last_sent_at = 0.0
        loop = asyncio.get_running_loop()
        try:
            while not should_exit():
                if _waist_height is not None and _sequence != sent:
                    delay = HUD_UPDATE_INTERVAL - (loop.time() - last_sent_at)
                    if delay > 0:
                        await asyncio.sleep(delay)
                    sent = _sequence
                    await websocket.send_json(
                        {"type": "waist-height", "value": _waist_height}
                    )
                    last_sent_at = loop.time()
                    continue
                try:
                    await asyncio.wait_for(_value_event.wait(), timeout=1.0)
                except asyncio.TimeoutError:
                    continue
                _value_event.clear()
            await websocket.close()
        except WebSocketDisconnect:
            pass
