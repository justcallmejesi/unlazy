// "Мій персонаж": a week of small self-esteem challenges, an aura that grows
// with them, and a character who moves to a new place on every level.
// Zero dependencies, drawn in SVG, state in the same storage as the results.
//
// Rules that are deliberate, not decoration:
// - Earned aura never burns. A skipped day resets only the combo.
// - The look is all available from the start: nobody has to earn themselves.
// - A PHQ-9 with the risk item marked in the last 14 days switches the screen
//   to care mode: crisis contacts first, challenges paused, only the light one.
// - The first week is free; later weeks belong to the full access.

const STORE_KEY = "c_char";
const DAY_MS = 24 * 60 * 60 * 1000;
const RISK_WINDOW_MS = 14 * DAY_MS;
const r1 = (value) => Math.round(value * 10) / 10;

const LEVELS = [
  { name: "Іскра", at: 0, place: "тісна кімната" },
  { name: "Жар", at: 50, place: "прокачана кімната" },
  { name: "Полум'я", at: 120, place: "лофт з графіті" },
  { name: "Сяйво", at: 220, place: "неонова вулиця" },
  { name: "Легенда", at: 350, place: "сцена з прожекторами" },
];
const AURAS = [
  ["Фіолетова", "#A970FF"], ["Бірюзова", "#2EE6D6"], ["Пурпурна", "#FF4FD8"],
  ["Золота", "#FFC93C"], ["Лаймова", "#B6FF3C"], ["Вогняна", "#FF7A2E"],
];
const HAIRS = [
  ["Чорне з червоними кінчиками", "#1C1726", "#FF2E4D"], ["Платина", "#EDE9F7", "#B7AEDB"],
  ["Неоново-зелене", "#1F3A2A", "#3CFF7A"], ["Електрик", "#1B2A6B", "#3D8BFF"], ["Яскраво-рожеве", "#5E1A44", "#FF4FA3"],
];
const FITS = [["Фіолетове", "#6A2BD9"], ["Кислотно-зелене", "#7BD82E"], ["Помаранчеве", "#FF6A1F"], ["Чорне", "#24202E"], ["Кобальт", "#2A55E0"]];
const PETS = [["Маленький дракон", "dragon"], ["Чорний кіт", "cat"], ["Міні-робот", "robot"], ["Нікого", "none"]];
const FORMS = [["Він", "m"], ["Вона", "f"]];

const TIERS = [
  { id: "light", name: "Легкий", xp: 5 },
  { id: "bold", name: "Сміливий", xp: 10 },
  { id: "epic", name: "Епічний", xp: 20 },
];

const INITIAL = () => ({
  v: 1, start: null, aura: 0, done: {}, boss: {},
  look: { aura: 0, hair: 0, fit: 0, pet: "dragon", form: "m" }, tier: "bold",
});

export function mountCharacter(deps) {
  const $ = (id) => document.getElementById(id);
  let state = INITIAL();
  let open = "board";
  let loaded = false;

  const g = (male, female) => (state.look.form === "f" ? female : male);

  function week() {
    return [
      { title: "Мої якості", sticker: "📖", tiers: ["Назви одну свою якість, яка тобі подобається.", "Назви три якості і приклад до однієї.", "Спитай друга, що він у тобі цінує, і запиши це."] },
      { title: "Докази дня", sticker: "🫙", tiers: ["Згадай одну річ, яка сьогодні вдалася.", "Знайди три докази за день, що ти справляєшся.", "П'ять доказів, і один з них про те, де ти " + g("був сміливим", "була сміливою") + "."] },
      { title: "Відповідь критикові", sticker: "📣", tiers: ["Поміть одну думку критика і назви її: «Це критик, а не правда».", "Відповідай критикові так, як відповів би друг.", "Відповідай уголос, звертаючись до себе на ім'я, і зроби одну дію наперекір критику."] },
      { title: "Добре слово", sticker: "💬", tiers: ["Згадай комплімент, який тобі зробили.", "На будь-яку похвалу сьогодні відповідай: «Дякую, мені приємно».", "Зроби три щирі компліменти іншим і прийми один без «та нічого»."] },
      { title: "Маленька сміливість", sticker: "⚡", tiers: ["Запиши прогноз: що станеться, якщо зробиш крок.", "Зроби маленький крок: спитай, відмов або попроси.", "Скажи свою думку там, де зазвичай мовчиш."] },
      { title: "Мої досягнення", sticker: "🏆", tiers: ["Згадай одне досягнення за рік.", "По одному досягненню з чотирьох періодів життя.", "Розкажи комусь про головне досягнення, як промову переможця."] },
      { title: "Погляд збоку", sticker: "👁", tiers: ["Назви одне, чим ти пишаєшся за тиждень.", "Перечитай свій перший запис і скажи, що бачиш хорошого.", "Напиши звернення до себе з першого дня тижня."] },
    ];
  }
  const BOSS_XP = 50;
  const bossText = () => "Зроби те, чого " + g("уникав", "уникала") + " увесь тиждень. Як пройшло, неважливо: важливо, що ти " +
    g("вийшов", "вийшла") + " назустріч.";
  const petLines = () => ["Ти вже " + g("сильніший", "сильніша") + ", ніж учора.", "Ще один крок, і буде новий рівень!",
    "Я з тобою. Навіть у важкі дні.", "Критик гучний, але не головний.", "Вогонь! Продовжуй."];

  // ---------------------------------------------------------------- time

  function dayKey(ms) {
    const date = new Date(ms);
    const pad = (value) => String(value).padStart(2, "0");
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
  }
  const midnight = (key) => new Date(key + "T00:00:00").getTime();
  const daysSinceStart = () => Math.max(0, Math.round((midnight(dayKey(Date.now())) - midnight(state.start)) / DAY_MS));
  const weekNo = () => Math.floor(daysSinceStart() / 7) + 1;
  const dayNo = () => (daysSinceStart() % 7) + 1;
  const todayKey = () => dayKey(Date.now());
  const todayDone = () => state.done[todayKey()] || null;
  const weekDone = () => Object.keys(state.done).filter((key) => state.done[key].week === weekNo());

  // Days in a row up to today (or yesterday, while today is still open).
  function combo() {
    let count = 0;
    let cursor = todayDone() ? Date.now() : Date.now() - DAY_MS;
    while (state.done[dayKey(cursor)]) {
      count += 1;
      cursor -= DAY_MS;
    }
    return count;
  }
  const comboMultiplier = (count) => (count >= 3 ? 1.5 : 1);

  const levelIndex = () => LEVELS.reduce((index, level, i) => (state.aura >= level.at ? i : index), 0);
  const auraColor = () => AURAS[state.look.aura][1];
  const locked = () => weekNo() > 1 && !deps.isUnlocked();

  // ---------------------------------------------------------------- storage

  async function load() {
    const values = await deps.storageGetMany([STORE_KEY]);
    try {
      const parsed = JSON.parse(values[STORE_KEY] || "null");
      if (parsed && parsed.v === 1) state = Object.assign(INITIAL(), parsed, { look: Object.assign(INITIAL().look, parsed.look) });
    } catch (error) { /* a broken record starts over */ }
    if (!state.start) {
      state.start = todayKey();
      save();
    }
    loaded = true;
  }

  function save() {
    return deps.storageSet(STORE_KEY, JSON.stringify(state));
  }

  // ---------------------------------------------------------------- drawing helpers

  function mix(from, to, share) {
    const c = (hex, at) => parseInt(hex.slice(at, at + 2), 16);
    let out = "#";
    for (let at = 1; at < 7; at += 2) out += Math.round(c(from, at) + (c(to, at) - c(from, at)) * share).toString(16).padStart(2, "0");
    return out;
  }
  const rect = (x, y, w, h, rx, fill, extra) => '<rect x="' + r1(x) + '" y="' + r1(y) + '" width="' + r1(w) + '" height="' + r1(h) + '" rx="' + rx + '" fill="' + fill + '"' + (extra || "") + "/>";
  const circle = (x, y, r, fill, extra) => '<circle cx="' + r1(x) + '" cy="' + r1(y) + '" r="' + r + '" fill="' + fill + '"' + (extra || "") + "/>";
  const ellipse = (x, y, rx, ry, fill, extra) => '<ellipse cx="' + r1(x) + '" cy="' + r1(y) + '" rx="' + rx + '" ry="' + ry + '" fill="' + fill + '"' + (extra || "") + "/>";
  const path = (d, fill, extra) => '<path d="' + d + '" fill="' + fill + '"' + (extra || "") + "/>";
  const stroke = (d, color, width, extra) => '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="' + width + '" stroke-linecap="round" stroke-linejoin="round"' + (extra || "") + "/>";
  const poly = (cx, cy, points, fill, extra) => '<polygon points="' + points.map(([x, y]) => r1(cx + x) + "," + r1(cy + y)).join(" ") + '" fill="' + fill + '"' + (extra || "") + "/>";
  const flame = (x, y, s, fill) => '<path class="flame" d="M' + r1(x) + " " + r1(y + s) + " Q" + r1(x - s * 0.85) + " " + r1(y) + " " + r1(x) + " " + r1(y - s * 1.7) + " Q" + r1(x + s * 0.85) + " " + r1(y) + " " + r1(x) + " " + r1(y + s) + 'Z" fill="' + fill + '"/>';
  const star = (x, y, outer, inner, fill, extra) => {
    let d = "";
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const radius = i % 2 ? inner : outer;
      d += (i ? " L" : "M") + r1(x + Math.cos(a) * radius) + " " + r1(y + Math.sin(a) * radius);
    }
    return path(d + "Z", fill, extra);
  };

  // ---------------------------------------------------------------- locations

  function backdrop(level, risk) {
    if (risk) {
      let s = '<rect width="400" height="260" fill="url(#gSafe)"/>' + circle(310, 70, 120, "url(#gLamp)");
      for (let i = 0; i < 14; i++) s += circle(20 + i * 27, 16 + Math.sin(i) * 6, 3, ["#FFD27A", "#FF9FC4", "#9FF0E4"][i % 3], ' opacity="0.9"');
      s += stroke("M6 14 Q200 34 394 14", "#6B5A6E", 1);
      s += rect(0, 212, 400, 48, 0, "#3A2B3C") + rect(296, 120, 4, 92, 1, "#6E5A4A") + path("M282 122 L316 122 L308 100 L290 100Z", "#FFC98A");
      return s;
    }
    if (level <= 1) {
      let s = '<rect width="400" height="260" fill="url(#gRoom)"/>' + rect(0, 210, 400, 50, 0, "#2A1D45");
      for (let x = 0; x < 400; x += 50) s += stroke("M" + x + " 210 L" + (x - 30) + " 260", "#35275A", 1.2);
      s += rect(190, 26, 34, 46, 3, "#FF4FA3", ' opacity="0.85"') + rect(232, 34, 30, 40, 3, "#2EE6D6", ' opacity="0.8"') + star(207, 48, 9, 4, "#FFF1A8");
      s += circle(247, 54, 9, "#130D24") + rect(122, 166, 156, 40, 10, "#3B2C66") + rect(126, 156, 148, 18, 8, "#5B4A9A") + rect(130, 150, 34, 12, 6, "#ECE6FF");
      s += rect(282, 150, 32, 58, 4, "#2D2150") + path("M286 146 L310 146 L304 128 L292 128Z", "#FFD27A") + circle(298, 150, 22, "#FFD27A", ' opacity="0.18"');
      if (level === 1) {
        s += rect(0, 4, 400, 3, 1, "url(#gLed)", ' filter="url(#neon)"');
        [[184, 92, "#B6FF3C"], [266, 96, "#FFC93C"], [196, 110, "#FF7A2E"]].forEach(([x, y, c]) => { s += circle(x, y, 7, c, ' opacity="0.9"'); });
      }
      return s;
    }
    if (level === 2) {
      let s = '<rect width="400" height="260" fill="#2A1830"/>';
      for (let y = 0; y < 210; y += 14) for (let x = (y / 14) % 2 ? -14 : 0; x < 400; x += 28) s += rect(x + 1, y + 1, 26, 12, 2, "#321D3A");
      s += rect(150, 18, 110, 74, 6, "#0F1430") + rect(154, 22, 102, 66, 4, "url(#gCity)");
      [[160, 60, 14, 28], [178, 48, 16, 40], [198, 56, 12, 32], [214, 42, 18, 46], [236, 54, 16, 34]].forEach(([x, y, w, h]) => {
        s += rect(x, y, w, h, 1, "#1A1438");
        for (let i = 0; i < 4; i++) s += rect(x + 3 + (i % 2) * 6, y + 5 + Math.floor(i / 2) * 9, 3, 4, 0, "#FFD27A", ' opacity="0.8"');
      });
      s += stroke("M30 150 C60 120 90 170 120 140 S170 120 190 150", "#FF4FA3", 9, ' opacity="0.85"') + stroke("M250 160 L270 120 L290 160 L310 120 L330 160", "#B6FF3C", 8, ' opacity="0.85"') + circle(330, 60, 22, "#2EE6D6", ' opacity="0.6"') + star(330, 60, 14, 6, "#FFC93C");
      s += rect(0, 210, 400, 50, 0, "#1E1528") + rect(250, 168, 8, 50, 3, "#FF6A1F") + circle(254, 172, 3, "#EEE") + circle(254, 214, 3, "#EEE");
      s += rect(286, 176, 26, 36, 4, "#151020") + circle(299, 188, 7, "#2A2240") + circle(299, 204, 5, "#2A2240");
      return s;
    }
    if (level === 3) {
      let s = '<rect width="400" height="260" fill="url(#gNight)"/>';
      [[0, 70, 60, 150], [56, 40, 70, 180], [130, 90, 50, 130], [264, 50, 64, 170], [330, 80, 70, 140]].forEach(([x, y, w, h]) => { s += rect(x, y, w, h, 2, "#141033"); });
      s += rect(66, 56, 44, 16, 4, "none", ' stroke="#FF4FA3" stroke-width="2.5" filter="url(#neon)"') + rect(272, 70, 48, 14, 4, "none", ' stroke="#2EE6D6" stroke-width="2.5" filter="url(#neon)"') + circle(352, 104, 9, "none", ' stroke="#FFC93C" stroke-width="2.5" filter="url(#neon)"');
      s += path("M200 150 C150 100 120 120 104 82 C140 96 160 70 200 120Z", "#FFFFFF", ' opacity="0.12"') + path("M200 150 C250 100 280 120 296 82 C260 96 240 70 200 120Z", "#FFFFFF", ' opacity="0.12"');
      s += rect(0, 210, 400, 50, 0, "#16122A") + ellipse(150, 236, 46, 6, "#FF4FA3", ' opacity="0.25"') + ellipse(270, 244, 40, 5, "#2EE6D6", ' opacity="0.25"');
      return s;
    }
    let s = '<rect width="400" height="260" fill="#0E0920"/>' + rect(110, 10, 180, 70, 8, "url(#gScreen)");
    [60, 200, 340].forEach((x) => { s += path("M" + x + " 0 L" + (x - 70) + " 220 L" + (x + 70) + " 220Z", "#FFFFFF", ' opacity="0.07"'); });
    s += rect(0, 200, 400, 30, 0, "#2A1F3F") + rect(0, 198, 400, 3, 0, "url(#gLed)");
    for (let i = 0; i < 24; i++) s += rect(20 + (i * 53) % 370, 20 + (i * 37) % 150, 4, 7, 1, ["#FF4FA3", "#2EE6D6", "#FFC93C", "#B6FF3C"][i % 4], ' transform="rotate(' + (i * 23) % 90 + " " + (22 + (i * 53) % 370) + " " + (24 + (i * 37) % 150) + ')"');
    return s;
  }

  function crowd() {
    let s = "";
    for (let i = 0; i < 11; i++) {
      const x = 10 + i * 38;
      const y = 246 + (i % 2) * 6;
      s += ellipse(x, y + 10, 16, 14, "#06040E") + circle(x, y - 8, 9, "#06040E");
      if (i % 3 !== 1) s += stroke("M" + (x - 8) + " " + y + " L" + (x - 14) + " " + (y - 26), "#06040E", 5) + stroke("M" + (x + 8) + " " + y + " L" + (x + 14) + " " + (y - 26), "#06040E", 5);
    }
    return s;
  }

  // The things you tap sit in the same places in every location.
  function hotspots(level) {
    const aura = auraColor();
    const ping = (x, y) => '<circle class="ping" cx="' + x + '" cy="' + y + '" r="7" fill="none"/>';
    let s = '<g data-hot="board" tabindex="0" role="button" aria-label="Дошка викликів">' +
      rect(22, 56, 80, 60, 5, "#8A5A3A") + rect(26, 60, 72, 52, 3, "#B9875D") +
      rect(32, 66, 18, 22, 2, "#7BD82E", ' transform="rotate(-6 41 77)"') + rect(54, 64, 18, 22, 2, "#FFC93C") + rect(76, 68, 18, 22, 2, "#FF4FA3", ' transform="rotate(5 85 79)"') +
      circle(85, 70, 3, "#FFFFFF", ' filter="url(#neon)"') + rect(34, 94, 56, 10, 3, "#3B2A1F") + (todayDone() ? "" : ping(85, 70)) + "</g>";
    s += '<g data-hot="stickers" tabindex="0" role="button" aria-label="Стіна стікерів">' + rect(112, 34, 66, 46, 6, "#1B1530", ' stroke="' + aura + '" stroke-width="1.5"');
    const got = weekDone().length + (state.boss[weekNo()] ? 1 : 0);
    for (let i = 0; i < 8; i++) s += circle(124 + (i % 4) * 14, 47 + Math.floor(i / 4) * 20, 5.2, i < got ? ["#FF4FA3", "#2EE6D6", "#FFC93C", "#B6FF3C"][i % 4] : "#2F2550");
    s += "</g>";
    const bossReady = dayNo() === 7 && !state.boss[weekNo()];
    s += '<g data-hot="door" tabindex="0" role="button" aria-label="Двері до боса">' + rect(322, 82, 56, 148, 6, "#241B3E") + rect(328, 88, 44, 136, 4, "#2F2450") +
      rect(326, 226, 48, 4, 2, bossReady ? "#FFFFFF" : aura, ' filter="url(#neon)"') + circle(366, 158, 4, bossReady ? "#FFC93C" : "#6B5E8F", bossReady ? ' filter="url(#neon)"' : "") +
      circle(340, 112, 5, "#FF4FA3") + rect(346, 124, 12, 8, 2, "#2EE6D6") + star(338, 192, 6, 2.5, "#FFC93C") + (bossReady ? ping(366, 158) : "") + "</g>";
    const lvl = LEVELS[level];
    const next = LEVELS[level + 1];
    const share = next ? (state.aura - lvl.at) / (next.at - lvl.at) : 1;
    s += '<g data-hot="crystal" tabindex="0" role="button" aria-label="Кристал аури"><g class="pulse">' + circle(360, 38, 22, aura, ' opacity="0.18"') +
      path("M360 14 L374 38 L360 62 L346 38Z", "#1B1530", ' stroke="' + aura + '" stroke-width="2" filter="url(#neon)"') +
      '<clipPath id="cfill"><rect x="340" y="' + r1(62 - 48 * Math.min(1, share)) + '" width="40" height="60"/></clipPath>' +
      path("M360 14 L374 38 L360 62 L346 38Z", aura, ' clip-path="url(#cfill)" opacity="0.85"') + "</g></g>";
    return s;
  }

  // ---------------------------------------------------------------- the character

  function pose(level, risk) {
    if (risk) return "safe";
    return ["sit", "stand", "skate", "pockets", "victory"][level];
  }

  function character(level, risk) {
    const p = pose(level, risk);
    const cx = 200;
    const skin = "#F2C4A4";
    const skinDark = "#C98C6A";
    const fit = FITS[state.look.fit][1];
    const fitDark = mix(fit, "#000000", 0.3);
    const pants = "#2A2533";
    const aura = auraColor();
    const seated = p === "sit" || p === "safe";
    const hy = seated ? 118 : 98;
    const sy = hy + 32;
    const wy = seated ? sy + 54 : sy + 58;
    let s = "";
    if (p === "safe") s += ellipse(cx, 214, 64, 30, "#8E5A7E") + ellipse(cx - 6, 196, 50, 26, "#A86C94");
    const shoe = (x, y) => rect(x - 14, y - 7, 28, 13, 6, "#F4F2FA") + rect(x - 14, y + 2, 28, 4, 2, aura) + circle(x - 3, y - 2, 1.1, "#9A92B8") + circle(x + 3, y - 2, 1.1, "#9A92B8");
    if (seated) {
      s += rect(cx - 27, wy - 8, 24, 16, 7, pants) + rect(cx + 3, wy - 8, 24, 16, 7, pants) + rect(cx - 25, wy + 4, 19, 236 - wy - 12, 7, pants) + rect(cx + 6, wy + 4, 19, 236 - wy - 12, 7, pants);
      s += shoe(cx - 16, 230) + shoe(cx + 16, 230);
    } else {
      s += rect(cx - 27, wy - 6, 24, 228 - wy, 8, pants) + rect(cx + 3, wy - 6, 24, 228 - wy, 8, pants);
      s += rect(cx - 30, wy + 10, 7, 13, 2, "#1E1A26") + rect(cx + 23, wy + 10, 7, 13, 2, "#1E1A26");
      if (p === "skate") s += rect(cx + 10, 214, 52, 6, 3, "#FF6A1F", ' transform="rotate(-8 ' + (cx + 36) + ' 217)"') + circle(cx + 18, 224, 3.5, "#EEE") + circle(cx + 54, 219, 3.5, "#EEE");
      s += shoe(cx - 16, 228) + (p === "skate" ? shoe(cx + 30, 208) : shoe(cx + 16, 228));
    }
    s += poly(cx, hy, [[-30, 30], [-37, 18], [-34, 6], [-41, -8], [-33, -18], [-38, -30], [-25, -36], [-18, -47], [-6, -41], [2, -51], [10, -41], [22, -47], [26, -35], [39, -30], [34, -18], [41, -8], [34, 6], [37, 18], [30, 30], [20, 22], [0, 24], [-20, 22]], "url(#gHair)");
    s += rect(cx - 7, hy + 22, 14, sy - hy - 18, 4, skinDark);
    s += path("M" + (cx - 30) + " " + (sy + 4) + " Q" + cx + " " + (sy - 9) + " " + (cx + 30) + " " + (sy + 4) + " L" + (cx + 35) + " " + wy + " Q" + cx + " " + (wy + 7) + " " + (cx - 35) + " " + wy + "Z", fit);
    s += rect(cx - 35, wy - 8, 70, 9, 4, fitDark) + path("M" + (cx - 17) + " " + (wy - 30) + " L" + (cx + 17) + " " + (wy - 30) + " L" + (cx + 21) + " " + (wy - 10) + " L" + (cx - 21) + " " + (wy - 10) + "Z", fitDark, ' opacity="0.6"');
    s += path("M" + (cx - 20) + " " + (sy + 1) + " Q" + (cx - 18) + " " + (sy - 10) + " " + (cx - 7) + " " + (sy - 6) + " L" + (cx - 7) + " " + (sy + 5) + "Z", fitDark) + path("M" + (cx + 20) + " " + (sy + 1) + " Q" + (cx + 18) + " " + (sy - 10) + " " + (cx + 7) + " " + (sy - 6) + " L" + (cx + 7) + " " + (sy + 5) + "Z", fitDark);
    s += stroke("M" + (cx - 4) + " " + (sy + 4) + " L" + (cx - 5) + " " + (sy + 22), "#F4F2FA", 1.6) + stroke("M" + (cx + 4) + " " + (sy + 4) + " L" + (cx + 5) + " " + (sy + 22), "#F4F2FA", 1.6);
    s += stroke("M" + (cx - 22) + " " + (sy - 3) + " Q" + cx + " " + (sy + 12) + " " + (cx + 22) + " " + (sy - 3), "#1A1622", 4) + rect(cx - 31, sy - 11, 11, 16, 5, aura) + rect(cx + 20, sy - 11, 11, 16, 5, aura);
    const arms = {
      sit: [[[-26, 10], [-30, 46], [-6, 62]], [[26, 10], [30, 46], [6, 62]]],
      safe: [[[-26, 10], [-30, 46], [-8, 52]], [[26, 10], [30, 46], [8, 52]]],
      stand: [[[-27, 10], [-38, 38], [-34, 60]], [[27, 10], [38, 38], [34, 60]]],
      skate: [[[-27, 10], [-48, 30], [-30, 46]], [[27, 10], [46, -6], [40, -32]]],
      pockets: [[[-27, 10], [-40, 32], [-20, 50]], [[27, 10], [40, 32], [20, 50]]],
      victory: [[[-27, 10], [-46, -14], [-58, -44]], [[27, 10], [46, -14], [58, -44]]],
    }[p];
    arms.forEach((arm) => {
      const pts = arm.map(([x, y]) => [cx + x, sy + y]);
      s += stroke("M" + pts.map(([x, y]) => r1(x) + " " + r1(y)).join(" L"), fit, 17) + stroke("M" + pts.slice(1).map(([x, y]) => r1(x) + " " + r1(y)).join(" L"), fitDark, 17, ' opacity="0.25"');
    });
    if (p === "safe") {
      s += path("M" + (cx - 40) + " " + (sy + 4) + " Q" + cx + " " + (sy - 22) + " " + (cx + 40) + " " + (sy + 4) + " L" + (cx + 44) + " " + (wy + 8) + " Q" + cx + " " + (wy + 18) + " " + (cx - 44) + " " + (wy + 8) + "Z", "#C9768E");
      s += stroke("M" + (cx - 18) + " " + (sy - 6) + " L" + (cx - 20) + " " + (wy + 12), "#E5A0B6", 3, ' opacity="0.7"') + stroke("M" + (cx + 18) + " " + (sy - 6) + " L" + (cx + 20) + " " + (wy + 12), "#E5A0B6", 3, ' opacity="0.7"');
      s += rect(cx - 8, sy + 40, 16, 15, 3, "#F4F2FA") + stroke("M" + (cx + 8) + " " + (sy + 44) + " q6 0 6 5 q0 5 -6 5", "#F4F2FA", 2.5) + stroke("M" + (cx - 3) + " " + (sy + 36) + " q-3 -4 0 -8 t0 -7 M" + (cx + 3) + " " + (sy + 36) + " q-3 -4 0 -8 t0 -7", "#FFFFFF", 1.6, ' opacity="0.8"');
    }
    arms.forEach((arm, index) => {
      const hx = cx + arm[2][0];
      const hyy = sy + arm[2][1];
      s += circle(hx, hyy, 8, skin);
      if (index === 1 && p !== "safe") s += path("M" + (hx - 1) + " " + (hyy - 5) + " L" + (hx - 4) + " " + (hyy + 1) + " L" + hx + " " + hyy + " L" + (hx - 2) + " " + (hyy + 6) + " L" + (hx + 3) + " " + (hyy - 1) + " L" + (hx - 1) + " " + hyy + "Z", "#2A2140");
    });
    s += ellipse(cx - 27, hy + 6, 5, 7, skin) + ellipse(cx + 27, hy + 6, 5, 7, skin) + ellipse(cx, hy, 27, 29, skin);
    const smile = { sit: 0, safe: 1, stand: 2, skate: 3, pockets: 3, victory: 4 }[p];
    const eye = (x) => ellipse(x, hy + 5, 5.6, 6.6, "#FFFFFF") + circle(x + 0.6, hy + 6, 3.8, mix(aura, "#1A1030", 0.35)) + circle(x + 0.6, hy + 6, 1.8, "#140D22") + circle(x + 2, hy + 4, 1.2, "#FFFFFF") +
      stroke("M" + (x - 6.5) + " " + (hy + 1) + " Q" + x + " " + (hy - (smile ? 3 : 1.5)) + " " + (x + 6.5) + " " + (hy + 1), "#1A1426", 2.4);
    s += eye(cx - 11) + eye(cx + 11);
    const brow = smile >= 3 ? -7.5 : -6;
    s += stroke("M" + (cx - 19) + " " + (hy + brow + 1.5) + " L" + (cx - 14) + " " + (hy + brow), "#1A1426", 3) + stroke("M" + (cx - 11) + " " + (hy + brow - 0.5) + " L" + (cx - 5) + " " + (hy + brow - 1.5), "#1A1426", 3) +
      stroke("M" + (cx + 5) + " " + (hy + brow - 1.5) + " L" + (cx + 19) + " " + (hy + brow + 1.5), "#1A1426", 3);
    s += stroke("M" + (cx - 1.5) + " " + (hy + 12) + " L" + (cx + 1.5) + " " + (hy + 14), skinDark, 1.6);
    if (smile >= 3) s += path("M" + (cx - 9) + " " + (hy + 18) + " Q" + cx + " " + (hy + 30) + " " + (cx + 9) + " " + (hy + 18) + "Z", "#4A1830") + rect(cx - 6, hy + 18, 12, 3, 1, "#FFFFFF");
    else s += stroke("M" + (cx - 7) + " " + (hy + 19) + " Q" + cx + " " + (hy + 19 + smile * 1.8) + " " + (cx + 7) + " " + (hy + 19 - (smile ? 0 : 1)), "#7A2E3A", 2.2);
    if (p === "sit") {
      s += path("M" + (cx - 34) + " " + (hy + 26) + " C" + (cx - 44) + " " + (hy - 30) + " " + (cx + 44) + " " + (hy - 30) + " " + (cx + 34) + " " + (hy + 26) + " L" + (cx + 26) + " " + (hy + 22) + " C" + (cx + 30) + " " + (hy - 18) + " " + (cx - 30) + " " + (hy - 18) + " " + (cx - 26) + " " + (hy + 22) + "Z", fit);
      s += poly(cx, hy, [[-24, -4], [-22, -14], [-10, -20], [6, -20], [20, -14], [24, -4], [16, -8], [10, -4], [4, -10], [-2, -5], [-8, -11], [-14, -5], [-19, -10]], "url(#gHair)");
    } else {
      s += poly(cx, hy, [[-28, -2], [-29, -18], [-20, -29], [-6, -33], [8, -32], [22, -27], [29, -14], [28, -2], [21, -10], [16, -7], [10, -13], [4, -8], [-2, -14], [-8, -8], [-14, -14], [-19, -8], [-24, -12]], "url(#gHair)");
    }
    return '<g style="filter: drop-shadow(0 0 3px ' + aura + ')">' + s + "</g>";
  }

  function auraLayer(level, risk) {
    const aura = auraColor();
    const seated = pose(level, risk) === "sit" || risk;
    const cy = seated ? 170 : 150;
    if (risk) return circle(200, cy, 70, "url(#gAura)", ' opacity="0.5"');
    let s = circle(200, cy, [26, 60, 90, 120, 160][level], "url(#gAura)", ' opacity="' + [0.5, 0.6, 0.7, 0.8, 0.9][level] + '"');
    if (level === 0) return s + '<g filter="url(#neon)">' + flame(200, 198, 5, aura) + star(200, 194, 5, 2, "#FFFFFF") + "</g>";
    if (level >= 3) {
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2;
        s += stroke("M" + r1(200 + Math.cos(a) * 52) + " " + r1(cy + Math.sin(a) * 62) + " L" + r1(200 + Math.cos(a) * (level === 4 ? 150 : 110)) + " " + r1(cy + Math.sin(a) * (level === 4 ? 140 : 105)), aura, 3, ' opacity="0.45"');
      }
    }
    const spots = level === 1 ? [[166, 196, 6], [234, 196, 6], [160, 186, 4], [240, 186, 4]] :
      [[150, 120, 9], [250, 120, 9], [140, 160, 10], [260, 160, 10], [150, 200, 9], [250, 200, 9], [176, 86, 8], [224, 86, 8], [200, 66, 10]];
    let flames = "";
    spots.forEach(([x, y, size]) => { flames += flame(x, y, size * (level === 4 ? 1.4 : 1), aura); });
    s += '<g filter="url(#neon)">' + flames + "</g>";
    for (let i = 0; i < level * 5; i++) s += '<circle class="mote" cx="' + (130 + (i * 47) % 140) + '" cy="' + (200 - (i * 29) % 90) + '" r="1.8" fill="#FFFFFF" style="animation-delay:' + (i * 0.37).toFixed(2) + 's"/>';
    return s;
  }

  function companion(level) {
    const kind = state.look.pet;
    if (kind === "none") return "";
    const aura = auraColor();
    let s = '<g data-hot="pet" tabindex="0" role="button" aria-label="Компаньйон">';
    if (kind === "dragon") {
      s += path("M268 218 Q244 214 250 196 Q254 206 266 206Z", "#1FB59A") + path("M286 196 L270 172 L296 186Z", "#7B4DFF") + path("M300 194 L318 168 L308 192Z", "#7B4DFF");
      s += ellipse(290, 212, 18, 16, "#22C3A6") + ellipse(290, 218, 10, 9, "#BFF5E8") + circle(306, 192, 13, "#22C3A6") + path("M300 180 L303 170 L307 180Z", "#FFC93C") + path("M310 180 L314 171 L316 182Z", "#FFC93C");
      s += ellipse(303, 191, 4, 4.6, "#FFFFFF") + circle(304, 192, 2.2, "#140D22") + ellipse(312, 191, 3.6, 4.2, "#FFFFFF") + circle(313, 192, 2, "#140D22") + stroke("M306 200 Q311 203 316 199", "#0E6E5D", 1.6);
      s += ellipse(280, 228, 6, 4, "#1FB59A") + ellipse(300, 228, 6, 4, "#1FB59A");
      if (level >= 3) s += '<g filter="url(#neon)">' + flame(324, 196, 4, "#FF7A2E") + "</g>";
    } else if (kind === "cat") {
      s += stroke("M300 226 Q318 220 312 200 Q310 192 316 188", "#14111C", 5) + ellipse(292, 212, 13, 16, "#14111C") + circle(292, 192, 11, "#14111C");
      s += path("M283 186 L285 172 L291 182Z", "#14111C") + path("M301 186 L299 172 L293 182Z", "#14111C");
      s += ellipse(288, 192, 3, 3.6, "#3CFF7A", ' filter="url(#neon)"') + ellipse(297, 192, 3, 3.6, "#3CFF7A", ' filter="url(#neon)"') + circle(288, 192, 1.2, "#081208") + circle(297, 192, 1.2, "#081208");
    } else {
      s += '<g class="pulse">' + rect(276, 176, 30, 26, 8, "#D9D4EA") + rect(281, 182, 20, 12, 4, "#140D22") + circle(286, 188, 2.6, aura, ' filter="url(#neon)"') + circle(296, 188, 2.6, aura, ' filter="url(#neon)"');
      s += stroke("M291 176 L291 168", "#9A92B8", 2) + circle(291, 166, 3, "#FF4FA3") + ellipse(291, 214, 10, 4, aura, ' opacity="0.5" filter="url(#neon)"') + "</g>";
    }
    return s + "</g>";
  }

  function sceneSvg() {
    const level = levelIndex();
    const risk = deps.riskActive();
    const aura = auraColor();
    const hair = HAIRS[state.look.hair];
    const defs = "<defs>" +
      '<filter id="neon" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
      '<radialGradient id="gAura"><stop offset="0" stop-color="' + aura + '" stop-opacity="0.9"/><stop offset="0.55" stop-color="' + aura + '" stop-opacity="0.35"/><stop offset="1" stop-color="' + aura + '" stop-opacity="0"/></radialGradient>' +
      '<radialGradient id="gLamp"><stop offset="0" stop-color="#FFC98A" stop-opacity="0.45"/><stop offset="1" stop-color="#FFC98A" stop-opacity="0"/></radialGradient>' +
      '<linearGradient id="gHair" gradientUnits="userSpaceOnUse" x1="0" y1="40" x2="0" y2="160"><stop offset="0" stop-color="' + hair[1] + '"/><stop offset="0.5" stop-color="' + hair[1] + '"/><stop offset="1" stop-color="' + hair[2] + '"/></linearGradient>' +
      '<linearGradient id="gRoom" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2B1B4E"/><stop offset="1" stop-color="#1A1030"/></linearGradient>' +
      '<linearGradient id="gSafe" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3B2A40"/><stop offset="1" stop-color="#2A1F2E"/></linearGradient>' +
      '<linearGradient id="gNight" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0B0F30"/><stop offset="1" stop-color="#2A1550"/></linearGradient>' +
      '<linearGradient id="gCity" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FF7A6B"/><stop offset="1" stop-color="#5B2A8A"/></linearGradient>' +
      '<linearGradient id="gScreen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="' + aura + '"/><stop offset="1" stop-color="#FF4FA3"/></linearGradient>' +
      '<linearGradient id="gLed" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#FF4FA3"/><stop offset="0.5" stop-color="#2EE6D6"/><stop offset="1" stop-color="#FFC93C"/></linearGradient>' +
      "</defs>";
    const label = risk ? "Персонаж у затишному місці, загорнутий у плед, з какао." : "Рівень " + LEVELS[level].name + ": " + LEVELS[level].place + ".";
    return '<svg viewBox="0 0 400 260" role="img" aria-label="' + label + '">' + defs + backdrop(level, risk) + auraLayer(level, risk) +
      (risk ? "" : hotspots(level)) + companion(level) + '<g data-hot="hero" tabindex="0" role="button" aria-label="Персонаж">' + character(level, risk) + "</g>" +
      (level === 4 && !risk ? crowd() : "") + "</svg>";
  }

  // ---------------------------------------------------------------- what a tap opens

  const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function sheetHtml() {
    const tasks = week();
    const task = tasks[dayNo() - 1];
    const count = combo();
    if (deps.riskActive() && open !== "pet" && open !== "look") {
      return '<span class="eyebrow">Режим турботи</span><h2>Зараз головне: ти не ' + g("сам", "сама") + "</h2>" +
        "<p>Нещодавно в PHQ-9 ти " + g("позначив", "позначила") + " думки про смерть або про те, щоб завдати собі шкоди. Будь ласка, не залишайся з цим наодинці.</p>" +
        '<p>Екстрена допомога: <a class="phone" href="tel:103">103</a> або <a class="phone" href="tel:112">112</a>. LifeLine Ukraine: <a class="phone" href="tel:7333">7333</a>, безкоштовно і цілодобово.</p>' +
        '<div class="row"><button type="button" class="btn" data-act="sos">🆘 Мені зараз погано</button></div>' +
        '<p class="help">Виклики на паузі. Якщо хочеться, можна зробити тільки легкий: ' + esc(task.tiers[0]) + " Аура не згорає.</p>";
    }
    if (open === "look") return lookHtml();
    if (locked() && (open === "board" || open === "door")) {
      return '<span class="eyebrow">Тиждень ' + weekNo() + "</span><h2>Перший тиждень пройдено</h2>" +
        "<p>Наступні тижні викликів входять у повний доступ. Аура, рівень і стікери залишаються з тобою.</p>" +
        '<div class="row"><button type="button" class="btn" data-act="access">⭐ Повний доступ</button></div>';
    }
    if (open === "board") {
      const done = todayDone();
      if (done) {
        const tier = TIERS.find((item) => item.id === done.tier) || TIERS[0];
        return '<span class="eyebrow">День ' + dayNo() + " з 7 · виконано</span><h2>" + esc(task.title) + ": " + tier.name.toLowerCase() + " рівень пройдено</h2>" +
          "<p>+" + done.xp + " Аури. Наступний виклик завтра." + (dayNo() === 7 && !state.boss[weekNo()] ? " А зараз двері до боса відчинені." : "") + "</p>";
      }
      const next = comboMultiplier(count + 1);
      return '<span class="eyebrow">Виклик дня · день ' + dayNo() + " з 7</span><h2>" + esc(task.title) + "</h2>" +
        '<div class="tiers">' + TIERS.map((tier, index) => '<button type="button" class="tier ' + tier.id + '" data-tier="' + tier.id + '" aria-pressed="' + (state.tier === tier.id) + '">' +
          '<span class="name">' + tier.name + "</span><span>" + esc(task.tiers[index]) + '</span><span class="xp">+' + Math.round(tier.xp * next) + " Аури" + (next > 1 ? " · комбо ×1,5" : "") + "</span></button>").join("") + "</div>" +
        '<div class="row"><button type="button" class="btn" data-act="record">✅ Зроблено</button></div>' +
        '<p class="help">Сміливість рахується, ідеальність ні. Хочеш, запиши собі кружок у Збережене: так через тиждень буде видно, як ти змінюєшся.</p>';
    }
    if (open === "door") {
      if (state.boss[weekNo()]) return '<span class="eyebrow">Бос тижня</span><h2>Переможено 👑</h2><p>Ти ' + g("зробив", "зробила") + " те, чого " + g("уникав", "уникала") + ". Голографічний стікер уже на стіні.</p>";
      if (dayNo() < 7) return '<span class="eyebrow">Бос тижня</span><h2>Двері відчиняться на 7-й день</h2><p>' + bossText() + '</p><p class="help">Нагорода: +' + BOSS_XP + " Аури і голографічний стікер. Залишилось днів: " + (7 - dayNo()) + ".</p>";
      return '<span class="eyebrow">Бос тижня</span><h2>Двері відчинені</h2><p>' + bossText() + '</p><div class="row"><button type="button" class="btn" data-act="boss">👑 Прийняти виклик</button></div>';
    }
    if (open === "stickers") {
      const doneDays = {};
      weekDone().forEach((key) => { doneDays[state.done[key].day] = true; });
      const all = tasks.map((item, index) => [item.sticker, item.title, Boolean(doneDays[index + 1])]).concat([["👑", "Бос тижня", Boolean(state.boss[weekNo()])]]);
      return '<span class="eyebrow">Стіна стікерів · тиждень ' + weekNo() + "</span><h2>Зібрано " + all.filter((item) => item[2]).length + " з 8</h2>" +
        '<div class="stickers">' + all.map(([e, title, got]) => '<div class="sticker' + (got ? " got" : "") + '"><span class="e" aria-hidden="true">' + e + "</span>" + esc(title) + "</div>").join("") + "</div>";
    }
    if (open === "crystal") {
      const level = levelIndex();
      const next = LEVELS[level + 1];
      return '<span class="eyebrow">Кристал аури</span><h2>' + state.aura + " Аури · " + LEVELS[level].name + "</h2>" +
        "<p>" + (next ? "До рівня «" + next.name + "» ще " + (next.at - state.aura) + ". Там чекає " + next.place + "." : "Ти на найвищому рівні. Легенда.") + "</p>" +
        '<p class="help">Днів поспіль: ' + count + (count >= 3 ? " 🔥 комбо ×1,5" : ", з трьох днів комбо ×1,5") + ". Пропуск обнуляє тільки комбо: зароблена Аура не згорає ніколи.</p>";
    }
    if (open === "pet") {
      const lines = petLines();
      return '<span class="eyebrow">Компаньйон</span><h2>«' + lines[Math.floor(Math.random() * lines.length)] + '»</h2><p class="help">Компаньйон завжди поруч і ніколи не сварить за пропуски.</p>';
    }
    return '<span class="eyebrow">Персонаж</span><h2>' + esc(deps.userName() || "Мій персонаж") + " · " + LEVELS[levelIndex()].name + "</h2><p>Аура " + state.aura + " · стікерів " +
      (weekDone().length + (state.boss[weekNo()] ? 1 : 0)) + " з 8 · тиждень " + weekNo() + ", день " + dayNo() + " з 7.</p>" +
      '<div class="row"><button type="button" class="btn ghost" data-act="look">🎨 Змінити вигляд</button></div>' +
      '<p class="help">Уся зовнішність доступна одразу: себе не треба заслуговувати.</p>';
  }

  function lookHtml() {
    const select = (key, label, list, numeric) => '<label class="field">' + label + '<select data-look="' + key + '">' +
      list.map((item, index) => {
        const value = numeric ? index : item[1];
        return '<option value="' + value + '"' + (String(state.look[key]) === String(value) ? " selected" : "") + ">" + item[0] + "</option>";
      }).join("") + "</select></label>";
    return '<span class="eyebrow">Вигляд</span><h2>Твій персонаж</h2>' +
      select("form", "Звертатися до тебе як", FORMS, false) + select("aura", "Колір аури", AURAS, true) +
      select("hair", "Волосся", HAIRS, true) + select("fit", "Худі", FITS, true) + select("pet", "Компаньйон", PETS, false) +
      '<div class="row"><button type="button" class="btn" data-act="hero">Готово</button></div>';
  }

  // ---------------------------------------------------------------- render and events

  function render(levelBefore) {
    if (!loaded) return;
    const level = levelIndex();
    const risk = deps.riskActive();
    const root = $("character");
    root.style.setProperty("--aura", auraColor());
    $("char-scene").innerHTML = sceneSvg();
    const next = LEVELS[level + 1];
    const share = next ? (state.aura - LEVELS[level].at) / (next.at - LEVELS[level].at) : 1;
    const count = combo();
    $("char-hud").innerHTML = '<span class="chip"><b>' + (risk ? "Режим турботи" : LEVELS[level].name) + "</b></span>" +
      '<div class="meter"><div class="bar"><i style="width:' + Math.round(share * 100) + '%"></i></div><small>Аура ' + state.aura +
      (next ? " · до «" + next.name + "» " + (next.at - state.aura) : " · максимум") + "</small></div>" +
      '<span class="chip">' + (count >= 3 ? "🔥 ×1,5" : "Комбо " + count + "/3") + "</span>";
    $("char-sheet").innerHTML = sheetHtml();
    if (levelBefore !== undefined && level > levelBefore && !risk) {
      const banner = $("char-banner");
      banner.innerHTML = "Новий рівень<b>" + LEVELS[level].name + "</b>Переїзд: " + LEVELS[level].place;
      banner.hidden = false;
      clearTimeout(render.timer);
      render.timer = setTimeout(() => { banner.hidden = true; }, 2600);
    }
  }

  function toast(text) {
    const node = $("char-toast");
    node.textContent = text;
    node.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { node.hidden = true; }, 1800);
  }

  function gain(xp) {
    const before = levelIndex();
    state.aura += xp;
    save();
    deps.haptic("medium");
    toast("+" + xp + " Аури");
    render(before);
  }

  function pick(event) {
    const hot = event.target.closest("[data-hot]");
    if (!hot) return;
    open = hot.getAttribute("data-hot");
    deps.haptic("light");
    render();
  }
  $("char-scene").addEventListener("click", pick);
  $("char-scene").addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      pick(event);
    }
  });

  $("char-sheet").addEventListener("click", (event) => {
    const tier = event.target.closest("[data-tier]");
    if (tier) {
      state.tier = tier.getAttribute("data-tier");
      save();
      render();
      return;
    }
    const act = event.target.closest("[data-act]");
    if (!act) return;
    const what = act.getAttribute("data-act");
    if (what === "record" && !todayDone() && !locked()) {
      const tierDef = TIERS.find((item) => item.id === state.tier) || TIERS[1];
      // Today counts toward its own combo, so the third day in a row pays ×1,5.
      const xp = Math.round(tierDef.xp * comboMultiplier(combo() + 1));
      state.done[todayKey()] = { tier: tierDef.id, xp, week: weekNo(), day: dayNo() };
      gain(xp);
    } else if (what === "boss" && !state.boss[weekNo()] && dayNo() === 7 && !locked()) {
      state.boss[weekNo()] = true;
      gain(BOSS_XP);
    } else if (what === "look") {
      open = "look";
      render();
    } else if (what === "hero") {
      open = "hero";
      render();
    } else if (what === "access") {
      deps.openAccess("Нові тижні викликів «Мій персонаж» входять у повний доступ.");
    } else if (what === "sos") {
      deps.openSos();
    }
  });

  $("char-sheet").addEventListener("change", (event) => {
    const field = event.target.closest("[data-look]");
    if (!field) return;
    const key = field.getAttribute("data-look");
    state.look[key] = key === "pet" || key === "form" ? field.value : Number(field.value);
    save();
    render();
  });

  return {
    async show() {
      if (!loaded) await load();
      open = deps.riskActive() ? "hero" : (todayDone() && dayNo() === 7 && !state.boss[weekNo()] ? "door" : "board");
      render();
    },
    async hint() {
      if (!loaded) await load();
      return "Аура " + state.aura + " · " + LEVELS[levelIndex()].name + (todayDone() ? " · виклик дня є" : " · новий виклик дня");
    },
  };
}
