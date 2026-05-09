// TickCaller options — server URL + token, mic permission grant.

const urlInput = document.getElementById("server-url");
const tokenInput = document.getElementById("token");
const saveBtn = document.getElementById("save");
const savedLabel = document.getElementById("saved");

// Load
chrome.storage.local.get(["serverUrl", "token"], (cfg) => {
  urlInput.value = cfg.serverUrl || "";
  tokenInput.value = cfg.token || "";
});

// Save
saveBtn.addEventListener("click", () => {
  const serverUrl = urlInput.value.trim().replace(/\/$/, "");
  const token = tokenInput.value.trim();
  chrome.storage.local.set({ serverUrl, token }, () => {
    savedLabel.classList.add("show");
    setTimeout(() => savedLabel.classList.remove("show"), 1500);
  });
});

// Mic permission
const grantMicBtn = document.getElementById("grant-mic");
const micStatus = document.getElementById("mic-status");

grantMicBtn.addEventListener("click", async () => {
  micStatus.textContent = "Requesting...";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    micStatus.textContent = "Granted";
    micStatus.style.color = "#10b981";
  } catch (err) {
    if (err?.name === "NotAllowedError") {
      micStatus.textContent = "Denied. Click the mic icon in the address bar to re-enable.";
    } else {
      micStatus.textContent = `Error: ${err?.message || err}`;
    }
    micStatus.style.color = "#fca5a5";
  }
});
