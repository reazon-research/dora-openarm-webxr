// Copyright 2026 Enactic, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// The browser half of the WebRTC connection to the node.
//
// Pose, session control and camera media ride one peer connection, so the
// WebXR page itself does not have to be served by the node. WebRTC needs no
// certificate from whoever answers; separately hosted pages may provide any
// optional application telemetry through their own service.
//
// Two data channels, split by what they can afford to lose. "xr" is
// unordered and never retransmitted, and carries the frame messages at
// the animation frame rate: only the newest pose is worth anything, so a
// lost frame is dropped rather than retransmitted. Each frame carries a
// "sequence" so the node can drop the stale ones an unordered channel
// occasionally delivers late. "control" is reliable and carries what must
// not be lost: the node's configuration push, session-start, the select
// and squeeze events, and what came of a calibration run.

// The robot and browsers are normally on the same LAN, where host candidates
// connect directly. Avoid waiting for an unreachable public STUN server before
// the one-shot offer is sent. A deployment that crosses NAT must supply its own
// STUN/TURN configuration together with its signaling service.
const CONFIGURATION = { iceServers: [] };

// The page makes its offer before the node can push the view configuration.
// Four slots cover the largest layout: stereo head video and two wrist views.
// THETA replaces the head view and uses three slots in total. The node leaves
// unused transceivers inactive.
const VIDEO_TRANSCEIVERS = 4;

// Signaling for the node's own HTTPS server: one POST, because both
// sides gather all their ICE candidates before exchanging anything.
async function postOffer(sdp) {
  const response = await fetch("offer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sdp: sdp }),
  });
  if (!response.ok) {
    throw new Error(`signaling failed: ${response.status}`);
  }
  const answer = await response.json();
  return answer.sdp;
}

// Resolves once the browser has finished gathering; there is no
// promise-based API for this, so bridge the event.
function gathered(pc) {
  if (pc.iceGatheringState === "complete") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") {
        resolve();
      }
    });
  });
}

async function selectedProtocol(pc) {
  try {
    const stats = await pc.getStats();
    let pair = null;
    for (const report of stats.values()) {
      if (report.type === "transport" && report.selectedCandidatePairId) {
        pair = stats.get(report.selectedCandidatePairId);
        break;
      }
      if (
        report.type === "candidate-pair" &&
        report.state === "succeeded" &&
        report.nominated
      ) {
        pair = report;
      }
    }
    const local = pair ? stats.get(pair.localCandidateId) : null;
    const remote = pair ? stats.get(pair.remoteCandidateId) : null;
    return local?.protocol || remote?.protocol || "unknown transport";
  } catch (_error) {
    return "unknown transport";
  }
}

// Connect to the node and resolve once it has said how to draw itself.
//
// `signal` takes the offer SDP and resolves with the answer SDP, so a
// differently hosted page can broker signaling its own way without
// changing anything else here.
export async function connect({ signal = postOffer, onState = () => {} } = {}) {
  const pc = new RTCPeerConnection(CONFIGURATION);
  const received = [];
  const trackWaiters = [];
  const handlers = { calibrationResult: null, close: null };
  let control = null;
  let sequence = 0;
  let closed = false;

  const xr = pc.createDataChannel("xr", {
    ordered: false,
    maxRetransmits: 0,
  });

  for (let index = 0; index < VIDEO_TRANSCEIVERS; index++) {
    pc.addTransceiver("video", { direction: "recvonly" });
  }

  pc.addEventListener("track", (event) => {
    // Keyed by mid, because the role a track carries is decided by negotiation
    // order and the node names that order in its configuration message.
    received.push({ mid: Number(event.transceiver.mid), track: event.track });
    for (const waiter of trackWaiters.splice(0)) {
      waiter();
    }
  });

  function waitForTracks(count) {
    if (received.length >= count) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(
            new Error(`received ${received.length}/${count} video tracks`),
          ),
        10000,
      );
      const check = () => {
        if (received.length >= count) {
          clearTimeout(timeout);
          resolve();
        } else {
          trackWaiters.push(check);
        }
      };
      trackWaiters.push(check);
    });
  }

  const configured = new Promise((resolve, reject) => {
    // The node going away is noticed in two ways, and either must end
    // the session. The reliable channel closes almost instantly when
    // the node shuts down cleanly; the connection state only reaches
    // "failed" after an ICE timeout, long after a node that died
    // without a word. The channel close is the fast path, the state
    // change the last resort.
    function lost() {
      reject(new Error("the connection to the node was lost"));
      if (!closed && handlers.close) {
        closed = true;
        handlers.close();
      }
    }
    pc.addEventListener("datachannel", (event) => {
      if (event.channel.label !== "control") {
        return;
      }
      control = event.channel;
      control.addEventListener("close", lost);
      control.addEventListener("message", (message) => {
        let payload;
        try {
          payload = JSON.parse(message.data);
        } catch (error) {
          console.error(`cannot read a message from the node: ${error}`);
          return;
        }
        if (payload.type === "configuration") {
          resolve(payload);
        } else if (payload.type === "calibration-result") {
          if (handlers.calibrationResult) {
            handlers.calibrationResult(payload);
          }
        }
      });
    });
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        lost();
      }
    });
  });

  try {
    onState("Creating WebRTC offer…");
    await pc.setLocalDescription(await pc.createOffer());
    onState("Gathering ICE candidates…");
    await gathered(pc);
    onState("Exchanging WebRTC offer…");
    const answer = await signal(pc.localDescription.sdp);
    await pc.setRemoteDescription({ type: "answer", sdp: answer });

    onState("Opening WebRTC channels…");
    const payload = await configured;
    const roles =
      payload.tracks || (payload.eyes || []).map((eye) => `head-${eye}`);
    await waitForTracks(roles.length);
    // The node names the roles in negotiation order; sorting by mid restores
    // that order even when the browser dispatched track events independently.
    received.sort((a, b) => a.mid - b.mid);
    const tracks = {};
    roles.forEach((role, index) => {
      if (received[index]) {
        tracks[role] = received[index].track;
        // Preserve upstream's eye aliases for the mono/stereo panel modules.
        if (role.startsWith("head-")) {
          tracks[role.slice("head-".length)] = received[index].track;
        }
      }
    });
    const protocol = await selectedProtocol(pc);
    onState(`WebRTC connected (${protocol})`);

    return {
      configuration: payload.view_configuration,
      calibration: { enabled: payload.calibration === true },
      protocol: protocol,
      roles: roles,
      tracks: tracks,
      // Frames are numbered here so the node can drop the ones this
      // unordered channel delivers late.
      sendFrame(message) {
        if (xr.readyState !== "open") {
          return;
        }
        sequence += 1;
        xr.send(JSON.stringify({ ...message, sequence }));
      },
      sendControl(message) {
        if (control && control.readyState === "open") {
          control.send(JSON.stringify(message));
        }
      },
      onCalibrationResult(handler) {
        handlers.calibrationResult = handler;
      },
      onClose(handler) {
        handlers.close = handler;
      },
      close() {
        closed = true;
        pc.close();
      },
    };
  } catch (error) {
    closed = true;
    pc.close();
    throw error;
  }
}
