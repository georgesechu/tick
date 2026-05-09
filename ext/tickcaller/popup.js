// TickCaller popup — one-button call UI.

const $ = (sel) => document.querySelector(sel);
const configMissing = $("#config-missing");
const idleView = $("#idle-view");
const activeView = $("#active-view");
const errorEl = $("#error");
const elapsedEl = $("#elapsed");
const tabInfoEl = $("#tab-info");
const tabLabelEl = $("#tab-label");
const metaEl = $("#rec-meta");

let elapsedTimer = null;

function showError(msg) {
  if (!msg) { errorEl.classList.add("hidden"); errorEl.textContent = ""; return; }
  errorEl.textContent = msg;
  errorEl.classList.remove("hidden");
}

function fmt(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

async function getConfig() {
  return new Promise((r) =>
    chrome.storage.local.get(["serverUrl", "token"], r)
  );
}

async function currentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function sendBg(msg) {
  return chrome.runtime.sendMessage({ target: "background", ...msg });
}

async function refresh() {
  showError("");
  const cfg = await getConfig();

  if (!cfg.serverUrl || !cfg.token) {
    configMissing.classList.remove("hidden");
    idleView.classList.add("hidden");
    activeView.classList.add("hidden");
    return;
  }

  // Check current state
  const state = await sendBg({ type: "get-state" });
  if (state?.state === "recording") {
    showActiveUi(state);
    return;
  }

  // Idle — show call button
  configMissing.classList.add("hidden");
  activeView.classList.add("hidden");
  idleView.classList.remove("hidden");

  const tab = await currentTab();
  if (tab) {
    tabInfoEl.textContent = tab.title || tab.url || "Current tab";
  }
}

function showActiveUi(initialState) {
  configMissing.classList.add("hidden");
  idleView.classList.add("hidden");
  activeView.classList.remove("hidden");

  if (elapsedTimer) clearInterval(elapsedTimer);

  const startBase = Date.now();
  const tick = async () => {
    const sec = (initialState.elapsedSec || 0) + Math.floor((Date.now() - startBase) / 1000);
    elapsedEl.textContent = fmt(sec);
    const st = await sendBg({ type: "get-state" }).catch(() => null);
    if (st && st.state === "recording") {
      const ago = st.lastChunkAgoSec >= 0 ? `${st.lastChunkAgoSec}s ago` : "--";
      metaEl.textContent = `chunks: ${st.chunksUploaded} \u00b7 last: ${ago}`;
      if (st.error) showError(st.error);
    } else if (st && st.state === "idle") {
      // Call ended externally
      if (elapsedTimer) clearInterval(elapsedTimer);
      await refresh();
    }
  };
  tick();
  elapsedTimer = setInterval(tick, 1000);
}

// Settings
$("#settings-btn").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("#open-options")?.addEventListener("click", () => chrome.runtime.openOptionsPage());

// Call button
$("#call-btn").addEventListener("click", async () => {
  const btn = $("#call-btn");
  btn.disabled = true;
  btn.textContent = "Connecting...";
  showError("");

  try {
    const cfg = await getConfig();
    if (!cfg.serverUrl || !cfg.token) throw new Error("Not configured.");

    const tab = await currentTab();
    if (!tab?.id) throw new Error("No active tab.");

    // Warm mic permission from popup context (important — see agent-bridge docs)
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((t) => t.stop());
    } catch (err) {
      if (err?.name === "NotAllowedError") {
        throw new Error("Mic permission denied. Open Settings to grant access.");
      }
      // Non-fatal — might work without mic (tab-only)
      console.warn("Mic probe failed:", err);
    }

    const resp = await sendBg({
      type: "start-call",
      serverUrl: cfg.serverUrl,
      token: cfg.token,
      tabId: tab.id,
      tabTitle: tab.title || "",
      tabUrl: tab.url || "",
    });

    if (!resp?.ok) throw new Error(resp?.error || "Start failed.");

    tabLabelEl.textContent = tab.title || tab.url || "";
    const state = await sendBg({ type: "get-state" });
    showActiveUi(state);
  } catch (err) {
    showError(err.message || String(err));
    btn.disabled = false;
    btn.textContent = "Call Johan";
  }
});

// End button
$("#end-btn").addEventListener("click", async () => {
  const btn = $("#end-btn");
  btn.disabled = true;
  btn.textContent = "Ending...";
  const resp = await sendBg({ type: "end-call" });
  if (elapsedTimer) clearInterval(elapsedTimer);
  if (!resp?.ok) showError(resp?.error || "End failed.");
  await refresh();
  btn.disabled = false;
  btn.textContent = "End Call";
});

refresh();
