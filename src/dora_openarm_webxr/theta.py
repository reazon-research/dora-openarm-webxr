# Copyright 2026 Enactic, Inc.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.

"""Low-latency THETA live-preview downlink for the WebXR front-end."""

import asyncio
from collections.abc import Callable
import math
import os
import threading

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
import requests
from requests.auth import HTTPDigestAuth


_configuration: dict = {}
_latest_frame: bytes | None = None
_sequence = 0
_frame_lock = threading.Lock()
_frame_event: asyncio.Event | None = None
_event_loop: asyncio.AbstractEventLoop | None = None
_stop_event = threading.Event()
_thread: threading.Thread | None = None
_temperature_thread: threading.Thread | None = None
_board_temperature_callback: Callable[[float], None] | None = None


TEMPERATURE_POLL_INTERVAL = 5.0
BOARD_TEMPERATURE_MIN = -10.0
BOARD_TEMPERATURE_MAX = 100.0


def configure(view_configuration: dict) -> None:
    """Read THETA settings, allowing credentials to come from the environment."""
    global _configuration
    _configuration = (
        dict(view_configuration.get("theta360") or {})
        if view_configuration.get("view") == "theta360"
        else {}
    )
    overrides = {
        "host": os.getenv("THETA_HOST"),
        "username": os.getenv("THETA_USERNAME"),
        "password": os.getenv("THETA_PASSWORD"),
    }
    _configuration.update({key: value for key, value in overrides.items() if value})


def _publish(frame: bytes) -> None:
    global _latest_frame, _sequence
    with _frame_lock:
        _latest_frame = frame
        _sequence += 1
    if _event_loop is not None and _frame_event is not None:
        _event_loop.call_soon_threadsafe(_frame_event.set)


def _capture() -> None:
    """Read MJPEG in a worker thread, retaining only its newest JPEG."""
    url = _configuration["host"].rstrip("/") + "/osc/commands/execute"
    preview_format = {
        "width": int(_configuration.get("width", 1024)),
        "height": int(_configuration.get("height", 512)),
        "framerate": int(_configuration.get("framerate", 30)),
    }
    set_options_request = {
        "name": "camera.setOptions",
        "parameters": {
            "options": {
                "previewFormat": preview_format,
                "_topBottomCorrection": "Disapply",
            }
        },
    }
    request = {
        "name": "camera.getLivePreview",
        "parameters": {},
    }
    auth = HTTPDigestAuth(_configuration["username"], _configuration["password"])

    try:
        with requests.post(
            url,
            json=set_options_request,
            auth=auth,
            timeout=(5, 5),
        ) as response:
            response.raise_for_status()
    except (OSError, requests.RequestException) as error:
        if not _stop_event.is_set():
            print(f"THETA preview format not set: {error}", flush=True)

    while not _stop_event.is_set():
        try:
            with requests.post(
                url,
                json=request,
                auth=auth,
                stream=True,
                timeout=(5, 5),
            ) as response:
                response.raise_for_status()
                data = bytearray()
                for chunk in response.iter_content(chunk_size=64 * 1024):
                    if _stop_event.is_set():
                        return
                    if not chunk:
                        continue
                    data.extend(chunk)
                    while True:
                        start = data.find(b"\xff\xd8")
                        if start < 0:
                            # Bound memory on a malformed or disconnected stream.
                            if len(data) > 1024 * 1024:
                                del data[:-1]
                            break
                        end = data.find(b"\xff\xd9", start + 2)
                        if end < 0:
                            if start:
                                del data[:start]
                            break
                        _publish(bytes(data[start : end + 2]))
                        del data[: end + 2]
        except (KeyError, OSError, requests.RequestException) as error:
            if not _stop_event.is_set():
                print(f"THETA preview disconnected: {error}", flush=True)
                _stop_event.wait(1.0)


def _extract_board_temperature(payload: dict) -> float:
    """Return a validated ``_boardTemp`` value from an OSC state response."""
    value = float(payload["state"]["_boardTemp"])
    if not (
        math.isfinite(value) and BOARD_TEMPERATURE_MIN <= value <= BOARD_TEMPERATURE_MAX
    ):
        raise ValueError(f"invalid THETA board temperature: {value!r}")
    return value


def _poll_temperature() -> None:
    """Poll the THETA board temperature and publish it on the asyncio loop."""
    url = _configuration["host"].rstrip("/") + "/osc/state"
    auth = HTTPDigestAuth(_configuration["username"], _configuration["password"])
    warned = False
    while not _stop_event.is_set():
        try:
            with requests.post(url, auth=auth, timeout=(5, 5)) as response:
                response.raise_for_status()
                temperature = _extract_board_temperature(response.json())
            callback = _board_temperature_callback
            if _event_loop is not None and callback is not None:
                _event_loop.call_soon_threadsafe(callback, temperature)
            warned = False
        except (
            KeyError,
            OSError,
            TypeError,
            ValueError,
            requests.RequestException,
        ) as error:
            if not _stop_event.is_set() and not warned:
                print(f"THETA board temperature unavailable: {error}", flush=True)
                warned = True
        _stop_event.wait(TEMPERATURE_POLL_INTERVAL)


def start(on_board_temperature: Callable[[float], None] | None = None) -> None:
    """Start capture when the configured view uses the THETA panorama."""
    global _board_temperature_callback, _event_loop, _frame_event, _thread
    global _temperature_thread
    if _thread is not None or not _configuration:
        return
    _board_temperature_callback = on_board_temperature
    _event_loop = asyncio.get_running_loop()
    _frame_event = asyncio.Event()
    _stop_event.clear()
    _thread = threading.Thread(target=_capture, name="theta-preview", daemon=True)
    _thread.start()
    if on_board_temperature is not None:
        _temperature_thread = threading.Thread(
            target=_poll_temperature,
            name="theta-temperature",
            daemon=True,
        )
        _temperature_thread.start()


async def stop() -> None:
    """Ask the worker to stop without blocking the Dora event loop."""
    global _board_temperature_callback, _event_loop, _temperature_thread, _thread
    threads = [thread for thread in (_thread, _temperature_thread) if thread]
    if not threads:
        return
    _stop_event.set()
    await asyncio.gather(*(asyncio.to_thread(thread.join, 6.0) for thread in threads))
    _thread = None
    _temperature_thread = None
    _board_temperature_callback = None
    _event_loop = None


def register_routes(app: FastAPI, should_exit) -> None:
    """Register the binary latest-frame WebSocket before the static mount."""

    @app.websocket("/theta-video")
    async def _theta_video_endpoint(websocket: WebSocket):
        await websocket.accept()
        sent = -1
        try:
            while not should_exit():
                event = _frame_event
                if event is None:
                    await asyncio.sleep(0.1)
                    continue
                try:
                    await asyncio.wait_for(event.wait(), timeout=1.0)
                except asyncio.TimeoutError:
                    continue
                event.clear()
                with _frame_lock:
                    frame, sequence = _latest_frame, _sequence
                if frame is None or sequence == sent:
                    continue
                sent = sequence
                await websocket.send_bytes(frame)
            await websocket.close()
        except WebSocketDisconnect:
            pass
