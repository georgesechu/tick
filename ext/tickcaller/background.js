// Service worker — orchestrates tab-capture lifecycle.
//
// Never holds a MediaStream here (service workers can be killed).
// We obtain a tab-capture streamId, spin up an offscreen document
// to hold the stream + MediaRecorder, and coordinate via messages.

const OFFSCREEN_PATH = "offscreen.html";

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["USER_MEDIA"],
    justification: "Tab + mic audio capture for TickCaller transcription.",
  });
}

async function closeOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (contexts.length > 0) await chrome.offscreen.closeDocument();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "background") return;

  (async () => {
    try {
      switch (msg.type) {
        case "start-call": {
          const { serverUrl, token, tabId, tabTitle, tabUrl } = msg;
          console.log("[bg] start-call", { tabId, tabTitle });

          if (!serverUrl || !token || !tabId) {
            sendResponse({ ok: false, error: "Missing serverUrl/token/tabId." });
            return;
          }

          // Check if already recording
          try {
            const contexts = await chrome.runtime.getContexts({
              contextTypes: ["OFFSCREEN_DOCUMENT"],
            });
            if (contexts.length > 0) {
              const curState = await chrome.runtime.sendMessage({
                target: "offscreen",
                type: "state",
              });
              if (curState && curState.state === "recording") {
                sendResponse({
                  ok: false,
                  error: "A call is already in progress. End it first.",
                });
                return;
              }
            }
          } catch (err) {
            console.warn("[bg] pre-flight check failed:", err);
          }

          // Get tab capture stream ID
          let streamId;
          try {
            streamId = await new Promise((resolve, reject) => {
              chrome.tabCapture.getMediaStreamId(
                { targetTabId: tabId },
                (id) => {
                  if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                  } else if (!id) {
                    reject(new Error("tabCapture returned empty streamId"));
                  } else {
                    resolve(id);
                  }
                }
              );
            });
          } catch (err) {
            console.error("[bg] getMediaStreamId failed", err);
            sendResponse({ ok: false, error: `tabCapture: ${err.message || err}` });
            return;
          }

          await ensureOffscreenDocument();
          console.log("[bg] offscreen ready, forwarding start");

          const resp = await chrome.runtime.sendMessage({
            target: "offscreen",
            type: "start",
            streamId,
            serverUrl,
            token,
            tabTitle,
            tabUrl,
          });
          sendResponse(resp || { ok: false, error: "No response from offscreen." });
          return;
        }

        case "end-call": {
          // Fire-and-forget — don't await (popup can close mid-wait)
          console.log("[bg] end-call requested");
          chrome.runtime.sendMessage({ target: "offscreen", type: "stop" })
            .then((resp) => {
              console.log("[bg] offscreen stop response", resp);
              return closeOffscreenDocument();
            })
            .catch((err) => console.error("[bg] stop flow error", err));
          sendResponse({ ok: true, state: "stopping" });
          return;
        }

        case "get-state": {
          const contexts = await chrome.runtime.getContexts({
            contextTypes: ["OFFSCREEN_DOCUMENT"],
          });
          if (contexts.length === 0) {
            sendResponse({ ok: true, state: "idle" });
            return;
          }
          const resp = await chrome.runtime.sendMessage({
            target: "offscreen",
            type: "state",
          });
          sendResponse(resp || { ok: true, state: "unknown" });
          return;
        }

        default:
          sendResponse({ ok: false, error: `Unknown type ${msg.type}` });
      }
    } catch (err) {
      console.error("[bg]", err);
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
  })();

  return true; // keep message channel open for async response
});
