// Rezepte – speichert Rezepte aus Social-Media-Beiträgen und lässt sie von Claude auslesen.
const SDK_URL = "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.3.0/+esm";

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- Einstellungen (localStorage, alles in try/catch) ----------
const settings = {
  get(k, d = "") { try { return localStorage.getItem("rz_" + k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("rz_" + k, v); } catch {} },
};

// ---------- IndexedDB ----------
const db = (() => {
  let p;
  const open = () => (p ??= new Promise((res, rej) => {
    const r = indexedDB.open("rezepte", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("recipes", { keyPath: "id" });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction("recipes", mode);
      const out = fn(t.objectStore("recipes"));
      t.oncomplete = () => res(out?.result ?? out);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    all: () => tx("readonly", (s) => s.getAll()),
    get: (id) => tx("readonly", (s) => s.get(id)),
    put: (r) => tx("readwrite", (s) => s.put(r)),
    del: (id) => tx("readwrite", (s) => s.delete(id)),
  };
})();

// ---------- Bilder ----------
async function resizeImage(file, maxSide, quality = 0.82) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d").drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", quality));
  return blob;
}
const blobToBase64 = (blob) => new Promise((res) => {
  const fr = new FileReader();
  fr.onload = () => res(String(fr.result).split(",")[1]);
  fr.readAsDataURL(blob);
});
const blobToDataUrl = (blob) => new Promise((res) => {
  const fr = new FileReader();
  fr.onload = () => res(fr.result);
  fr.readAsDataURL(blob);
});
const dataUrlToBlob = async (u) => (await fetch(u)).blob();

const objectUrls = new Set();
function imgUrl(blob) {
  const u = URL.createObjectURL(blob);
  objectUrls.add(u);
  return u;
}
function releaseUrls() { objectUrls.forEach((u) => URL.revokeObjectURL(u)); objectUrls.clear(); }

// ---------- Routing ----------
const views = {
  "": ["view-list", "Meine Rezepte"],
  "#neu": ["view-new", "Neues Rezept"],
  "#einstellungen": ["view-settings", "Einstellungen"],
  "#einrichtung": ["view-setup", "Teilen einrichten"],
};

function route() {
  const h = location.hash;
  document.querySelectorAll(".view").forEach((v) => (v.hidden = true));
  let viewId, title;
  if (h.startsWith("#rezept/")) {
    viewId = "view-detail"; title = "";
    renderDetail(decodeURIComponent(h.slice(8)));
  } else {
    [viewId, title] = views[h] ?? views[""];
    if (viewId === "view-list") renderList();
    if (viewId === "view-new") updateKeyHint();
    if (viewId === "view-settings") loadSettingsForm();
  }
  $("#" + viewId).hidden = false;
  if (title !== "") $("#pageTitle").textContent = title;
  $("#backBtn").hidden = viewId === "view-list";
  $("#settingsBtn").hidden = viewId === "view-settings";
  window.scrollTo(0, 0);
}
const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };

// ---------- Liste ----------
async function renderList() {
  releaseUrls();
  const q = $("#search").value.trim().toLowerCase();
  const all = (await db.all()).sort((a, b) => b.createdAt - a.createdAt);
  const list = all.filter((r) => !q || JSON.stringify([r.data.title, r.data.tags, r.data.ingredients?.map((i) => i.name)]).toLowerCase().includes(q));
  $("#emptyState").hidden = all.length > 0;
  $("#search").hidden = all.length === 0;
  $("#recipeList").innerHTML = list.map((r) => {
    const n = r.data.nutrition_per_serving || {};
    return `<a class="tile" href="#rezept/${encodeURIComponent(r.id)}">
      ${r.image ? `<img src="${imgUrl(r.image)}" alt="" loading="lazy">` : `<div class="noimg">🍽️</div>`}
      <div class="tile-body">
        <h3>${esc(r.data.title)}</h3>
        <div class="chips"><span>${Math.round(n.kcal || 0)} kcal</span><span class="prot">${Math.round(n.protein_g || 0)} g Eiweiß</span></div>
      </div></a>`;
  }).join("") || (all.length ? `<p class="hint center">Nichts gefunden.</p>` : "");
}

// ---------- Detail ----------
let detailMode = "serving";
async function renderDetail(id) {
  releaseUrls();
  const r = await db.get(id);
  if (!r) { $("#detail").innerHTML = `<p class="hint center">Rezept nicht gefunden.</p>`; return; }
  const d = r.data;
  $("#pageTitle").textContent = d.title;
  const n = detailMode === "serving" ? d.nutrition_per_serving : d.nutrition_total;
  const macro = (label, val, unit, cls = "") => `<div class="macro ${cls}"><b>${Math.round(val || 0)}</b><small>${unit}</small><span>${label}</span></div>`;
  const time = d.total_time_minutes > 0 ? `⏱ ${d.total_time_minutes} Min.` : "";
  const servings = d.servings > 0 ? `🍽 ${d.servings} ${d.servings === 1 ? "Portion" : "Portionen"}` : "";
  let host = "";
  try { host = r.sourceUrl ? new URL(r.sourceUrl).hostname.replace(/^www\./, "") : ""; } catch {}

  $("#detail").innerHTML = `
    ${r.image ? `<img class="hero" src="${imgUrl(r.image)}" alt="${esc(d.title)}">` : ""}
    <div class="detail-head">
      <h2>${esc(d.title)}</h2>
      ${d.description ? `<p>${esc(d.description)}</p>` : ""}
      <p class="meta">${[servings, time].filter(Boolean).join(" · ")}</p>
      ${r.sourceUrl ? `<a class="source" href="${esc(r.sourceUrl)}" target="_blank" rel="noopener">↗ Original ansehen${host ? ` (${esc(host)})` : ""}</a>` : ""}
    </div>

    <div class="card">
      <div class="seg">
        <button data-mode="serving" class="${detailMode === "serving" ? "on" : ""}">pro Portion</button>
        <button data-mode="total" class="${detailMode === "total" ? "on" : ""}">gesamt</button>
      </div>
      <div class="macros">
        ${macro("Kalorien", n?.kcal, "kcal")}
        ${macro("Eiweiß", n?.protein_g, "g", "prot")}
        ${macro("Kohlenh.", n?.carbs_g, "g")}
        ${macro("Fett", n?.fat_g, "g")}
      </div>
      <p class="hint center">${d.nutrition_estimated ? "≈ Geschätzt aus den Zutaten" : "Angaben aus dem Rezept"}</p>
    </div>

    <div class="card">
      <h3>Zutaten</h3>
      <ul class="ingredients">
        ${(d.ingredients || []).map((i, k) => `<li><label><input type="checkbox" data-ing="${k}"><span class="amt">${esc(i.amount)}</span> <span>${esc(i.name)}</span>${i.protein_g >= 1 ? `<em>${Math.round(i.protein_g)} g E</em>` : ""}</label></li>`).join("")}
      </ul>
    </div>

    ${(d.steps || []).length ? `<div class="card">
      <h3>Zubereitung</h3>
      <ol class="steps">${d.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
    </div>` : `<div class="card"><h3>Zubereitung</h3><p class="hint">Im Beitrag war keine Anleitung zu finden.</p></div>`}

    ${d.notes ? `<div class="card"><h3>Hinweise</h3><p>${esc(d.notes)}</p></div>` : ""}
    ${(d.tags || []).length ? `<div class="tags">${d.tags.map((t) => `<span>#${esc(t)}</span>`).join("")}</div>` : ""}

    <div class="row actions">
      <label class="btn secondary file-btn">🖼 Bild ändern<input type="file" id="changeImg" accept="image/*" hidden></label>
      <button class="btn danger" id="delBtn">🗑 Löschen</button>
    </div>`;

  $("#detail").querySelectorAll(".seg button").forEach((b) => b.onclick = () => { detailMode = b.dataset.mode; renderDetail(id); });
  $("#delBtn").onclick = async () => {
    if (!confirm(`„${d.title}“ wirklich löschen?`)) return;
    await db.del(id); toast("Rezept gelöscht"); go("");
  };
  $("#changeImg").onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    r.image = await resizeImage(f, 1200); await db.put(r); renderDetail(id);
  };
}

// ---------- Neues Rezept ----------
let photos = []; // {blob, url}
let coverIndex = 0;

function renderThumbs() {
  $("#thumbs").innerHTML = photos.map((p, i) => `
    <div class="thumb ${i === coverIndex ? "cover" : ""}" data-i="${i}">
      <img src="${p.url}" alt="">
      ${i === coverIndex ? `<span class="badge">Titelbild</span>` : ""}
      <button class="x" data-x="${i}" aria-label="Entfernen">×</button>
    </div>`).join("");
  if (photos.length > 1) $("#thumbs").insertAdjacentHTML("beforeend", `<p class="hint wide">Tippe ein Bild an, um es als Titelbild zu wählen.</p>`);
}
$("#thumbs").addEventListener("click", (e) => {
  const x = e.target.closest("[data-x]");
  if (x) {
    const i = +x.dataset.x;
    URL.revokeObjectURL(photos[i].url);
    photos.splice(i, 1);
    if (coverIndex >= photos.length) coverIndex = Math.max(0, photos.length - 1);
    return renderThumbs();
  }
  const t = e.target.closest("[data-i]");
  if (t) { coverIndex = +t.dataset.i; renderThumbs(); }
});
async function addPhotos(files) {
  for (const f of files) {
    if (!f.type.startsWith("image/")) continue;
    const blob = await resizeImage(f, 1568);
    photos.push({ blob, url: URL.createObjectURL(blob) });
  }
  renderThumbs();
}
$("#photoInput").onchange = async (e) => { await addPhotos([...e.target.files]); e.target.value = ""; };

$("#pasteBtn").onclick = async () => {
  try {
    if (navigator.clipboard?.read) {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const imgType = it.types.find((t) => t.startsWith("image/"));
        if (imgType) { const b = await it.getType(imgType); await addPhotos([new File([b], "clip", { type: imgType })]); continue; }
        if (it.types.includes("text/plain")) fillFromShared(await (await it.getType("text/plain")).text());
      }
    } else {
      fillFromShared(await navigator.clipboard.readText());
    }
  } catch { toast("Zwischenablage nicht lesbar – bitte manuell einfügen"); }
};

function fillFromShared(raw) {
  if (!raw) return;
  const m = raw.match(/https?:\/\/[^\s]+/);
  if (m && !$("#srcUrl").value) $("#srcUrl").value = m[0];
  const rest = raw.replace(m?.[0] ?? "", "").trim();
  if (rest) $("#srcText").value = [$("#srcText").value, rest].filter(Boolean).join("\n\n");
}

function resetNewForm() {
  photos.forEach((p) => URL.revokeObjectURL(p.url));
  photos = []; coverIndex = 0;
  $("#srcUrl").value = ""; $("#srcText").value = "";
  $("#error").hidden = true;
  renderThumbs();
}

function updateKeyHint() { $("#keyHint").hidden = !!settings.get("apiKey"); }

// ---------- Claude ----------
const NUT = {
  type: "object", additionalProperties: false,
  required: ["kcal", "protein_g", "carbs_g", "fat_g"],
  properties: { kcal: { type: "number" }, protein_g: { type: "number" }, carbs_g: { type: "number" }, fat_g: { type: "number" } },
};
const RECIPE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["is_recipe", "title", "description", "servings", "total_time_minutes", "ingredients", "steps", "nutrition_total", "nutrition_per_serving", "nutrition_estimated", "notes", "tags", "cover_image_index"],
  properties: {
    is_recipe: { type: "boolean", description: "false, wenn im Material kein Rezept/Gericht erkennbar ist" },
    title: { type: "string" },
    description: { type: "string", description: "1–2 Sätze, wie das fertige Gericht aussieht/schmeckt" },
    servings: { type: "integer", description: "Anzahl Portionen; schätzen, wenn nicht angegeben" },
    total_time_minutes: { type: "integer", description: "0 wenn unbekannt" },
    ingredients: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["amount", "name", "kcal", "protein_g"],
        properties: {
          amount: { type: "string", description: "Menge mit Einheit, z. B. '200 g', '1 EL', '2'" },
          name: { type: "string" },
          kcal: { type: "number" },
          protein_g: { type: "number" },
        },
      },
    },
    steps: { type: "array", items: { type: "string" } },
    nutrition_total: NUT,
    nutrition_per_serving: NUT,
    nutrition_estimated: { type: "boolean", description: "true, wenn die Nährwerte von dir geschätzt und nicht aus der Quelle übernommen wurden" },
    notes: { type: "string", description: "Tipps, Varianten, oder was unsicher/fehlend war. Leer, wenn nichts." },
    tags: { type: "array", items: { type: "string" } },
    cover_image_index: { type: "integer", description: "Index des Bildes, das das fertige Gericht am besten zeigt; -1 wenn keins" },
  },
};

const SYSTEM_PROMPT = `Du extrahierst Kochrezepte aus Social-Media-Beiträgen (Instagram, Facebook, TikTok, YouTube, Blogs) für eine persönliche Rezeptsammlung.
Du bekommst einen Link, eventuell den Beschreibungstext und eventuell Screenshots aus dem Video oder der Beschreibung.

So gehst du vor:
- Nutze alle Quellen zusammen. Steht das Rezept in einem Screenshot (eingeblendeter Text, Beschreibung), lies es von dort ab.
- Wenn Werkzeuge zum Abrufen von Webseiten verfügbar sind und Text/Bilder nicht reichen: rufe den Link ab. Verweist der Beitrag auf einen Blog/eine Webseite mit dem vollständigen Rezept, nutze diese. Gibt die Seite nichts her (Login-Sperre), arbeite mit dem, was du hast.
- Übernimm Mengen und Schritte aus der Quelle. Ergänze nur, was eindeutig aus dem Video/Bild hervorgeht; erfinde keine Zutaten. Fehlende Mengen darfst du sinnvoll schätzen und markierst das mit "ca." in der Menge.
- Nährwerte: Wenn die Quelle Kalorien/Eiweiß nennt, übernimm sie (nutrition_estimated=false). Sonst berechne sie realistisch aus den Zutaten anhand üblicher Nährwerttabellen (nutrition_estimated=true). nutrition_total ist das ganze Rezept, nutrition_per_serving = total / servings. kcal und protein_g pro Zutat beziehen sich auf die angegebene Menge.
- Schritte: kurz, klar, nummerierbar, in der richtigen Reihenfolge. Keine Anleitung vorhanden und nicht ableitbar → leere Liste.
- Alles auf Deutsch, metrische Einheiten (Cups/oz umrechnen). Titel kurz und appetitlich, ohne Emojis und Hashtags.
- tags: 2–5 kurze Schlagwörter (z. B. "high protein", "vegetarisch", "Frühstück", "Meal Prep").
- Wenn gar kein Rezept erkennbar ist: is_recipe=false und in notes erklären, was fehlt.`;

let sdkPromise;
async function getClient() {
  sdkPromise ??= import(SDK_URL);
  const { default: Anthropic } = await sdkPromise;
  return new Anthropic({ apiKey: settings.get("apiKey"), dangerouslyAllowBrowser: true, maxRetries: 2, timeout: 5 * 60 * 1000 });
}

async function analyzeWithClaude({ url, text, images }) {
  const client = await getClient();
  const model = settings.get("model", "claude-opus-5-5");
  const useWeb = settings.get("useWeb", "1") === "1" && !!url;

  const content = [];
  images.forEach((b64, i) => {
    content.push({ type: "text", text: `Bild ${i}:` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } });
  });
  content.push({ type: "text", text: [
    url ? `Link zum Beitrag: ${url}` : "Kein Link vorhanden.",
    text ? `Beschreibungstext / geteilter Text:\n"""\n${text}\n"""` : "Kein Beschreibungstext vorhanden.",
    images.length ? `Es gibt ${images.length} Bild(er), Index 0 bis ${images.length - 1}.` : "Keine Bilder vorhanden (cover_image_index = -1).",
    "Extrahiere das Rezept.",
  ].join("\n\n") });

  const messages = [{ role: "user", content }];
  const params = {
    model,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    output_config: { effort: "medium", format: { type: "json_schema", schema: RECIPE_SCHEMA } },
    messages,
  };
  if (useWeb) params.tools = [
    { type: "web_fetch_20260209", name: "web_fetch", max_uses: 3 },
    { type: "web_search_20260209", name: "web_search", max_uses: 2 },
  ];
  // Server-seitiger Fallback bei Ablehnung durch Sicherheitsfilter (nicht für Haiku verfügbar)
  if (model !== "claude-haiku-5-5") { params.betas = ["server-side-fallback-2026-07-01"]; params.fallbacks = "default"; }

  let resp;
  for (let i = 0; i < 4; i++) {
    resp = await client.beta.messages.create(params);
    if (resp.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: resp.content });
    setProgress("Liest die Webseite weiter …");
  }
  if (resp.stop_reason === "refusal") throw new Error("Claude hat die Anfrage abgelehnt. Versuch es mit anderen Screenshots oder anderem Text.");
  if (resp.stop_reason === "max_tokens") throw new Error("Die Antwort war zu lang und wurde abgeschnitten. Bitte nochmal versuchen.");
  const textBlock = [...resp.content].reverse().find((b) => b.type === "text");
  if (!textBlock) throw new Error("Keine Antwort erhalten. Bitte nochmal versuchen.");
  return JSON.parse(textBlock.text);
}

function setProgress(t) { $("#progressText").textContent = t; }

function friendlyError(e) {
  const s = e?.status;
  if (s === 401) return "Der API-Key ist ungültig. Bitte in den Einstellungen prüfen.";
  if (s === 400 && /credit|balance/i.test(e.message)) return "Dein Anthropic-Guthaben ist aufgebraucht. Unter console.anthropic.com → Billing aufladen.";
  if (s === 429) return "Zu viele Anfragen gerade – bitte in einer Minute nochmal.";
  if (s >= 500) return "Claude ist gerade überlastet. Bitte gleich nochmal versuchen.";
  if (e instanceof SyntaxError) return "Die Antwort konnte nicht gelesen werden. Bitte nochmal versuchen.";
  if (/fetch|network|load failed/i.test(e?.message || "")) return "Keine Verbindung. Bist du online?";
  return e?.message || String(e);
}

$("#analyzeBtn").onclick = async () => {
  if (!settings.get("apiKey")) { toast("Bitte zuerst den API-Key eintragen"); return go("#einstellungen"); }
  const url = $("#srcUrl").value.trim();
  const text = $("#srcText").value.trim();
  if (!url && !text && !photos.length) return toast("Füge einen Link, Text oder Screenshot hinzu");

  $("#analyzeBtn").disabled = true;
  $("#error").hidden = true;
  $("#progress").hidden = false;
  setProgress(photos.length ? "Schaut sich die Bilder an …" : "Liest das Rezept …");
  const slow = setTimeout(() => setProgress("Rechnet Kalorien und Eiweiß aus …"), 15000);
  try {
    const images = await Promise.all(photos.map((p) => blobToBase64(p.blob)));
    const data = await analyzeWithClaude({ url, text, images });
    if (!data.is_recipe && !(data.ingredients || []).length) throw new Error(data.notes || "In dem Beitrag wurde kein Rezept gefunden. Füge einen Screenshot der Zutaten oder den Beschreibungstext hinzu.");
    let ci = photos.length ? coverIndex : -1;
    // Hat der Nutzer kein Titelbild gewählt (Standard 0), nimm Claudes Vorschlag
    if (coverIndex === 0 && data.cover_image_index >= 0 && data.cover_image_index < photos.length) ci = data.cover_image_index;
    const recipe = {
      id: crypto.randomUUID?.() ?? String(Date.now()),
      createdAt: Date.now(),
      sourceUrl: url, sourceText: text,
      image: ci >= 0 ? await resizeImage(photos[ci].blob, 1200) : null,
      data,
    };
    await db.put(recipe);
    resetNewForm();
    toast("Rezept gespeichert ✓");
    go("#rezept/" + encodeURIComponent(recipe.id));
  } catch (e) {
    console.error(e);
    $("#error").textContent = friendlyError(e);
    $("#error").hidden = false;
  } finally {
    clearTimeout(slow);
    $("#analyzeBtn").disabled = false;
    $("#progress").hidden = true;
  }
};

// ---------- Einstellungen ----------
function loadSettingsForm() {
  $("#apiKey").value = settings.get("apiKey");
  $("#model").value = settings.get("model", "claude-opus-5-5");
  $("#useWeb").checked = settings.get("useWeb", "1") === "1";
  $("#settingsMsg").textContent = "";
  showStorageStatus();
}
$("#saveSettings").onclick = () => {
  settings.set("apiKey", $("#apiKey").value.trim());
  settings.set("model", $("#model").value);
  settings.set("useWeb", $("#useWeb").checked ? "1" : "0");
  $("#settingsMsg").textContent = "Gespeichert ✓";
  toast("Einstellungen gespeichert");
};

async function showStorageStatus() {
  try {
    let persisted = await navigator.storage?.persisted?.();
    if (!persisted) persisted = await navigator.storage?.persist?.();
    const n = (await db.all()).length;
    $("#storageMsg").textContent = `${n} Rezept${n === 1 ? "" : "e"} gespeichert.` + (persisted ? " Speicher ist dauerhaft geschützt." : "");
  } catch {}
}

$("#exportBtn").onclick = async () => {
  const all = await db.all();
  const out = await Promise.all(all.map(async (r) => ({ ...r, image: r.image ? await blobToDataUrl(r.image) : null })));
  const blob = new Blob([JSON.stringify({ app: "rezepte", version: 1, recipes: out })], { type: "application/json" });
  const name = `rezepte-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([blob], name, { type: "application/json" });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: "Rezepte-Sicherung" }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};
$("#importInput").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  try {
    const json = JSON.parse(await f.text());
    let n = 0;
    for (const r of json.recipes || []) {
      if (!r.id || !r.data) continue;
      await db.put({ ...r, image: r.image ? await dataUrlToBlob(r.image) : null });
      n++;
    }
    toast(`${n} Rezept${n === 1 ? "" : "e"} importiert`);
    showStorageStatus();
  } catch { toast("Datei konnte nicht gelesen werden"); }
};

// ---------- Toast ----------
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

// ---------- Geteilte Inhalte (Kurzbefehl ?share=… oder Android Share-Target) ----------
function handleIncomingShare() {
  const p = new URLSearchParams(location.search);
  const parts = ["share", "url", "text", "title"].map((k) => p.get(k)).filter(Boolean);
  if (!parts.length) return false;
  resetNewForm();
  fillFromShared(parts.join("\n"));
  history.replaceState(null, "", location.pathname + "#neu");
  return true;
}

// ---------- Start ----------
$("#backBtn").onclick = () => (history.length > 1 && location.hash ? history.back() : go(""));
$("#settingsBtn").onclick = () => go("#einstellungen");
$("#addBtn").onclick = () => { resetNewForm(); go("#neu"); };
$("#search").oninput = renderList;
document.addEventListener("click", (e) => { const g = e.target.closest("[data-go]"); if (g) go(g.dataset.go); });
$("#shortcutUrl").textContent = location.origin + location.pathname + "?share=";
$("#shortcutUrl").onclick = async () => { try { await navigator.clipboard.writeText($("#shortcutUrl").textContent); toast("Adresse kopiert"); } catch {} };

window.addEventListener("hashchange", route);
handleIncomingShare();
route();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
