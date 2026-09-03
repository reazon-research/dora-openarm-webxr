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

"""WebXR teleoperation over WebRTC.

Pose, session control and camera media ride one peer connection, so the page
can be served by anyone -- this node over HTTPS during development, or a
hosted service in production. WebRTC authenticates itself with a self-signed
certificate and an SDP fingerprint, so a node reached this way needs no
certificate of its own and no HTTPS server.

Two data channels, split by what they can afford to lose:

* ``xr`` -- opened by the browser, **unordered and never retransmitted**.
  Carries the ``frame`` messages at the WebXR animation frame rate
  (72-120 Hz on a Quest 3). Only the newest pose is worth anything, so a
  lost frame is dropped rather than retransmitted; the next one
  supersedes it. Frames carry a ``sequence`` so the receiver can drop the
  stale ones an unordered channel occasionally delivers late. Before the
  robot sees them, a 70 ms application-level jitter buffer plays them on
  their WebXR source timeline.
* ``control`` -- opened by this node, reliable and ordered. Carries the
  things that must not be lost: the node pushes the view configuration
  and the calibration flag once on open, the browser sends
  ``session-start``, and the node sends back what came of a calibration
  run. Pushing the configuration is what lets a page this node never
  served still know how to draw itself.

Camera frames leave on WebRTC video tracks. The control channel names each
track's role -- head eye, THETA panorama or wrist side -- because negotiation
order alone cannot tell the browser which panel should draw it. Every track on
a connection shares one RTP clock so related camera frames cannot drift onto
independent timelines.
"""

import asyncio
import fractions
import heapq
import json
import math
import time

import av
from aiortc import (
    RTCConfiguration,
    RTCIceServer,
    RTCPeerConnection,
    RTCSessionDescription,
)
from aiortc.codecs import vpx
from aiortc.mediastreams import VideoStreamTrack

from . import theta, video

# RTP video clock; pts for outgoing frames are expressed in this rate.
_CLOCK_RATE = 90_000

# Public so the front-end and the tests agree on one number. Four covers the
# largest view: stereo head video plus both wrist cameras. THETA replaces the
# head view and therefore needs only three. Unused transceivers stay inactive.
VIDEO_TRANSCEIVERS = 4

# Re-time controller frames from their WebXR timestamps before they reach the
# robot. This is deliberately application-level: browsers do not expose a
# receive jitter-buffer setting for RTCDataChannel.
ROBOT_CONTROL_JITTER_BUFFER = 0.070

# aiortc does not expose RTCRtpSender.setParameters(), so its VP8 encoder
# module is the supported control point available to this application. Keep the
# dependency defaults as public constants for argparse and tests, then update
# the live module once at startup, before any sender creates an encoder.
DEFAULT_VIDEO_BITRATE = vpx.DEFAULT_BITRATE
DEFAULT_VIDEO_MIN_BITRATE = vpx.MIN_BITRATE
DEFAULT_VIDEO_MAX_BITRATE = vpx.MAX_BITRATE

# The default deployment keeps robot and browser on one LAN, where host
# candidates connect directly. In particular, no public STUN lookup means an
# offline LAN does not spend tens of seconds gathering candidates. A signaling
# service crossing NAT must pass its own STUN/TURN list through ``ice_servers``.
ICE_SERVERS: list[RTCIceServer] = []


def configure_video_bitrate(target: int, minimum: int, maximum: int) -> None:
    """Set the target and REMB range of every VP8 encoder, in bits per second.

    aiortc constructs one encoder per active video track and peer. Its receiver
    bandwidth estimate may move the target after startup, clamped to the given
    minimum and maximum.
    """
    if minimum <= 0 or not minimum <= target <= maximum:
        raise ValueError(
            "must satisfy 0 < minimum <= target <= maximum, got "
            f"{minimum} <= {target} <= {maximum}"
        )
    vpx.DEFAULT_BITRATE = target
    vpx.MIN_BITRATE = minimum
    vpx.MAX_BITRATE = maximum
    print(
        "WebRTC VP8 bitrate: "
        f"target {target} bps, range {minimum}-{maximum} bps per track",
        flush=True,
    )


def parse_ice_servers(text: str) -> list[RTCIceServer]:
    """Parse ICE servers from JSON in the browser's own form.

    The JSON is the ``iceServers`` list an ``RTCPeerConnection`` takes
    in the browser: objects with ``urls`` (one URL or a list) and, for
    TURN, ``username`` and ``credential``. The signaling service already
    sends its browsers exactly this, so it can hand this node the very
    same list -- short-lived TURN credentials included -- with no
    translation on either side.

    Raises ValueError -- or TypeError when the JSON is not a list at
    all -- so a caller can turn a malformed configuration into a
    startup error instead of a peer that quietly cannot connect.
    """
    try:
        servers = json.loads(text)
    except json.JSONDecodeError as error:
        raise ValueError(f"not JSON: {error}") from error
    if not isinstance(servers, list):
        raise TypeError(f"not a list: {servers!r}")
    parsed = []
    for server in servers:
        if not isinstance(server, dict) or "urls" not in server:
            raise ValueError(f'not an object with "urls": {server!r}')
        parsed.append(
            RTCIceServer(
                urls=server["urls"],
                username=server.get("username"),
                credential=server.get("credential"),
            )
        )
    return parsed


class _SharedClock:
    """One timeline for every eye on a connection.

    Each eye is encoded on its own track, and tracks are paced
    independently, so nothing else keeps them together. Stamping both
    from one clock gives the receiver what it needs to present them as
    one moment.
    """

    def __init__(self) -> None:
        """Start unset; the first frame of either eye fixes the origin."""
        self._t0: float | None = None

    def timestamp(self) -> int:
        """Return the current time in RTP clock ticks since the origin."""
        now = time.monotonic()
        if self._t0 is None:
            self._t0 = now
        return int((now - self._t0) * _CLOCK_RATE)


def track_roles() -> list[str]:
    """Return every active video role in negotiation order."""
    roles = []
    if video.view_configuration().get("view") == "theta360":
        roles.append("theta")
    roles.extend(video.track_roles())
    return roles


async def _wait_next(role: str, seen_sequence: int) -> tuple[bytes, int]:
    """Wait for the newest JPEG belonging to ``role``."""
    if role == "theta":
        return await theta.wait_next(seen_sequence)
    return await video.wait_next_role(role, seen_sequence)


class _JpegVideoTrack(VideoStreamTrack):
    """Video track that decodes one latest-frame JPEG source on demand."""

    def __init__(self, role: str, clock: _SharedClock) -> None:
        """Attach to a camera role before its first frame, sharing ``clock``."""
        super().__init__()
        self._role = role
        self._clock = clock
        self._seen_sequence = 0
        # The MJPEG decoder is stateful, so each track owns one.
        self._decoder = av.CodecContext.create("mjpeg", "r")
        self._warned_decode = False

    async def recv(self) -> av.VideoFrame:
        """Return the source's next frame, stamped from the shared clock."""
        while True:
            jpeg, self._seen_sequence = await _wait_next(
                self._role, self._seen_sequence
            )
            try:
                frames = self._decoder.decode(av.Packet(jpeg))
            except av.error.FFmpegError:
                if not self._warned_decode:
                    self._warned_decode = True
                    print(
                        f"WARNING: the {self._role} camera input is not decodable JPEG",
                        flush=True,
                    )
                continue
            if frames:
                break
        frame = frames[-1]
        # Wall-clock pts instead of VideoStreamTrack's fixed 30 fps pacing:
        # frames should leave when the camera produces them, at its rate.
        frame.pts = self._clock.timestamp()
        frame.time_base = fractions.Fraction(1, _CLOCK_RATE)
        return frame


class _FrameJitterBuffer:
    """Play controller frames on their source timeline after a fixed delay."""

    def __init__(self, callback, delay: float = ROBOT_CONTROL_JITTER_BUFFER):
        self._callback = callback
        self._delay = delay
        self._queue: list[tuple[float, int, dict]] = []
        self._next_id = 0
        self._sender_origin: float | None = None
        self._playout_origin: float | None = None
        self._timer: asyncio.TimerHandle | None = None
        self._closed = False

    def push(self, payload: dict) -> None:
        """Queue one frame, using its WebXR time to remove arrival jitter."""
        if self._closed:
            return
        loop = asyncio.get_running_loop()
        now = loop.time()
        sender_time = payload.get("time")
        if (
            isinstance(sender_time, (int, float))
            and not isinstance(sender_time, bool)
            and math.isfinite(sender_time)
        ):
            sender_time /= 1000.0  # DOMHighResTimeStamp is in milliseconds.
            if self._sender_origin is None:
                self._sender_origin = sender_time
                self._playout_origin = now + self._delay
            deadline = self._playout_origin + sender_time - self._sender_origin
        else:
            # Older senders without a timestamp still get the requested delay,
            # although their arrival jitter cannot be corrected.
            deadline = now + self._delay

        heapq.heappush(self._queue, (deadline, self._next_id, payload))
        self._next_id += 1
        self._schedule()

    def close(self) -> None:
        """Discard pending robot commands and cancel their timer."""
        self._closed = True
        self._queue.clear()
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None

    def _schedule(self) -> None:
        if not self._queue:
            return
        loop = asyncio.get_running_loop()
        deadline = self._queue[0][0]
        if self._timer is not None:
            if self._timer.when() <= deadline:
                return
            self._timer.cancel()
        self._timer = loop.call_at(max(deadline, loop.time()), self._release)

    def _release(self) -> None:
        self._timer = None
        now = asyncio.get_running_loop().time()
        while self._queue and self._queue[0][0] <= now:
            _deadline, _item_id, payload = heapq.heappop(self._queue)
            self._callback(payload)
        self._schedule()


class WebRTCServer:
    """The robot half of the WebXR peer connection.

    Owns the peers, the data channels and the video tracks. It knows
    nothing about poses: frame payloads go straight to the ``on_frame``
    callback, which is where ``main`` turns them into dora outputs.
    """

    def __init__(
        self,
        on_frame,
        on_session_start,
        calibration_enabled: bool = False,
        ice_servers: list[RTCIceServer] | None = None,
    ) -> None:
        """Prepare a server; no peer exists until an offer is answered.

        ``ice_servers`` is what every peer is built with; None means the
        LAN-only default with no STUN or TURN server. The signaling service
        passes its own list here when a direct path cannot be counted on,
        since a TURN relay only works with the short-lived credentials it
        mints.
        """
        self._on_frame = on_frame
        self._on_session_start = on_session_start
        self._calibration_enabled = calibration_enabled
        self._ice_servers = ice_servers
        self._pcs: set = set()
        self._controls: set = set()
        self._track_roles: dict = {}
        self._frame_buffers: dict = {}
        self._running = True

    @property
    def running(self) -> bool:
        """Whether the node should keep serving.

        True until :meth:`stop`. In WebRTC-only mode it also turns False
        when the one peer goes away, since with no HTTP server no other
        browser can ever take its place.
        """
        return self._running

    def stop(self) -> None:
        """Stop serving and close every peer."""
        self._running = False

    async def close(self) -> None:
        """Close every peer connection."""
        pcs = list(self._pcs)
        self._pcs.clear()
        self._controls.clear()
        self._track_roles.clear()
        frame_buffers = list(self._frame_buffers.values())
        self._frame_buffers.clear()
        for frame_buffer in frame_buffers:
            frame_buffer.close()
        for pc in pcs:
            await pc.close()

    def send_control(self, payload: dict) -> None:
        """Send a message to every connected browser on ``control``.

        Used for what came of a calibration run: the operator cannot see
        the node's output while wearing a headset.
        """
        message = json.dumps(payload)
        for channel in list(self._controls):
            if channel.readyState == "open":
                channel.send(message)

    async def answer(self, offer_sdp: str) -> str:
        """Answer one offer and return the bare answer SDP."""
        pc = self._create_peer()
        try:
            return await self._answer(
                pc, RTCSessionDescription(sdp=offer_sdp, type="offer")
            )
        except Exception:
            self._pcs.discard(pc)
            self._track_roles.pop(pc, None)
            frame_buffer = self._frame_buffers.pop(pc, None)
            if frame_buffer is not None:
                frame_buffer.close()
            await pc.close()
            raise

    async def negotiate_oneshot(
        self,
        offer_sdp: str,
        answer_host: str,
        answer_port: int,
        connect_timeout: float = 60.0,
    ) -> None:
        """Answer a single offer handed in at startup, with no HTTP server.

        The offer arrives out of band (a command-line argument or an
        environment variable) as the bare SDP -- its type is always
        ``offer`` -- and the answer goes back as the bare answer SDP
        written to the TCP socket the caller is listening on. This is the
        WebRTC-only mode: another service hosts the page and brokers
        signaling, and this node just runs the peer for its lifetime.

        After sending the answer, waits up to ``connect_timeout`` seconds
        for the peer to connect. If it never does, the peer is closed and
        this raises :class:`RuntimeError`, so a stranded node exits
        instead of holding a dead connection forever.
        """
        pc = self._create_peer()
        established = asyncio.get_running_loop().create_future()

        @pc.on("connectionstatechange")
        def on_connectionstatechange() -> None:
            if pc.connectionState == "connected":
                if not established.done():
                    established.set_result(True)
            elif pc.connectionState in ("failed", "closed"):
                if not established.done():
                    established.set_result(False)
                # No HTTP server means no replacement browser, ever.
                self._running = False

        answer_sdp = await self._answer(
            pc, RTCSessionDescription(sdp=offer_sdp, type="offer")
        )

        _reader, writer = await asyncio.open_connection(answer_host, answer_port)
        writer.write(answer_sdp.encode("utf-8"))
        await writer.drain()
        writer.write_eof()
        writer.close()
        await writer.wait_closed()

        try:
            connected = await asyncio.wait_for(established, connect_timeout)
        except TimeoutError:
            connected = False
        if not connected:
            await pc.close()
            self._pcs.discard(pc)
            self._track_roles.pop(pc, None)
            frame_buffer = self._frame_buffers.pop(pc, None)
            if frame_buffer is not None:
                frame_buffer.close()
            raise RuntimeError(
                f"no WebRTC connection within {connect_timeout:g}s of the answer"
            )

    async def _answer(self, pc: RTCPeerConnection, offer: RTCSessionDescription) -> str:
        """Consume an offer and return the answer SDP.

        The video tracks are attached between setting the remote and the
        local description, so they bind to the transceivers the browser
        offered rather than adding new ones the browser never asked for.

        aiortc's ``setLocalDescription`` waits for ICE gathering to
        finish, so the returned SDP already carries every candidate:
        signaling is a single exchange with no trickle.
        """
        await pc.setRemoteDescription(offer)
        clock = _SharedClock()
        roles = track_roles()
        if len(roles) > VIDEO_TRANSCEIVERS:
            raise RuntimeError(
                f"{len(roles)} video tracks exceed {VIDEO_TRANSCEIVERS} negotiated slots"
            )
        self._track_roles[pc] = roles
        print(
            f"WebRTC video tracks: {', '.join(roles) if roles else 'none'}",
            flush=True,
        )
        for role in roles:
            pc.addTrack(_JpegVideoTrack(role, clock))
        await pc.setLocalDescription(await pc.createAnswer())
        return pc.localDescription.sdp

    def _create_peer(self) -> RTCPeerConnection:
        """Build a peer with its data channels wired up."""
        ice_servers = self._ice_servers
        if ice_servers is None:
            ice_servers = ICE_SERVERS
        configuration = RTCConfiguration(iceServers=list(ice_servers))
        pc = RTCPeerConnection(configuration)
        self._pcs.add(pc)

        # Opened by this node, like the page's own configuration: a page
        # this node never served has no other way to learn it.
        control = pc.createDataChannel("control")

        @control.on("open")
        def on_control_open() -> None:
            self._controls.add(control)
            control.send(
                json.dumps(
                    {
                        "type": "configuration",
                        "view_configuration": video.view_configuration(),
                        "calibration": self._calibration_enabled,
                        # Which panel each video track feeds, in negotiation
                        # order. A track itself carries no application role.
                        "tracks": self._track_roles.get(pc, []),
                    }
                )
            )

        @control.on("close")
        def on_control_close() -> None:
            self._controls.discard(control)

        @control.on("message")
        def on_control_message(message: object) -> None:
            self._handle_control_message(message)

        @pc.on("datachannel")
        def on_datachannel(channel) -> None:
            if channel.label != "xr":
                return
            frame_buffer = _FrameJitterBuffer(self._on_frame)
            old_buffer = self._frame_buffers.get(pc)
            if old_buffer is not None:
                old_buffer.close()
            self._frame_buffers[pc] = frame_buffer

            @channel.on("message")
            def on_message(message: object) -> None:
                self._handle_frame_message(message, frame_buffer)

            @channel.on("close")
            def on_close() -> None:
                if self._frame_buffers.get(pc) is frame_buffer:
                    self._frame_buffers.pop(pc)
                    frame_buffer.close()

        @pc.on("connectionstatechange")
        async def on_connectionstatechange() -> None:
            # A browser that leaves without closing -- a reload, a
            # sleeping headset -- is only ever noticed here. Left alone,
            # the peer's video encoders would keep running for nobody
            # until the node exits, and every reload would stack another
            # one on. Only the terminal states count: "disconnected" is
            # also what a brief network blip looks like, and that can
            # still recover.
            print(f"WebRTC peer state: {pc.connectionState}", flush=True)
            if pc.connectionState in ("failed", "closed"):
                self._pcs.discard(pc)
                self._controls.discard(control)
                self._track_roles.pop(pc, None)
                frame_buffer = self._frame_buffers.pop(pc, None)
                if frame_buffer is not None:
                    frame_buffer.close()
                await pc.close()

        return pc

    def _handle_control_message(self, message: object) -> None:
        payload = _decode(message)
        if payload is None:
            return
        if payload.get("type") == "session-start":
            self._on_session_start()

    def _handle_frame_message(
        self, message: object, frame_buffer: _FrameJitterBuffer
    ) -> None:
        payload = _decode(message)
        if payload is None:
            return
        if payload.get("type") == "frame":
            frame_buffer.push(payload)


def _decode(message: object) -> dict | None:
    """Parse one channel message, or None if it is not a JSON object.

    A malformed payload is ignored rather than fatal, so a single bad
    message cannot take the transport down mid-session.
    """
    if not isinstance(message, str):
        return None
    try:
        payload = json.loads(message)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    return payload
