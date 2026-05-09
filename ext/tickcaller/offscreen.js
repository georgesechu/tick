// Offscreen document — holds MediaStream + MediaRecorder and
// streams 60-second chunks to the tick /call/* endpoints.
//
// Why offscreen? MV3 service workers can't hold MediaStreams
// reliably. Offscreen docs are MV3's persistent-context escape hatch.
//
// Chunk cycling: MediaRecorder.start(timeslice) emits subsequent
// chunks without webm container headers — whisper can't decode those.
// We cycle recorders every CYCLE_MS instead: each complete recorder
// lifecycle yields one fully-framed webm chunk.

const CYCLE_MS = 60_000; // 60 seconds per chunk

const state = {
  phase: "idle", // "idle" | "recording" | "stopping"
  serverUrl: "",
  token: "",
  callId: "",
  stream: null,
  sourceStreams: [],
  audioContext: null,
  activeRecorder: null,
  cycleTimer: null,
  chunkIdx: 0,
  chunksUploaded: 0,
  lastChunkAt: 0,
  startedAt: 0,
  error: "",
};

function setError(msg) {
  console.error("[offscreen]", msg);
  state.error = String(msg);
}

async function startRecording({ streamId, serverUrl, token, tabTitle, tabUrl }) {
  console.log("[off] startRecording", { streamIdLen: streamId?.length, phase: state.phase, tabTitle });

  if (state.phase !== "idle") {
    return { ok: true, callId: state.callId, alreadyRecording: true };
  }

  state.serverUrl = serverUrl.replace(/\/$/, "");
  state.token = token;
  state.chunkIdx = 0;
  state.chunksUploaded = 0;
  state.error = "";

  // Acquire tab + mic streams, mix into one
  const sourceStreams = [];
  let combinedStream = null;
  let audioContext = null;

  try {
    // Tab audio
    const tabStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });
    sourceStreams.push(tabStream);
    console.log("[off] tab stream OK");

    // Mic audio
    let micStream = null;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      sourceStreams.push(micStream);
      console.log("[off] mic stream OK");
    } catch (err) {
      console.warn("[off] mic not available, tab-only mode:", err.message);
    }

    if (micStream) {
      // Mix tab + mic via AudioContext
      audioContext = new AudioContext();
      const dest = audioContext.createMediaStreamDestination();
      const tabSrc = audioContext.createMediaStreamSource(tabStream);
      tabSrc.connect(dest);
      tabSrc.connect(audioContext.destination); // user still hears tab
      const micSrc = audioContext.createMediaStreamSource(micStream);
      micSrc.connect(dest);
      combinedStream = dest.stream;
      console.log("[off] mixed stream (tab+mic)");
    } else {
      // Tab-only: un-mute for user
      const audio = new Audio();
      audio.srcObject = tabStream;
      audio.play().catch(() => {});
      combinedStream = tabStream;
    }
  } catch (err) {
    console.error("[off] stream acquisition failed", err);
    for (const s of sourceStreams) s.getTracks().forEach((t) => t.stop());
    if (audioContext) try { await audioContext.close(); } catch {}
    return { ok: false, error: `Stream failed: ${err.message || err}` };
  }

  state.sourceStreams = sourceStreams;
  state.audioContext = audioContext;
  state.stream = combinedStream;

  // Mime type
  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";

  // POST /call/start
  let callId;
  try {
    const params = new URLSearchParams({ token });
    if (tabTitle) params.set("tabTitle", tabTitle.slice(0, 200));
    if (tabUrl) params.set("tabUrl", tabUrl.slice(0, 500));
    const url = `${state.serverUrl}/call/start?${params}`;
    console.log("[off] POST", url);
    const resp = await fetch(url, { method: "POST" });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      combinedStream.getTracks().forEach((t) => t.stop());
      return { ok: false, error: `start failed (${resp.status}): ${text}` };
    }
    const body = await resp.json();
    callId = body.callId;
    console.log("[off] call started:", callId);
  } catch (err) {
    console.error("[off] /call/start failed", err);
    combinedStream.getTracks().forEach((t) => t.stop());
    return { ok: false, error: `start request failed: ${err.message || err}` };
  }

  state.callId = callId;
  state.startedAt = Date.now();
  state.phase = "recording";

  startRecorderCycle(mime);
  return { ok: true, callId };
}

function startRecorderCycle(mime) {
  spawnRecorder(mime);
  state.cycleTimer = setInterval(() => {
    if (state.phase !== "recording") return;
    const prev = state.activeRecorder;
    spawnRecorder(mime);
    try { prev?.stop(); } catch {}
  }, CYCLE_MS);
}

function spawnRecorder(mime) {
  if (!state.stream) return;
  const rec = new MediaRecorder(state.stream, { mimeType: mime });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
  rec.onstop = async () => {
    const blob = new Blob(chunks, { type: mime });
    if (blob.size === 0) { console.log("[off] empty chunk, skipping"); return; }
    const idx = state.chunkIdx++;
    try {
      const fd = new FormData();
      fd.append("chunk", blob, `chunk-${idx}.webm`);
      console.log(`[off] uploading chunk ${idx} (${blob.size} bytes)`);
      const resp = await fetch(
        `${state.serverUrl}/call/chunk?token=${encodeURIComponent(state.token)}&callId=${encodeURIComponent(state.callId)}`,
        { method: "POST", body: fd }
      );
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        setError(`chunk ${idx} upload ${resp.status}: ${text}`);
      } else {
        state.chunksUploaded++;
        state.lastChunkAt = Date.now();
        console.log(`[off] chunk ${idx} uploaded`);
      }
    } catch (err) {
      setError(`chunk ${idx} upload failed: ${err.message || err}`);
    }
  };
  rec.start();
  state.activeRecorder = rec;
}

async function stopRecording() {
  console.log("[off] stopRecording, phase:", state.phase);
  if (state.phase !== "recording") return { ok: true, state: state.phase };
  state.phase = "stopping";

  if (state.cycleTimer) { clearInterval(state.cycleTimer); state.cycleTimer = null; }
  try { state.activeRecorder?.stop(); } catch {}

  // Let last onstop flush
  await new Promise((r) => setTimeout(r, 200));

  // Release streams
  try { state.stream?.getTracks().forEach((t) => t.stop()); } catch {}
  for (const s of state.sourceStreams) {
    try { s.getTracks().forEach((t) => t.stop()); } catch {}
  }
  if (state.audioContext) {
    try { await state.audioContext.close(); } catch {}
  }

  // POST /call/stop
  try {
    const url = `${state.serverUrl}/call/stop?token=${encodeURIComponent(state.token)}&callId=${encodeURIComponent(state.callId)}`;
    console.log("[off] POST", url);
    const resp = await fetch(url, { method: "POST" });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      setError(`stop failed (${resp.status}): ${text}`);
    }
  } catch (err) {
    setError(`stop failed: ${err.message || err}`);
  }

  const callId = state.callId;
  const durationSec = Math.round((Date.now() - state.startedAt) / 1000);

  // Reset
  state.phase = "idle";
  state.stream = null;
  state.sourceStreams = [];
  state.audioContext = null;
  state.activeRecorder = null;
  state.callId = "";

  return { ok: true, callId, durationSec };
}

function getState() {
  return {
    ok: true,
    state: state.phase,
    callId: state.callId,
    elapsedSec: state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0,
    chunksUploaded: state.chunksUploaded,
    lastChunkAgoSec: state.lastChunkAt ? Math.round((Date.now() - state.lastChunkAt) / 1000) : -1,
    error: state.error,
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return;
  (async () => {
    try {
      if (msg.type === "start") sendResponse(await startRecording(msg));
      else if (msg.type === "stop") sendResponse(await stopRecording());
      else if (msg.type === "state") sendResponse(getState());
      else sendResponse({ ok: false, error: `Unknown ${msg.type}` });
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
  })();
  return true;
});
