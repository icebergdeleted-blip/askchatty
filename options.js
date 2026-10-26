const DEFAULTS = { engine: "auto", apiKey: "", apiModel: "claude-sonnet-5-5", webModel: "" };
const $ = (id) => document.getElementById(id);

chrome.storage.local.get(DEFAULTS).then((s) => {
  for (const k of Object.keys(DEFAULTS)) $(k).value = s[k];
});

$("save").onclick = async () => {
  const s = {};
  for (const k of Object.keys(DEFAULTS)) s[k] = $(k).value.trim() || DEFAULTS[k];
  await chrome.storage.local.set(s);
  $("saved").textContent = "Saved ✓";
  setTimeout(() => ($("saved").textContent = ""), 1500);
};

function toMarkdown(e) {
  let md = `# ${e.turns[0]?.q || "SideChat"}\n\n_From: ${e.pageTitle} · ${e.pageUrl}_\n\n`;
  if (e.quote) md += "> " + e.quote.replace(/\n/g, "\n> ") + "\n\n";
  for (const t of e.turns) md += `**You:** ${t.q}\n\n${t.a}\n\n---\n\n`;
  return md;
}

async function render() {
  const { history = [] } = await chrome.storage.local.get("history");
  const term = $("search").value.toLowerCase();
  const list = $("history");
  list.textContent = "";
  const shown = history.filter((e) => !term || JSON.stringify(e).toLowerCase().includes(term));
  if (!shown.length) {
    list.textContent = history.length ? "No matches." : "No chats yet.";
    return;
  }
  for (const e of shown) {
    const d = document.createElement("details");
    d.className = "item";
    const s = document.createElement("summary");
    const b = document.createElement("b");
    b.textContent = e.turns[0]?.q || "(empty)";
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = `${e.turns.length} turn${e.turns.length === 1 ? "" : "s"} · ${new Date(e.createdAt).toLocaleString()}`;
    s.append(b, meta);
    const t = document.createElement("div");
    t.className = "turns";
    const src = document.createElement("p");
    const a = document.createElement("a");
    a.href = e.pageUrl;
    a.target = "_blank";
    a.textContent = e.pageTitle || e.pageUrl;
    src.append("From: ", a);
    t.appendChild(src);
    if (e.quote) {
      const q = document.createElement("div");
      q.className = "quote";
      q.textContent = e.quote;
      t.appendChild(q);
    }
    for (const turn of e.turns) {
      const q = document.createElement("p");
      q.className = "q";
      q.textContent = turn.q;
      const ans = document.createElement("pre");
      ans.textContent = turn.a;
      t.append(q, ans);
    }
    const row = document.createElement("div");
    row.className = "row";
    const copy = document.createElement("button");
    copy.textContent = "Copy as Markdown";
    copy.onclick = () => navigator.clipboard.writeText(toMarkdown(e));
    const del = document.createElement("button");
    del.textContent = "Delete";
    del.onclick = async () => {
      const { history = [] } = await chrome.storage.local.get("history");
      await chrome.storage.local.set({ history: history.filter((h) => h.id !== e.id) });
      render();
    };
    row.append(copy, del);
    t.appendChild(row);
    d.append(s, t);
    list.appendChild(d);
  }
}

$("search").oninput = render;
$("clear").onclick = async () => {
  if (!confirm("Delete all SideChat history?")) return;
  await chrome.storage.local.set({ history: [] });
  render();
};
chrome.storage.onChanged.addListener((c) => c.history && render());
render();
