const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ]
};

let ws = null;
let wsReady = false;
let reconnectTimer = null;
let userEmail = null;
let onIncomingCallCb = null;
let onCallEndedCb = null;

let peerConnection = null;
let localStream = null;
let remoteStream = null;
let callState = 'idle';
let currentCall = null;
let iceCandidateBuffer = [];
let callTimeoutTimer = null;
const CALL_TIMEOUT_MS = 45000;

export function getCallState() { return callState; }
export function getCurrentCall() { return currentCall; }

export function initWebSocket(email) {
  userEmail = email;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  connectWs();
}

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${proto}//${location.host}/ws`;
  try {
    ws = new WebSocket(wsUrl);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    wsReady = true;
    ws.send(JSON.stringify({ type: 'hello', email: userEmail }));
  };

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    handleWsMessage(msg);
  };

  ws.onclose = () => {
    wsReady = false;
    scheduleReconnect();
  };

  ws.onerror = () => {
    try { ws.close(); } catch {}
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (userEmail) connectWs();
  }, 3000);
}

export function closeWebSocket() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { try { ws.close(); } catch {} ws = null; }
  wsReady = false;
}

function wsSend(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case 'call-invite':
      if (callState === 'idle' && onIncomingCallCb) {
        callState = 'receiving';
        currentCall = { from: msg.from, fromName: msg.fromName, callType: msg.callType, isCaller: false };
        onIncomingCallCb(currentCall);
      }
      break;
    case 'call-accept':
      if (callState === 'calling' && currentCall) {
        if (callTimeoutTimer) { clearTimeout(callTimeoutTimer); callTimeoutTimer = null; }
        callState = 'connected';
        startWebRTC(currentCall.callType === 'video', true);
      }
      break;
    case 'call-reject':
      if (callState !== 'idle') {
        if (callTimeoutTimer) { clearTimeout(callTimeoutTimer); callTimeoutTimer = null; }
        cleanupCall();
        if (onCallEndedCb) onCallEndedCb('rejected');
      }
      break;
    case 'call-cancel':
      if (callState !== 'idle') {
        if (callTimeoutTimer) { clearTimeout(callTimeoutTimer); callTimeoutTimer = null; }
        cleanupCall();
        if (onCallEndedCb) onCallEndedCb('cancelled');
      }
      break;
    case 'call-end':
      if (callState !== 'idle') {
        if (callTimeoutTimer) { clearTimeout(callTimeoutTimer); callTimeoutTimer = null; }
        cleanupCall();
        if (onCallEndedCb) onCallEndedCb('ended');
      }
      break;
    case 'webrtc-offer':
      if (callState === 'receiving' && currentCall) {
        handleOffer(msg.sdp);
      }
      break;
    case 'webrtc-answer':
      if (callState === 'connected' && peerConnection) {
        peerConnection.setRemoteDescription(new RTCSessionDescription(msg.sdp)).catch(() => {});
      }
      break;
    case 'webrtc-ice':
      if (peerConnection && msg.candidate) {
        peerConnection.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
      }
      break;
  }
}

export function setOnIncomingCall(cb) { onIncomingCallCb = cb; }
export function setOnCallEnded(cb) { onCallEndedCb = cb; }

export function initIncomingCallFromPush(call) {
  if (callState !== 'idle') return false;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    initWebSocket(call.to || userEmail);
  }
  callState = 'receiving';
  currentCall = {
    from: call.from,
    fromName: call.fromName || call.from,
    callType: call.callType || 'audio',
    isCaller: false
  };
  return true;
}

export async function startCall(toEmail, callType) {
  if (callState !== 'idle') return { success: false, error: 'Already in a call' };
  callState = 'calling';
  currentCall = { from: userEmail, to: toEmail, callType, isCaller: true };

  const sent = wsSend({
    type: 'call-invite',
    to: toEmail,
    callType: callType || 'audio'
  });

  if (!sent) {
    try {
      const response = await fetch('/api/call/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromEmail: userEmail,
          fromName: userEmail,
          toEmail,
          callType
        })
      });
      const result = await response.json();
      if (!result.success) {
        cleanupCall();
        return { success: false, error: 'Recipient not found' };
      }
    } catch (err) {
      cleanupCall();
      return { success: false, error: 'Call failed' };
    }
  }

  callTimeoutTimer = setTimeout(() => {
    if (callState === 'calling') {
      cancelCall();
      if (onCallEndedCb) onCallEndedCb('timeout');
    }
  }, CALL_TIMEOUT_MS);

  return { success: true };
}

export function acceptCall() {
  if (!currentCall || callState !== 'receiving') return;
  if (callTimeoutTimer) { clearTimeout(callTimeoutTimer); callTimeoutTimer = null; }
  callState = 'connected';
  wsSend({ type: 'call-accept', to: currentCall.from });
  startWebRTC(currentCall.callType === 'video', false);
}

export function rejectCall() {
  if (!currentCall) return;
  if (callTimeoutTimer) { clearTimeout(callTimeoutTimer); callTimeoutTimer = null; }
  wsSend({ type: 'call-reject', to: currentCall.isCaller ? currentCall.to : currentCall.from });
  cleanupCall();
}

export function cancelCall() {
  if (!currentCall) return;
  if (callTimeoutTimer) { clearTimeout(callTimeoutTimer); callTimeoutTimer = null; }
  wsSend({ type: 'call-cancel', to: currentCall.isCaller ? currentCall.to : currentCall.from });
  cleanupCall();
}

export function endCall() {
  if (!currentCall) return;
  if (callTimeoutTimer) { clearTimeout(callTimeoutTimer); callTimeoutTimer = null; }
  wsSend({ type: 'call-end', to: currentCall.isCaller ? currentCall.to : currentCall.from });
  cleanupCall();
}

async function startWebRTC(isVideo, isCaller) {
  try {
    const constraints = { audio: true, video: isVideo };
    localStream = await navigator.mediaDevices.getUserMedia(constraints);

    peerConnection = new RTCPeerConnection(ICE_SERVERS);

    for (const track of localStream.getTracks()) {
      peerConnection.addTrack(track, localStream);
    }

    remoteStream = new MediaStream();

    peerConnection.ontrack = (event) => {
      for (const track of event.streams[0].getTracks()) {
        remoteStream.addTrack(track);
      }
      attachRemoteStream();
    };

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        wsSend({
          type: 'webrtc-ice',
          to: currentCall.isCaller ? currentCall.to : currentCall.from,
          candidate: event.candidate
        });
      }
    };

    peerConnection.onconnectionstatechange = () => {
      if (peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'disconnected') {
        if (callState === 'connected') {
          endCall();
          if (onCallEndedCb) onCallEndedCb('disconnected');
        }
      }
    };

    attachLocalStream(isVideo);

    if (isCaller) {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      wsSend({
        type: 'webrtc-offer',
        to: currentCall.to,
        sdp: peerConnection.localDescription
      });
    }
  } catch (err) {
    if (onCallEndedCb) onCallEndedCb('media-error');
    cancelCall();
  }
}

async function handleOffer(sdp) {
  if (!peerConnection) {
    try {
      const constraints = { audio: true, video: currentCall.callType === 'video' };
      localStream = await navigator.mediaDevices.getUserMedia(constraints);
      peerConnection = new RTCPeerConnection(ICE_SERVERS);
      for (const track of localStream.getTracks()) {
        peerConnection.addTrack(track, localStream);
      }
      remoteStream = new MediaStream();
      peerConnection.ontrack = (event) => {
        for (const track of event.streams[0].getTracks()) {
          remoteStream.addTrack(track);
        }
        attachRemoteStream();
      };
      peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          wsSend({
            type: 'webrtc-ice',
            to: currentCall.from,
            candidate: event.candidate
          });
        }
      };
      peerConnection.onconnectionstatechange = () => {
        if (peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'disconnected') {
          if (callState === 'connected') {
            endCall();
            if (onCallEndedCb) onCallEndedCb('disconnected');
          }
        }
      };
      attachLocalStream(currentCall.callType === 'video');
    } catch (err) {
      if (onCallEndedCb) onCallEndedCb('media-error');
      rejectCall();
      return;
    }
  }

  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    wsSend({
      type: 'webrtc-answer',
      to: currentCall.from,
      sdp: peerConnection.localDescription
    });
  } catch (err) {
    if (onCallEndedCb) onCallEndedCb('error');
    rejectCall();
  }
}

function attachLocalStream(isVideo) {
  const localVideo = document.getElementById('call-local-video');
  const localAudio = document.getElementById('call-local-audio');
  if (localStream) {
    if (isVideo && localVideo) {
      localVideo.srcObject = localStream;
      localVideo.style.display = 'block';
    }
    if (localAudio) {
      localAudio.srcObject = localStream;
    }
  }
}

function attachRemoteStream() {
  const remoteVideo = document.getElementById('call-remote-video');
  const remoteAudio = document.getElementById('call-remote-audio');
  if (remoteStream) {
    if (remoteVideo && currentCall?.callType === 'video') {
      remoteVideo.srcObject = remoteStream;
      remoteVideo.style.display = 'block';
    }
    if (remoteAudio) {
      remoteAudio.srcObject = remoteStream;
      remoteAudio.play().catch(() => {});
    }
  }
}

function cleanupCall() {
  if (callTimeoutTimer) { clearTimeout(callTimeoutTimer); callTimeoutTimer = null; }
  if (localStream) {
    for (const track of localStream.getTracks()) {
      try { track.stop(); } catch {}
    }
    localStream = null;
  }
  if (peerConnection) {
    try { peerConnection.close(); } catch {}
    peerConnection = null;
  }
  remoteStream = null;
  callState = 'idle';
  currentCall = null;
}

export function toggleMute() {
  if (!localStream) return false;
  const audioTrack = localStream.getAudioTracks()[0];
  if (audioTrack) {
    audioTrack.enabled = !audioTrack.enabled;
    return !audioTrack.enabled;
  }
  return false;
}

export function toggleCamera() {
  if (!localStream) return false;
  const videoTrack = localStream.getVideoTracks()[0];
  if (videoTrack) {
    videoTrack.enabled = !videoTrack.enabled;
    return !videoTrack.enabled;
  }
  return false;
}
