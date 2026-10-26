// SideChat background worker.
// - Context menu + keyboard shortcut open a widget for the current selection.
// - Widgets on non-claude.ai pages stream through here: the request runs inside a
//   claude.ai tab (your logged-in session, no API key), or falls back to the
//   Anthropic API when you've saved a key.
// - Hidden sub-chat conversations are deleted from a claude.ai tab; if none is
//   open the delete is queued and drained on the next claude.ai load.

const DEFAULTS = { engine: "auto", apiKey: "", apiModel: "claude-sonnet-5-5", webModel: "" };
const CLAUDE_URL = "https://claude.ai/new";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getSettings = () => chrome.storage.local.get(DEFAULTS);

chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "sidechat-ask", title: 'Ask SideChat about "%s"', contexts: ["selection"] });
  });
  // Manifest content scripts only reach pages loaded after install/reload, so
  // tabs that were already open would show no Ask button until refreshed.
  const tabs = await chrome.tabs.query({ url: ["https://*/*", "http://*/*"] });
  for (const tab of tabs) {
    chrome.scripting
      .executeScript({ target: { tabId: tab.id }, files: ["content.js"] })
      .catch(() => {}); // restricted pages (Web Store, discarded tabs)
  }
});

// An earlier build redirected .pdf links to a bundled viewer through a dynamic
// rule, and dynamic rules outlive reloads. Clear it so PDFs open in Chrome again.
chrome.runtime.onInstalled.addListener(() => {
  chrome.declarativeNetRequest?.updateDynamicRules({ removeRuleIds: [1] }).catch(() => {});
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

async function openWidgetIn(tabId, frameId, quote) {
  const send = (frame) => chrome.tabs.sendMessage(tabId, { type: "open-widget", quote }, { frameId: frame });
  const inject = (frame) => chrome.scripting.executeScript({ target: { tabId, frameIds: [frame] }, files: ["content.js"] });
  // Try the clicked frame, then the top frame. Selections inside Chrome's PDF
  // viewer come from a frame extensions can't touch, but the page hosting the
  // PDF can still show the widget over it.
  for (const frame of frameId ? [frameId, 0] : [0]) {
    try {
      return await send(frame);
    } catch (_) {}
    try {
      // Content script missing (iframe, page opened before install) — inject, then retry.
      await inject(frame);
      return await send(frame);
    } catch (_) {}
  }
  // Restricted page (chrome://, Web Store).
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "sidechat-ask" || !tab?.id) return;
  openWidgetIn(tab.id, Number.isInteger(info.frameId) ? info.frameId : 0, (info.selectionText || "").trim());
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "ask-selection" || !tab?.id) return;
  openWidgetIn(tab.id, 0, null); // null → content script reads its own selection
});

// --- claude.ai tab relay ----------------------------------------------------

async function tabAnswers(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: "sc-ping" }, { frameId: 0 });
    return !!r?.ok;
  } catch (_) {
    return false;
  }
}

async function claudeTab(createIfMissing) {
  const tabs = await chrome.tabs.query({ url: "https://claude.ai/*" });
  for (const t of tabs) {
    if (await tabAnswers(t.id)) return t.id;
    try {
      await chrome.scripting.executeScript({ target: { tabId: t.id, frameIds: [0] }, files: ["content.js"] });
      if (await tabAnswers(t.id)) return t.id;
    } catch (_) {}
  }
  if (!createIfMissing) return null;
  const tab = await chrome.tabs.create({ url: CLAUDE_URL, active: false, pinned: true });
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const t = await chrome.tabs.get(tab.id);
      if (t.status === "complete" && (await tabAnswers(tab.id))) return tab.id;
    } catch (_) {
      break;
    }
  }
  try { await chrome.tabs.remove(tab.id); } catch (_) {}
  throw new Error("couldn't open a claude.ai tab");
}

function relayViaClaudeTab(tabId, msg, emit, signal) {
  const port = chrome.tabs.connect(tabId, { name: "sc-exec", frameId: 0 });
  return new Promise((resolve, reject) => {
    let settled = false;
    let idle;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      try { port.disconnect(); } catch (_) {}
      err ? reject(err) : resolve(val);
    };
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => finish(new Error("claude.ai stopped responding")), 90000);
    };
    signal.addEventListener("abort", () => finish(new Error("cancelled")), { once: true });
    port.onMessage.addListener((m) => {
      arm();
      if (m.delta) emit({ delta: m.delta });
      else if (m.done) finish(null, { full: m.full, state: m.state });
      else if (m.error) finish(new Error(m.error));
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      finish(new Error("claude.ai tab closed"));
    });
    arm();
    port.postMessage({ type: "send", prompt: msg.prompt, state: msg.state || {} });
  });
}

// --- Anthropic API fallback -------------------------------------------------

async function apiSend(msg, emit, signal, settings) {
  if (!settings.apiKey) throw new Error("no API key saved");
  const messages = (msg.apiMessages || []).concat([{ role: "user", content: msg.prompt }]);
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({ model: settings.apiModel, max_tokens: 4096, stream: true, messages }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    let detail = "";
    try { detail = JSON.parse(text)?.error?.message || ""; } catch (_) {}
    throw new Error("API " + resp.status + (detail ? ": " + detail : ""));
  }
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let full = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      let j;
      try { j = JSON.parse(line.slice(5)); } catch (_) { continue; }
      if (j.type === "content_block_delta" && typeof j.delta?.text === "string") {
        full += j.delta.text;
        emit({ delta: j.delta.text });
      } else if (j.type === "error") {
        throw new Error(j.error?.message || "API stream error");
      }
    }
  }
  return { full, model: settings.apiModel };
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "sc-relay") return;
  const controller = new AbortController();
  let gone = false;
  port.onDisconnect.addListener(() => {
    gone = true;
    controller.abort();
  });
  const emit = (m) => {
    if (!gone) try { port.postMessage(m); } catch (_) {}
  };
  port.onMessage.addListener(async (msg) => {
    if (msg?.type !== "send") return;
    const settings = await getSettings();
    // A conversation already started on one engine stays there.
    const useApi = msg.engine === "api" || (!msg.engine && settings.engine === "api");
    const allowFallback = !msg.engine && settings.engine === "auto" && !!settings.apiKey;
    let streamed = false;
    const tracked = (m) => {
      if (m.delta) streamed = true;
      emit(m);
    };
    try {
      if (!useApi) {
        try {
          const tabId = await claudeTab(true);
          const out = await relayViaClaudeTab(tabId, msg, tracked, controller.signal);
          return emit({ done: true, engine: "claude", full: out.full, state: out.state });
        } catch (e) {
          if (streamed || !allowFallback || controller.signal.aborted) throw e;
        }
      }
      const out = await apiSend(msg, tracked, controller.signal, settings);
      emit({ done: true, engine: "api", full: out.full, model: out.model });
    } catch (e) {
      emit({ error: String(e?.message || e) });
    }
  });
});

// --- Cleanup of hidden sub-chat conversations ------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.type === "open-options") chrome.runtime.openOptionsPage();
  if (msg?.type === "cleanup" && msg.state?.convId) {
    claudeTab(false)
      .then(async (tabId) => {
        if (tabId) {
          try {
            await chrome.tabs.sendMessage(tabId, { type: "sc-cleanup", state: msg.state }, { frameId: 0 });
            return;
          } catch (_) {}
        }
        const { pendingCleanups = [] } = await chrome.storage.local.get("pendingCleanups");
        pendingCleanups.push(msg.state);
        await chrome.storage.local.set({ pendingCleanups: pendingCleanups.slice(-200) });
      })
      .catch(() => {});
  }
  if (msg?.type === "keep" && msg.state?.convId) {
    claudeTab(false)
      .then(async (tabId) => {
        if (!tabId) return respond({ ok: false, error: "Open a claude.ai tab to keep this chat" });
        respond(await chrome.tabs.sendMessage(tabId, { type: "sc-rename", state: msg.state, title: msg.title }, { frameId: 0 }));
      })
      .catch((e) => respond({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg?.type === "drain-cleanups") {
    chrome.storage.local.get({ pendingCleanups: [] }).then(async ({ pendingCleanups }) => {
      await chrome.storage.local.set({ pendingCleanups: [] });
      respond({ pending: pendingCleanups });
    });
    return true;
  }
});
