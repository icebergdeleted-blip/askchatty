// AskChatty content script.
// Highlight text on any page → click "Ask" → a draggable, resizable widget runs
// its own hidden Claude conversation and streams the reply in. On claude.ai the
// request goes straight to claude.ai's own API with your session; elsewhere it is
// relayed through the background worker into a claude.ai tab (or the Anthropic
// API if you saved a key). Hidden conversations are deleted when the widget closes
// unless you hit "Keep", which renames it so it stays in your Claude history.

(() => {
  // Chrome renders PDFs in a frame extensions can't read, so selections there
  // never reach this script. The page around it can still host the widget,
  // opened from the right-click menu.
  const IS_PDF = document.contentType === "application/pdf";

  // After the extension reloads, the old copy on an open tab is dead (chrome.* throws)
  // but still holds the page. Let a fresh injection replace it instead of bowing out.
  const prev = window.__sidechat;
  if (prev && prev.alive()) return;
  if (prev) try { prev.teardown(); } catch (_) {}
  const life = new AbortController();
  const listen = { signal: life.signal };
  window.__sidechat = {
    alive: () => { try { return !!chrome.runtime?.id; } catch (_) { return false; } },
    teardown: () => {
      life.abort();
      document.querySelectorAll("sidechat-root").forEach((el) => el.remove());
    },
  };

  const ON_CLAUDE = /(^|\.)claude\.ai$/.test(location.hostname);
  const CONV_NAME = "↪ AskChatty";
  const ROOT_PARENT = "00000000-0000-4000-8000-000000000000";
  const SETTINGS_DEFAULTS = { engine: "auto", apiKey: "", apiModel: "claude-sonnet-5-5", webModel: "" };

  const uuid = () => crypto.randomUUID();
  const getSettings = () => chrome.storage.local.get(SETTINGS_DEFAULTS);

  async function* sseLines(resp) {
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        yield buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
      }
    }
    if (buf) yield buf;
  }

  // --- claude.ai session adapter (runs only on claude.ai) --------------------

  const liveConvs = new Set();
  let cachedOrgId = null;

  async function claudeOrgId() {
    if (cachedOrgId) return cachedOrgId;
    const r = await fetch("/api/organizations", { credentials: "include", headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(r.status === 403 || r.status === 401 ? "Not signed in to claude.ai" : "claude.ai orgs " + r.status);
    const orgs = await r.json();
    const chat = orgs.find((o) => (o.capabilities || []).includes("chat")) || orgs[0];
    if (!chat?.uuid) throw new Error("No claude.ai organization found");
    return (cachedOrgId = chat.uuid);
  }

  const claude = {
    async ensure(state) {
      if (state.orgId && state.convId) return;
      state.orgId = state.orgId || (await claudeOrgId());
      const body = { uuid: uuid(), name: CONV_NAME, include_conversation_preferences: true };
      if (state.webModel) body.model = state.webModel;
      const r = await fetch(`/api/organizations/${state.orgId}/chat_conversations`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error("Couldn't create a Claude sub-chat (" + r.status + ")");
      state.convId = (await r.json()).uuid;
      state.parentId = ROOT_PARENT;
      liveConvs.add(state.convId);
    },

    async send(state, prompt, onDelta, signal) {
      await this.ensure(state);
      const body = {
        prompt,
        parent_message_uuid: state.parentId || ROOT_PARENT,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        attachments: [],
        files: [],
      };
      if (state.webModel) body.model = state.webModel;
      const resp = await fetch(
        `/api/organizations/${state.orgId}/chat_conversations/${state.convId}/completion`,
        {
          method: "POST",
          credentials: "include",
          signal,
          headers: { "content-type": "application/json", accept: "text/event-stream" },
          body: JSON.stringify(body),
        }
      );
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        let detail = "";
        try { detail = JSON.parse(text)?.error?.message || ""; } catch (_) {}
        throw new Error("Claude rejected the request (" + resp.status + ")" + (detail ? ": " + detail : ""));
      }
      let full = "";
      for await (const line of sseLines(resp)) {
        if (!line.startsWith("data:")) continue;
        let j;
        try { j = JSON.parse(line.slice(5)); } catch (_) { continue; }
        let piece = "";
        if (j.type === "content_block_delta" && typeof j.delta?.text === "string") piece = j.delta.text;
        else if (j.type === "completion" && typeof j.completion === "string") piece = j.completion;
        else if (j.type === "error") throw new Error(j.error?.message || "Claude stream error");
        if (piece) {
          full += piece;
          onDelta(piece);
        }
      }
      // The next turn must branch from the assistant message we just got.
      try {
        const r = await fetch(
          `/api/organizations/${state.orgId}/chat_conversations/${state.convId}?tree=True&rendering_mode=messages`,
          { credentials: "include", headers: { accept: "application/json" } }
        );
        if (r.ok) {
          const msgs = (await r.json()).chat_messages || [];
          if (msgs.length) state.parentId = msgs[msgs.length - 1].uuid;
        }
      } catch (_) {}
      return full;
    },

    async remove(orgId, convId, keepalive = false) {
      liveConvs.delete(convId);
      await fetch(`/api/organizations/${orgId}/chat_conversations/${convId}`, {
        method: "DELETE",
        credentials: "include",
        keepalive,
      }).catch(() => {});
    },

    async rename(state, title) {
      const name = ("↪ " + (title || "Kept chat")).replace(/\s+/g, " ").slice(0, 100);
      const r = await fetch(`/api/organizations/${state.orgId}/chat_conversations/${state.convId}`, {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) throw new Error("rename failed (" + r.status + ")");
      liveConvs.delete(state.convId);
    },

    // Delete AskChatty conversations left behind by crashed tabs/closed windows.
    // Only touches threads still carrying the exact hidden name and idle >15 min.
    async sweepOrphans() {
      const orgId = await claudeOrgId();
      const r = await fetch(`/api/organizations/${orgId}/chat_conversations?limit=100`, { credentials: "include" });
      if (!r.ok) return;
      const cutoff = Date.now() - 15 * 60 * 1000;
      for (const c of await r.json()) {
        if (c.name !== CONV_NAME || liveConvs.has(c.uuid)) continue;
        if (new Date(c.updated_at || c.created_at).getTime() > cutoff) continue;
        await this.remove(orgId, c.uuid);
      }
    },
  };

  if (ON_CLAUDE) {
    // Background relays requests from widgets on other sites into this tab.
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name !== "sc-exec") return;
      const controller = new AbortController();
      let gone = false;
      port.onDisconnect.addListener(() => {
        gone = true;
        controller.abort();
      });
      const post = (m) => { if (!gone) try { port.postMessage(m); } catch (_) {} };
      port.onMessage.addListener(async (msg) => {
        if (msg?.type !== "send") return;
        const state = { ...msg.state };
        try {
          const full = await claude.send(state, msg.prompt, (d) => post({ delta: d }), controller.signal);
          post({ done: true, full, state: { orgId: state.orgId, convId: state.convId, parentId: state.parentId } });
        } catch (e) {
          post({ error: String(e?.message || e) });
        }
      });
    });

    chrome.runtime.sendMessage({ type: "drain-cleanups" }).then(async (res) => {
      for (const s of res?.pending || []) await claude.remove(s.orgId, s.convId);
    }).catch(() => {});
    setTimeout(() => claude.sweepOrphans().catch(() => {}), 20000);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg?.type === "sc-ping") {
      respond({ ok: true });
      return;
    }
    if (msg?.type === "sc-cleanup" && ON_CLAUDE) {
      claude.remove(msg.state.orgId, msg.state.convId).then(() => respond({ ok: true }));
      return true;
    }
    if (msg?.type === "sc-rename" && ON_CLAUDE) {
      claude.rename({ ...msg.state }, msg.title)
        .then(() => respond({ ok: true }))
        .catch((e) => respond({ ok: false, error: String(e.message || e) }));
      return true;
    }
    if (msg?.type === "open-widget") {
      const quote = msg.quote == null ? currentSelection() : msg.quote;
      const rect = selectionRect();
      createWidget(quote || "", rect);
    }
  });

  // --- Relay to background (non-claude.ai pages, or API engine) -------------

  function relaySend({ prompt, state, engine, apiMessages }, onDelta, signal) {
    return new Promise((resolve, reject) => {
      let port;
      try {
        port = chrome.runtime.connect({ name: "sc-relay" });
      } catch (_) {
        return reject(new Error("Extension was reloaded — refresh this page."));
      }
      let settled = false;
      const finish = (fn, v) => {
        if (settled) return;
        settled = true;
        try { port.disconnect(); } catch (_) {}
        fn(v);
      };
      signal.addEventListener("abort", () => finish(reject, new DOMException("aborted", "AbortError")), { once: true });
      port.onMessage.addListener((m) => {
        if (m.delta) onDelta(m.delta);
        else if (m.done) finish(resolve, m);
        else if (m.error) finish(reject, new Error(m.error));
      });
      port.onDisconnect.addListener(() => finish(reject, new Error("Relay closed — is the extension still enabled?")));
      port.postMessage({ type: "send", prompt, state, engine, apiMessages });
    });
  }

  // --- Markdown (small, safe subset) ----------------------------------------

  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }
  function renderMarkdown(text) {
    const out = [];
    const lines = text.split("\n");
    let para = [];
    let list = null;
    const flushPara = () => {
      if (para.length) out.push("<p>" + para.map(inline).join("<br>") + "</p>");
      para = [];
    };
    const flushList = () => {
      if (list) out.push(`<${list.tag}>` + list.items.map((i) => "<li>" + inline(i) + "</li>").join("") + `</${list.tag}>`);
      list = null;
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^```/.test(line)) {
        flushPara(); flushList();
        const code = [];
        while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i]);
        out.push("<pre><code>" + esc(code.join("\n")) + "</code></pre>");
        continue;
      }
      let m;
      if ((m = line.match(/^(#{1,4})\s+(.*)/))) {
        flushPara(); flushList();
        out.push(`<h${m[1].length + 2}>` + inline(m[2]) + `</h${m[1].length + 2}>`);
      } else if ((m = line.match(/^\s*([-*•]|\d+[.)])\s+(.*)/))) {
        flushPara();
        const tag = /\d/.test(m[1]) ? "ol" : "ul";
        if (list && list.tag !== tag) flushList();
        list = list || { tag, items: [] };
        list.items.push(m[2]);
      } else if ((m = line.match(/^>\s?(.*)/))) {
        flushPara(); flushList();
        out.push("<blockquote>" + inline(m[1]) + "</blockquote>");
      } else if (!line.trim()) {
        // Keep a list open across blank lines so "1. … \n\n 2. …" stays one <ol>.
        flushPara();
      } else {
        flushList();
        para.push(line);
      }
    }
    flushPara(); flushList();
    return out.join("");
  }

  // --- UI ---------------------------------------------------------------------

  const host = document.createElement("sidechat-root");
  host.style.cssText = "all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>
    :host { --bg:#fbfaf7; --fg:#1f1e1c; --muted:#6f6b63; --line:#e3dfd6; --accent:#c96442; --bubble:#f0ece4; --code:#f3f0ea; }
    @media (prefers-color-scheme: dark) {
      :host { --bg:#262624; --fg:#ecebe6; --muted:#a39f95; --line:#3d3c38; --accent:#d97757; --bubble:#33322f; --code:#1d1d1b; }
    }
    * { box-sizing:border-box; }
    .chip { position:fixed; display:none; align-items:center; gap:7px; padding:6px 14px 6px 6px; border-radius:999px;
      background:#c96442; color:#fff; font:600 14px/1 system-ui,-apple-system,"Segoe UI",sans-serif; cursor:pointer;
      border:2px solid #fff; box-shadow:0 6px 20px rgba(0,0,0,.28); animation:pop .14s ease-out; }
    .chip img { width:22px; height:22px; border-radius:6px; }
    .chip:hover { background:#b5573a; transform:translateY(-1px); }
    @keyframes pop { from { opacity:0; transform:scale(.85) translateY(4px); } to { opacity:1; transform:none; } }
    .panel { position:fixed; width:400px; height:470px; min-width:280px; min-height:220px; resize:both; overflow:hidden;
      display:flex; flex-direction:column; background:var(--bg); color:var(--fg); border:1px solid var(--line);
      border-radius:14px; box-shadow:0 14px 44px rgba(0,0,0,.25); font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
    .panel.min { height:auto !important; min-height:0; resize:none; }
    .panel.min .body, .panel.min .foot { display:none; }
    .head { display:flex; align-items:center; gap:6px; padding:8px 10px; border-bottom:1px solid var(--line); cursor:move; user-select:none; }
    .logo { width:18px; height:18px; flex:none; }
    .title { flex:1; font-weight:600; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .engine { font-size:11px; color:var(--muted); }
    .btn { border:0; background:transparent; color:var(--muted); cursor:pointer; padding:3px 7px; border-radius:6px; font:12px system-ui,sans-serif; }
    .btn:hover { background:var(--bubble); color:var(--fg); }
    .btn.on { color:var(--accent); font-weight:600; }
    .body { flex:1; overflow-y:auto; padding:10px 12px; display:flex; flex-direction:column; gap:10px; }
    .quote { border-left:3px solid var(--accent); padding:4px 10px; color:var(--muted); font-size:12.5px; max-height:90px; overflow:auto; white-space:pre-wrap; }
    .msg { word-wrap:break-word; }
    .msg.user { align-self:flex-end; background:var(--bubble); padding:6px 11px; border-radius:12px 12px 2px 12px; max-width:88%; white-space:pre-wrap; }
    .msg.bot p { margin:0 0 8px; } .msg.bot p:last-child { margin-bottom:0; }
    .msg.bot ul, .msg.bot ol { margin:4px 0 8px; padding-left:20px; }
    .msg.bot h3, .msg.bot h4, .msg.bot h5, .msg.bot h6 { margin:8px 0 4px; font-size:14px; }
    .msg.bot pre { background:var(--code); padding:8px 10px; border-radius:8px; overflow-x:auto; font-size:12.5px; }
    .msg.bot code { font-family:ui-monospace,Consolas,monospace; background:var(--code); padding:1px 4px; border-radius:4px; font-size:12.5px; }
    .msg.bot pre code { padding:0; background:none; }
    .msg.bot blockquote { margin:4px 0; padding-left:10px; border-left:2px solid var(--line); color:var(--muted); }
    .msg.bot a { color:var(--accent); }
    .msg.err { color:#c0392b; font-size:13px; }
    .actions { display:flex; gap:4px; margin-top:2px; }
    .empty { color:var(--muted); font-size:13px; }
    .foot { display:flex; gap:6px; padding:8px 10px; border-top:1px solid var(--line); align-items:flex-end; }
    textarea { flex:1; resize:none; border:1px solid var(--line); border-radius:9px; padding:7px 9px; max-height:120px; min-height:36px;
      background:var(--bg); color:var(--fg); font:14px/1.4 system-ui,sans-serif; outline:none; }
    textarea:focus { border-color:var(--accent); }
    .send { background:var(--accent); color:#fff; border:0; border-radius:9px; padding:8px 13px; cursor:pointer; font:600 13px system-ui,sans-serif; }
    .send:disabled { opacity:.5; cursor:default; }
    .toast { position:fixed; bottom:20px; left:50%; transform:translateX(-50%); background:var(--fg); color:var(--bg);
      padding:7px 14px; border-radius:8px; font:13px system-ui,sans-serif; }
  </style><button class="chip" title="Ask Claude about this (Alt+Shift+S)"><img alt="" src="${chrome.runtime.getURL("icons/icon32.png")}">Ask</button>`;
  // Attach to <html>, not <body>: single-page apps often swap out <body>.
  const mount = () => { if (!host.isConnected) document.documentElement.appendChild(host); };
  mount();
  const chip = root.querySelector(".chip");

  function toast(text, ms = 2200) {
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = text;
    root.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }
  if (IS_PDF) setTimeout(() => toast("Select text, then right-click → AskChatty: ask about…", 6000), 1200);

  // Text fields keep their selection out of window.getSelection(), so read them directly.
  function fieldSelection() {
    const el = document.activeElement;
    if (!el || !/^(TEXTAREA|INPUT)$/.test(el.tagName) || el === host) return null;
    try {
      const text = el.value.substring(el.selectionStart, el.selectionEnd).trim();
      return text ? { text, rect: el.getBoundingClientRect() } : null;
    } catch (_) {
      return null; // input types without selection support
    }
  }
  function currentSelection() {
    return fieldSelection()?.text || (window.getSelection()?.toString() || "").trim();
  }
  function selectionRect() {
    const field = fieldSelection();
    if (field) return field.rect;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0).getBoundingClientRect();
    return r.width || r.height ? r : null;
  }

  let chipQuote = "";
  let chipRect = null;
  const hideChip = () => (chip.style.display = "none");

  // Place the button just above the selection, beside the pointer, so the
  // cursor never covers it. Falls below the selection near the top edge.
  function showChip(pointer) {
    const text = currentSelection();
    const rect = selectionRect();
    if (!text || !rect) return hideChip();
    mount();
    chipQuote = text;
    chipRect = rect;
    const W = 84, H = 38;
    const x = pointer ? pointer.x + 12 : rect.right - W / 2;
    let y = (pointer ? Math.min(pointer.y - 20, rect.bottom) : rect.top) - H - 6;
    if (y < 6) y = rect.bottom + 10;
    chip.style.left = Math.max(6, Math.min(window.innerWidth - W - 6, x)) + "px";
    chip.style.top = Math.max(6, Math.min(window.innerHeight - H - 6, y)) + "px";
    chip.style.display = "flex";
  }

  document.addEventListener("mouseup", (e) => {
    if (e.button !== 0 || e.composedPath().includes(host)) return;
    const pointer = { x: e.clientX, y: e.clientY };
    setTimeout(() => showChip(pointer), 10);
  }, listen);
  // Keyboard selection (Shift+arrows, Ctrl+A).
  document.addEventListener("keyup", (e) => {
    if (e.composedPath().includes(host)) return;
    if (e.shiftKey || (e.key === "a" && (e.ctrlKey || e.metaKey))) showChip(null);
  }, listen);
  document.addEventListener("mousedown", (e) => {
    if (!e.composedPath().includes(chip)) hideChip();
  }, listen);
  document.addEventListener("selectionchange", () => {
    if (chip.style.display !== "none" && !currentSelection()) hideChip();
  }, listen);
  window.addEventListener("scroll", hideChip, { passive: true, signal: life.signal });
  chip.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection
  chip.addEventListener("click", () => {
    chip.style.display = "none";
    createWidget(chipQuote, chipRect);
  });

  let widgetCount = 0;

  async function saveHistory(entry) {
    const { history = [] } = await chrome.storage.local.get("history");
    const i = history.findIndex((h) => h.id === entry.id);
    if (i >= 0) history.splice(i, 1);
    history.unshift(entry);
    await chrome.storage.local.set({ history: history.slice(0, 300) });
  }

  function createWidget(quote, rect) {
    const n = widgetCount++;
    const panel = document.createElement("div");
    panel.className = "panel";
    const w = 400, h = 470;
    let left = rect ? rect.right + 16 : window.innerWidth - w - 24;
    if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 24;
    let top = rect ? rect.top : 80;
    left = Math.max(8, left - (n % 5) * 24);
    top = Math.max(8, Math.min(window.innerHeight - h - 8, top + (n % 5) * 24));
    panel.style.left = left + "px";
    panel.style.top = top + "px";
    panel.innerHTML = `
      <div class="head">
        <img class="logo" alt="" src="${chrome.runtime.getURL("icons/icon32.png")}">
        <span class="title"></span><span class="engine"></span>
        <button class="btn keep" title="Keep this chat in your claude.ai history">Keep</button>
        <button class="btn clear" title="Start over">↺</button>
        <button class="btn min" title="Minimize">–</button>
        <button class="btn close" title="Close">✕</button>
      </div>
      <div class="body"></div>
      <div class="foot">
        <textarea rows="1" placeholder="Ask a follow-up…"></textarea>
        <button class="send">Send</button>
      </div>`;
    root.appendChild(panel);
    const $ = (s) => panel.querySelector(s);
    const body = $(".body"), input = $("textarea"), sendBtn = $(".send"), keepBtn = $(".keep");
    $(".title").textContent = quote ? "“" + quote.replace(/\s+/g, " ").slice(0, 60) + "”" : "AskChatty";

    let state, entry, controller = null;
    function reset() {
      state = { turn: 0, engine: null, orgId: null, convId: null, parentId: null, apiMessages: [], keep: false };
      entry = { id: uuid(), createdAt: Date.now(), pageTitle: document.title, pageUrl: location.href, quote, turns: [] };
      keepBtn.classList.remove("on");
      keepBtn.style.display = "none";
      $(".engine").textContent = "";
      body.innerHTML = "";
      if (quote) {
        const q = document.createElement("div");
        q.className = "quote";
        q.textContent = quote;
        body.appendChild(q);
      }
      const hint = document.createElement("div");
      hint.className = "empty";
      hint.textContent = quote ? "Ask anything about the highlighted text." : "Ask anything.";
      body.appendChild(hint);
    }
    reset();
    setTimeout(() => input.focus(), 0);

    function buildPrompt(q) {
      if (state.turn > 0) return q;
      let p = "You're a concise side-chat assistant. Answer directly; skip meta commentary.\n\n";
      p += `I'm reading "${document.title}" (${location.href}).\n`;
      if (quote) p += `About this excerpt:\n"""\n${quote.slice(0, 20000)}\n"""\n\n`;
      return p + q;
    }

    function cleanupConv(keepalive = false) {
      if (state.engine !== "claude" || !state.convId || state.keep) return;
      const s = { orgId: state.orgId, convId: state.convId };
      state.convId = null;
      if (ON_CLAUDE) claude.remove(s.orgId, s.convId, keepalive);
      else try { chrome.runtime.sendMessage({ type: "cleanup", state: s }); } catch (_) {}
    }

    async function send() {
      const q = input.value.trim();
      if (!q || controller) return;
      input.value = "";
      input.style.height = "";
      body.querySelector(".empty")?.remove();
      const u = document.createElement("div");
      u.className = "msg user";
      u.textContent = q;
      body.appendChild(u);
      const bot = document.createElement("div");
      bot.className = "msg bot";
      bot.innerHTML = '<p style="opacity:.6">…</p>';
      body.appendChild(bot);
      body.scrollTop = body.scrollHeight;

      controller = new AbortController();
      sendBtn.textContent = "Stop";
      let full = "";
      let raf = 0;
      const onDelta = (d) => {
        full += d;
        if (!raf) raf = requestAnimationFrame(() => {
          raf = 0;
          const stick = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
          bot.innerHTML = renderMarkdown(full);
          if (stick) body.scrollTop = body.scrollHeight;
        });
      };
      const prompt = buildPrompt(q);
      try {
        const settings = await getSettings();
        const wantApi = state.engine ? state.engine === "api" : settings.engine === "api";
        if (ON_CLAUDE && !wantApi) {
          state.webModel = settings.webModel;
          await claude.send(state, prompt, onDelta, controller.signal);
          state.engine = "claude";
        } else {
          const res = await relaySend(
            {
              prompt,
              engine: state.engine,
              apiMessages: state.apiMessages,
              state: { orgId: state.orgId, convId: state.convId, parentId: state.parentId, webModel: settings.webModel },
            },
            onDelta,
            controller.signal
          );
          state.engine = res.engine;
          if (res.state) Object.assign(state, res.state);
          full = res.full || full;
        }
        if (state.engine === "api") state.apiMessages.push({ role: "user", content: prompt }, { role: "assistant", content: full });
        state.turn++;
        $(".engine").textContent = state.engine === "api" ? "API" : "claude.ai";
        keepBtn.style.display = state.engine === "claude" ? "" : "none";
        cancelAnimationFrame(raf);
        bot.innerHTML = renderMarkdown(full);
        addActions(bot, full);
        entry.turns.push({ q, a: full });
        entry.engine = state.engine;
        saveHistory(entry).catch(() => {});
      } catch (e) {
        cancelAnimationFrame(raf);
        if (e.name === "AbortError") {
          bot.innerHTML = renderMarkdown(full + "\n\n*(stopped)*");
        } else {
          bot.className = "msg err";
          bot.textContent = String(e.message || e);
          if (/not signed in|claude\.ai tab/i.test(bot.textContent))
            bot.textContent += " — open claude.ai and sign in, or add an API key in AskChatty settings.";
        }
      } finally {
        controller = null;
        sendBtn.textContent = "Send";
        body.scrollTop = body.scrollHeight;
      }
    }

    function addActions(bubble, text) {
      const bar = document.createElement("div");
      bar.className = "actions";
      const copy = document.createElement("button");
      copy.className = "btn";
      copy.textContent = "Copy";
      copy.onclick = async () => {
        await navigator.clipboard.writeText(text).catch(() => {});
        copy.textContent = "Copied";
        setTimeout(() => (copy.textContent = "Copy"), 1200);
      };
      bar.appendChild(copy);
      bubble.appendChild(bar);
    }

    sendBtn.onclick = () => (controller ? controller.abort() : send());
    input.addEventListener("keydown", (e) => {
      e.stopPropagation(); // don't trigger page shortcuts
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
    });
    input.addEventListener("keyup", (e) => e.stopPropagation());
    input.addEventListener("keypress", (e) => e.stopPropagation());
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = Math.min(120, input.scrollHeight) + "px";
    });

    $(".min").onclick = () => panel.classList.toggle("min");
    $(".clear").onclick = () => {
      controller?.abort();
      cleanupConv();
      reset();
    };
    $(".close").onclick = () => {
      controller?.abort();
      cleanupConv();
      window.removeEventListener("pagehide", onHide);
      panel.remove();
    };
    keepBtn.onclick = async () => {
      if (state.keep || !state.convId) return;
      try {
        const title = entry.turns[0]?.q || quote || "AskChatty";
        if (ON_CLAUDE) await claude.rename(state, title);
        else {
          const r = await chrome.runtime.sendMessage({
            type: "keep",
            state: { orgId: state.orgId, convId: state.convId },
            title,
          });
          if (!r?.ok) throw new Error(r?.error || "Couldn't keep this chat");
        }
        state.keep = true;
        keepBtn.classList.add("on");
        keepBtn.textContent = "Kept";
        toast("Saved to your claude.ai history");
      } catch (e) {
        toast(String(e.message || e));
      }
    };
    const onHide = () => cleanupConv(true);
    window.addEventListener("pagehide", onHide);

    // Drag by header.
    $(".head").addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      const sx = e.clientX - panel.offsetLeft, sy = e.clientY - panel.offsetTop;
      const move = (ev) => {
        panel.style.left = Math.max(0, Math.min(window.innerWidth - 60, ev.clientX - sx)) + "px";
        panel.style.top = Math.max(0, Math.min(window.innerHeight - 30, ev.clientY - sy)) + "px";
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }
})();
