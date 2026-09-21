// Mini App logic. Zero dependencies, ES modules, no build step.
//
// The questionnaires come from ./instruments.mjs, a copy of the bot's own
// definitions kept identical by telegram-bot/webapp/build.mjs and enforced by a
// test, so the wording and the bands can never drift between chat and app.
//
// Completed runs leave here twice: to the bot through sendData, which is the
// source of truth and drives the weekly reminder, and to Telegram CloudStorage,
// which is what the statistics and history screens read. CloudStorage is
// readable without any backend, which is the only reason this app needs nothing
// but static hosting.

import { INSTRUMENTS, INSTRUMENT_LIST, buildResult, severityOf } from "./instruments.mjs";

// One accent for every chart. Each scale gets its own plot with its own title
// and its own axis, so colour is decoration here, not identity: four hues
// would fail the colour-blind separation floors for no gain.
const SERIES = "var(--series)";
const MAX_NOTE_LENGTH = 1000;
const RESULT_PREFIX = "r_";
const SETTINGS_KEY = "s_settings";
const PAYLOAD_VERSION = 1;

const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
const $ = (id) => document.getElementById(id);

// The bot puts ?pro=1 or ?pro=0 in the launch URL. It is only a hint for what
// to show: the bot itself refuses to store a locked result, so editing this
// changes nothing but the labels.
const UNLOCKED = new URLSearchParams(window.location.search).get("pro") !== "0";

// ----------------------------------------------------------------- platform

function ready() {
  if (!tg) return;
  tg.ready();
  tg.expand();
  applyTheme();
  tg.onEvent("themeChanged", applyTheme);
  if (tg.BackButton) tg.BackButton.onClick(() => show(state.screen === "home" ? "home" : "home"));
}

function applyTheme() {
  const scheme = tg && tg.colorScheme === "dark" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", scheme);
}

function haptic(kind) {
  try {
    if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred(kind || "light");
  } catch (error) { /* older clients */ }
}

// sendData closes the Mini App, so every call to it is a terminal action.
function submit(payload) {
  const body = JSON.stringify(Object.assign({ v: PAYLOAD_VERSION }, payload));
  if (tg && typeof tg.sendData === "function") {
    tg.sendData(body);
    return true;
  }
  // Opened outside Telegram, or from a launch type that cannot send data.
  window.alert("Це вікно відкрите не з кнопки в чаті, тому дані не можуть піти боту.\n\n" + body);
  return false;
}

// ----------------------------------------------------------------- storage

// CloudStorage is per user per bot and survives reinstalls. localStorage is the
// fallback for a plain browser and for clients older than Bot API 6.9. Both can
// fail or come back empty, so every screen renders correctly with no data.
const cloud = tg && tg.CloudStorage && typeof tg.CloudStorage.getKeys === "function" ? tg.CloudStorage : null;

function localGet(key) {
  try {
    return window.localStorage.getItem("tgapp_" + key);
  } catch (error) {
    return null;
  }
}

function localSet(key, value) {
  try {
    window.localStorage.setItem("tgapp_" + key, value);
  } catch (error) { /* private mode, blocked storage */ }
}

function localKeys() {
  try {
    return Object.keys(window.localStorage)
      .filter((key) => key.indexOf("tgapp_") === 0)
      .map((key) => key.slice(6));
  } catch (error) {
    return [];
  }
}

function storageKeys() {
  if (!cloud) return Promise.resolve(localKeys());
  return new Promise((resolve) => {
    cloud.getKeys((error, keys) => resolve(error || !keys ? localKeys() : keys));
  });
}

function storageGetMany(keys) {
  if (!keys.length) return Promise.resolve({});
  if (!cloud) {
    const values = {};
    keys.forEach((key) => { values[key] = localGet(key); });
    return Promise.resolve(values);
  }
  return new Promise((resolve) => {
    cloud.getItems(keys, (error, values) => resolve(error || !values ? {} : values));
  });
}

function storageSet(key, value) {
  localSet(key, value);
  if (!cloud) return Promise.resolve(true);
  return new Promise((resolve) => {
    cloud.setItem(key, value, (error, stored) => resolve(!error && stored !== false));
  });
}

function storageRemoveAll(keys) {
  keys.forEach((key) => {
    try {
      window.localStorage.removeItem("tgapp_" + key);
    } catch (error) { /* ignore */ }
  });
  if (!cloud || !keys.length) return Promise.resolve(true);
  return new Promise((resolve) => {
    cloud.removeItems(keys, () => resolve(true));
  });
}

// A stored result is bounded to one CloudStorage value (4096 characters), and
// anything unreadable is skipped rather than rendered.
function decodeResult(raw) {
  if (typeof raw !== "string" || !raw) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const instrument = INSTRUMENTS[parsed.instrument];
  if (!instrument || !Number.isFinite(parsed.score)) return null;
  const at = Date.parse(parsed.completedAt);
  if (!Number.isFinite(at)) return null;
  return {
    instrument: parsed.instrument,
    score: parsed.score,
    maxScore: Number.isFinite(parsed.maxScore) ? parsed.maxScore : instrument.maxScore,
    severity: typeof parsed.severity === "string" ? parsed.severity : severityOf(instrument, parsed.score),
    note: typeof parsed.note === "string" && parsed.note.trim() ? parsed.note.trim().slice(0, MAX_NOTE_LENGTH) : null,
    completedAt: parsed.completedAt,
    at,
  };
}

async function loadResults() {
  const keys = (await storageKeys()).filter((key) => key.indexOf(RESULT_PREFIX) === 0);
  const values = await storageGetMany(keys);
  return Object.keys(values)
    .map((key) => decodeResult(values[key]))
    .filter(Boolean)
    .sort((left, right) => left.at - right.at);
}

async function loadSettings() {
  const values = await storageGetMany([SETTINGS_KEY]);
  try {
    const parsed = JSON.parse(values[SETTINGS_KEY] || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    return {};
  }
}

function saveResultLocally(result) {
  const record = {
    instrument: result.instrument,
    score: result.score,
    maxScore: result.maxScore,
    severity: result.severity,
    note: result.note || null,
    completedAt: result.completedAt,
  };
  return storageSet(RESULT_PREFIX + Date.parse(result.completedAt), JSON.stringify(record));
}

// ----------------------------------------------------------------- state

const state = {
  screen: "home", instrument: null, answers: [], index: 0, note: "", result: null, results: [],
  unlocked: UNLOCKED,
};

function show(name) {
  state.screen = name;
  Array.prototype.forEach.call(document.querySelectorAll(".screen"), (node) => {
    node.classList.toggle("active", node.id === name);
  });
  window.scrollTo(0, 0);
  if (tg && tg.BackButton) {
    if (name === "home") tg.BackButton.hide();
    else tg.BackButton.show();
  }
}

// ----------------------------------------------------------------- home

const SCALE_ICON = '<svg class="glyph scale" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="8"/></svg>';

function minutesFor(instrument) {
  const count = instrument.items.length;
  if (count <= 7) return "близько хвилини";
  if (count <= 10) return "близько двох хвилин";
  return "кілька хвилин";
}

function renderHome() {
  const menu = $("home-menu");
  Array.prototype.slice.call(menu.querySelectorAll("[data-instrument]")).forEach((node) => node.remove());
  // Built back to front and inserted at the top, so the scales stay above the
  // fixed cards in the order instruments.mjs declares them.
  INSTRUMENT_LIST.slice().reverse().forEach((instrument) => {
    const locked = Boolean(instrument.paid) && !state.unlocked;
    const button = document.createElement("button");
    button.className = "menu-item" + (locked ? " locked" : "");
    button.type = "button";
    button.setAttribute("data-instrument", instrument.id);
    button.innerHTML = SCALE_ICON;
    const body = document.createElement("span");
    body.className = "body";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = instrument.title + " · " + instrument.subtitle;
    const hint = document.createElement("span");
    hint.className = "hint";
    hint.textContent = instrument.items.length + " питань, " + minutesFor(instrument);
    body.appendChild(title);
    body.appendChild(hint);
    const tail = document.createElement("span");
    tail.className = locked ? "lock" : "chev";
    tail.textContent = locked ? "🔒" : "›";
    button.appendChild(body);
    button.appendChild(tail);
    button.addEventListener("click", () => {
      if (locked) {
        window.alert("Ця шкала входить у повний доступ. Відкрийте його в чаті командою /buy.");
        return;
      }
      startQuiz(instrument.id);
    });
    menu.insertBefore(button, menu.firstElementChild);
  });
}

// ----------------------------------------------------------------- quiz

function startQuiz(instrumentId) {
  state.instrument = INSTRUMENTS[instrumentId];
  state.answers = [];
  state.index = 0;
  state.note = "";
  state.result = null;
  $("note-text").value = "";
  $("note-count").textContent = "0";
  renderQuestion();
  show("quiz");
}

function renderQuestion() {
  const instrument = state.instrument;
  const item = instrument.items[state.index];
  const total = instrument.items.length;
  $("quiz-step").textContent = instrument.title + " · питання " + (state.index + 1) + " з " + total;
  $("quiz-bar").style.width = Math.round((state.index / total) * 100) + "%";
  $("quiz-prompt").textContent = item.scored ? instrument.prompt : "";
  $("quiz-question").textContent = item.text;
  $("quiz-prev").hidden = state.index === 0;

  const box = $("quiz-options");
  box.textContent = "";
  item.options.forEach((option) => {
    const button = document.createElement("button");
    button.className = "option";
    button.type = "button";
    const num = document.createElement("span");
    num.className = "num";
    num.textContent = String(option.value);
    const label = document.createElement("span");
    label.textContent = option.label;
    button.appendChild(num);
    button.appendChild(label);
    button.addEventListener("click", () => answer(option.value));
    box.appendChild(button);
  });
}

function answer(value) {
  haptic("light");
  state.answers[state.index] = value;
  state.index += 1;
  if (state.index < state.instrument.items.length) {
    renderQuestion();
    return;
  }
  show("note");
  $("note-text").focus();
}

async function finish() {
  const instrument = state.instrument;
  const result = buildResult(instrument, state.answers, Date.now());
  if (state.note) result.note = state.note;
  state.result = result;

  const previous = state.results.filter((entry) => entry.instrument === instrument.id).pop();
  $("result-title").textContent = instrument.title + " готовий";
  $("result-score").textContent = String(result.score);
  $("result-max").textContent = " / " + instrument.maxScore;
  $("result-band").textContent = "Оцінка: " + result.severity;
  const delta = previous ? result.score - previous.score : null;
  $("result-delta").textContent = previous
    ? "Минулого разу " + previous.score + ", " + (delta === 0 ? "без змін" : (delta > 0 ? "+" : "") + delta)
    : "Перше проходження, порівнювати поки ні з чим.";
  $("result-cutoff").textContent = result.aboveCutoff
    ? "Бал вище порогу " + instrument.cutoff + ". Це підстава обговорити стан із лікарем або психотерапевтом."
    : "Бал нижче порогу " + instrument.cutoff + ". Продовжуйте спостерігати за динамікою.";

  const crisis = $("result-crisis");
  crisis.hidden = !result.risk;
  if (result.risk) {
    crisis.textContent = "";
    const head = document.createElement("b");
    head.textContent = "Важливо. ";
    crisis.appendChild(head);
    crisis.appendChild(document.createTextNode(
      "Ви позначили думки про смерть або про те, щоб завдати собі шкоди. Не залишайтеся з цим наодинці. " +
      "Екстрена допомога 103 або 112. LifeLine Ukraine 7333, безкоштовно і круглодобово. "));
    const link = document.createElement("a");
    link.href = "https://howareu.com";
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "howareu.com";
    crisis.appendChild(link);
  }

  await saveResultLocally(result);
  state.results = await loadResults();
  show("result");
}

// ----------------------------------------------------------------- charts

// One chart per instrument: GAD-7 tops out at 21 and PHQ-9 at 27, so a shared
// axis would misrepresent both. Small multiples keep one scale per plot.
function renderChart(container, instrument, entries) {
  container.textContent = "";
  const figure = document.createElement("figure");
  const caption = document.createElement("figcaption");
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = instrument.title;
  const scale = document.createElement("span");
  scale.className = "scale";
  scale.textContent = "0 до " + instrument.maxScore + " · " + instrument.subtitle;
  caption.appendChild(name);
  caption.appendChild(scale);
  figure.appendChild(caption);

  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Ще немає проходжень";
    figure.appendChild(empty);
    container.appendChild(figure);
    return;
  }

  const wrap = document.createElement("div");
  wrap.className = "chart-wrap";
  const width = 320;
  const height = 150;
  const pad = { top: 12, right: 30, bottom: 22, left: 26 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const color = SERIES;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 " + width + " " + height);
  svg.setAttribute("class", "chart");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", instrument.title + ": " + entries.length + " проходжень, останній бал " +
    entries[entries.length - 1].score + " з " + instrument.maxScore);

  const make = (tag, attrs) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.keys(attrs).forEach((key) => node.setAttribute(key, attrs[key]));
    return node;
  };
  const x = (index) => entries.length === 1
    ? pad.left + plotW / 2
    : pad.left + (index / (entries.length - 1)) * plotW;
  const y = (value) => pad.top + plotH - (value / instrument.maxScore) * plotH;

  // Hairline grid, one shade off the surface. The middle tick is a whole number
  // so the label and the line it names sit at the same value.
  [0, Math.round(instrument.maxScore / 2), instrument.maxScore].forEach((value) => {
    svg.appendChild(make("line", {
      class: "grid-line", x1: pad.left, x2: pad.left + plotW, y1: y(value), y2: y(value),
    }));
    svg.appendChild(make("text", {
      class: "axis-text", x: pad.left - 6, y: y(value) + 3, "text-anchor": "end",
    })).textContent = String(value);
  });
  // A dashed rule for the threshold the instrument actually defines, labelled
  // at the left edge: the right edge belongs to the endpoint value.
  svg.appendChild(make("line", {
    class: "cut-line", x1: pad.left, x2: pad.left + plotW, y1: y(instrument.cutoff), y2: y(instrument.cutoff),
  }));
  svg.appendChild(make("text", {
    class: "cut-text", x: pad.left + 2, y: y(instrument.cutoff) - 4, "text-anchor": "start",
  })).textContent = "поріг " + instrument.cutoff;

  if (entries.length > 1) {
    svg.appendChild(make("path", {
      class: "series-line",
      stroke: color,
      d: entries.map((entry, index) => (index ? "L" : "M") + x(index) + " " + y(entry.score)).join(" "),
    }));
  }

  const crosshair = make("line", { class: "crosshair", y1: pad.top, y2: pad.top + plotH, x1: 0, x2: 0 });
  svg.appendChild(crosshair);

  entries.forEach((entry, index) => {
    svg.appendChild(make("circle", { class: "marker", cx: x(index), cy: y(entry.score), r: 4.5, fill: color }));
  });

  // Only the endpoint is labelled; the axis and the tooltip carry the rest.
  const last = entries[entries.length - 1];
  svg.appendChild(make("text", {
    class: "end-label", x: Math.min(x(entries.length - 1) + 6, width - 2), y: y(last.score) - 8,
    "text-anchor": entries.length === 1 ? "middle" : "end",
  })).textContent = String(last.score);

  // First and last dates only, so the axis never collides with itself.
  const dateOf = (entry) => new Date(entry.at).toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit" });
  svg.appendChild(make("text", {
    class: "axis-text", x: pad.left, y: height - 6, "text-anchor": "start",
  })).textContent = dateOf(entries[0]);
  if (entries.length > 1) {
    svg.appendChild(make("text", {
      class: "axis-text", x: pad.left + plotW, y: height - 6, "text-anchor": "end",
    })).textContent = dateOf(last);
  }

  const tip = document.createElement("div");
  tip.className = "tip";
  wrap.appendChild(tip);

  // A hit area wider than the markers, with a nearest-point lookup, so a 9px
  // dot does not need a pinpoint tap.
  const hit = make("rect", {
    class: "hit", x: pad.left - 10, y: pad.top - 8, width: plotW + 20, height: plotH + 16,
  });
  const locate = (event) => {
    const box = svg.getBoundingClientRect();
    const point = event.touches && event.touches[0] ? event.touches[0] : event;
    const svgX = ((point.clientX - box.left) / box.width) * width;
    let nearest = 0;
    entries.forEach((entry, index) => {
      if (Math.abs(x(index) - svgX) < Math.abs(x(nearest) - svgX)) nearest = index;
    });
    const entry = entries[nearest];
    crosshair.setAttribute("x1", x(nearest));
    crosshair.setAttribute("x2", x(nearest));
    crosshair.style.opacity = "1";
    tip.textContent = new Date(entry.at).toLocaleDateString("uk-UA") + " · " + entry.score + "/" +
      instrument.maxScore + " · " + entry.severity;
    tip.style.left = ((x(nearest) / width) * 100) + "%";
    tip.style.top = ((y(entry.score) / height) * 100) + "%";
    tip.style.opacity = "1";
  };
  const clear = () => {
    crosshair.style.opacity = "0";
    tip.style.opacity = "0";
  };
  hit.addEventListener("mousemove", locate);
  hit.addEventListener("mouseleave", clear);
  hit.addEventListener("touchstart", locate, { passive: true });
  hit.addEventListener("touchmove", locate, { passive: true });
  hit.addEventListener("touchend", clear);
  svg.appendChild(hit);

  wrap.appendChild(svg);
  figure.appendChild(wrap);
  container.appendChild(figure);
}

function renderTiles(container, results) {
  container.textContent = "";
  INSTRUMENT_LIST.forEach((instrument) => {
    const entries = results.filter((entry) => entry.instrument === instrument.id);
    const last = entries[entries.length - 1];
    const previous = entries[entries.length - 2];
    const tile = document.createElement("div");
    tile.className = "tile";
    const label = document.createElement("div");
    label.className = "tile-label";
    // The title is the identity, not a colour chip.
    label.appendChild(document.createTextNode(instrument.title));
    const value = document.createElement("div");
    value.className = "tile-value";
    value.textContent = last ? String(last.score) : "нема";
    const sub = document.createElement("div");
    sub.className = "tile-sub";
    if (!last) sub.textContent = "ще не проходили";
    else if (!previous) sub.textContent = last.severity;
    else {
      const delta = last.score - previous.score;
      sub.textContent = (delta === 0 ? "без змін" : (delta > 0 ? "+" : "") + delta) + " · " + last.severity;
    }
    tile.appendChild(label);
    tile.appendChild(value);
    tile.appendChild(sub);
    container.appendChild(tile);
  });
}

async function renderStats() {
  state.results = await loadResults();
  renderTiles($("stats-tiles"), state.results);
  const locked = $("stats-locked");
  locked.hidden = state.unlocked;
  if (!state.unlocked) {
    locked.textContent = "Повна статистика і шкали сну та стресу входять у повний доступ. " +
      "Відкрийте його в чаті командою /buy.";
  }
  const charts = $("stats-charts");
  charts.textContent = "";
  INSTRUMENT_LIST.forEach((instrument) => {
    if (instrument.paid && !state.unlocked) return;
    const card = document.createElement("div");
    card.className = "card";
    charts.appendChild(card);
    renderChart(card, instrument, state.results.filter((entry) => entry.instrument === instrument.id));
  });
}

async function renderHistory() {
  state.results = await loadResults();
  const body = $("history-body");
  body.textContent = "";
  if (!state.results.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Ще немає проходжень. Почніть з GAD-7 або PHQ-9.";
    body.appendChild(empty);
    return;
  }
  const table = document.createElement("table");
  const head = document.createElement("tr");
  ["Дата", "Тест", "Бал"].forEach((title) => {
    const cell = document.createElement("th");
    cell.textContent = title;
    head.appendChild(cell);
  });
  table.appendChild(head);
  state.results.slice().reverse().forEach((entry) => {
    const instrument = INSTRUMENTS[entry.instrument];
    const row = document.createElement("tr");
    const date = document.createElement("td");
    date.textContent = new Date(entry.at).toLocaleDateString("uk-UA");
    if (entry.note) {
      const note = document.createElement("span");
      note.className = "note";
      note.textContent = entry.note;
      date.appendChild(note);
    }
    const name = document.createElement("td");
    name.textContent = instrument.title;
    const score = document.createElement("td");
    score.className = "num";
    score.textContent = entry.score + "/" + entry.maxScore;
    row.appendChild(date);
    row.appendChild(name);
    row.appendChild(score);
    table.appendChild(row);
  });
  body.appendChild(table);
}

// ----------------------------------------------------------------- settings and data

function fillTimezones(selected) {
  const box = $("rem-tz");
  box.textContent = "";
  // Default: let the bot resolve Kyiv time per instant, so the send hour
  // survives the March and October transitions without anyone touching this.
  const auto = document.createElement("option");
  auto.value = "auto";
  auto.textContent = "Автоматично (Київ, з переходом на літній час)";
  if (selected === "auto" || selected === null || selected === undefined) auto.selected = true;
  box.appendChild(auto);
  for (let offset = -12 * 60; offset <= 14 * 60; offset += 30) {
    const option = document.createElement("option");
    const sign = offset < 0 ? "-" : "+";
    const absolute = Math.abs(offset);
    const pad = (value) => String(value).padStart(2, "0");
    option.value = String(offset);
    option.textContent = "UTC" + sign + pad(Math.floor(absolute / 60)) + ":" + pad(absolute % 60) +
      (offset === 120 ? " (Київ, зима)" : offset === 180 ? " (Київ, літо)" : "");
    if (offset === selected) option.selected = true;
    box.appendChild(option);
  }
}

async function renderReminders() {
  const settings = await loadSettings();
  $("rem-on").checked = settings.enabled !== false;
  $("rem-time").value = typeof settings.time === "string" ? settings.time : "19:00";
  fillTimezones(Number.isInteger(settings.tz) ? settings.tz : "auto");
}

async function renderData() {
  state.results = await loadResults();
  $("data-count").textContent = String(state.results.length);
  $("data-import-msg").textContent = "";
}

function exportFile() {
  const body = JSON.stringify({ exportedAt: new Date().toISOString(), results: state.results }, null, 2);
  const blob = new Blob([body], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "gad7-phq9.json";
  link.click();
  URL.revokeObjectURL(link.href);
}

// Accepts what /export prints in the chat, so runs done in the chat can appear
// in the app's own statistics.
async function importFromChat() {
  const message = $("data-import-msg");
  let parsed = null;
  try {
    parsed = JSON.parse($("data-import").value);
  } catch (error) {
    message.textContent = "Це не схоже на JSON. Скопіюйте весь блок з /export.";
    return;
  }
  const rows = parsed && Array.isArray(parsed.results) ? parsed.results : null;
  if (!rows) {
    message.textContent = "У вставленому тексті немає списку results.";
    return;
  }
  const known = new Set(state.results.map((entry) => entry.completedAt));
  let added = 0;
  for (const row of rows) {
    const entry = decodeResult(JSON.stringify(row));
    if (!entry || known.has(entry.completedAt)) continue;
    await saveResultLocally(entry);
    known.add(entry.completedAt);
    added += 1;
  }
  state.results = await loadResults();
  message.textContent = added
    ? "Додано проходжень: " + added + ". Загалом: " + state.results.length + "."
    : "Нових проходжень не знайдено.";
  $("data-count").textContent = String(state.results.length);
}

// ----------------------------------------------------------------- wiring

Array.prototype.forEach.call(document.querySelectorAll("[data-go]"), (node) => {
  node.addEventListener("click", () => {
    const target = node.getAttribute("data-go");
    if (target === "stats") renderStats();
    if (target === "history") renderHistory();
    if (target === "reminders") renderReminders();
    if (target === "data") renderData();
    show(target);
  });
});

$("quiz-prev").addEventListener("click", () => {
  if (state.index === 0) return;
  state.index -= 1;
  state.answers.length = state.index;
  renderQuestion();
});

$("note-text").addEventListener("input", (event) => {
  $("note-count").textContent = String(event.target.value.length);
});

$("note-next").addEventListener("click", () => {
  state.note = $("note-text").value.trim().slice(0, MAX_NOTE_LENGTH);
  finish();
});

$("note-skip").addEventListener("click", () => {
  state.note = "";
  finish();
});

$("result-send").addEventListener("click", () => {
  const result = state.result;
  if (!result) return;
  haptic("medium");
  submit({ type: "result", instrument: result.instrument, answers: result.answers, note: result.note || null });
});

$("rem-save").addEventListener("click", async () => {
  const raw = $("rem-tz").value;
  const settings = {
    enabled: $("rem-on").checked,
    time: $("rem-time").value || "19:00",
    tz: raw === "auto" ? "auto" : Number(raw),
  };
  await storageSet(SETTINGS_KEY, JSON.stringify(settings));
  submit({ type: "reminders", enabled: settings.enabled, time: settings.time, tz: settings.tz });
});

$("data-export").addEventListener("click", exportFile);
$("data-import-go").addEventListener("click", importFromChat);

$("data-delete").addEventListener("click", async () => {
  const keys = await storageKeys();
  await storageRemoveAll(keys);
  state.results = [];
  submit({ type: "delete" });
});

ready();
renderHome();
loadResults().then((results) => { state.results = results; });
