// "Мій персонаж": weekly programs of small challenges, an aura that grows
// with them, and a character who moves to a new place on every level.
// Zero dependencies. The scene is one SVG: a painted location, the aura drawn
// in code, and painted sprites for the character, the pet and the props
// (img/char, generated with gemini-3.1-flash-lite-image, background keyed
// out). State lives in the same storage as the results.
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
// Four ready-made characters, each painted in the six poses below.
const AVATARS = [
  ["Фіолетове худі, вовча стрижка", "a"], ["Рожевий хвіст, синє худі", "b"],
  ["Платинове волосся, чорне худі", "c"], ["Кучері-пучки, помаранчеве худі", "d"],
];
const PETS = [["Маленький дракон", "dragon"], ["Чорний кіт", "cat"], ["Міні-робот", "robot"], ["Нікого", "none"]];
const SPRITES = "img/char/";
const FORMS = [["Він", "m"], ["Вона", "f"]];
// One painted location per level, plus the care-mode nook. Generated with
// gemini-3.1-flash-lite-image as backgrounds only: no people, no text.
const SCENE_IMAGES = ["img/lvl0.jpg", "img/lvl1.jpg", "img/lvl2.jpg", "img/lvl3.jpg", "img/lvl4.jpg"];
SCENE_IMAGES.care = "img/care.jpg";

const TIERS = [
  { id: "light", name: "Легкий", xp: 5 },
  { id: "bold", name: "Сміливий", xp: 10 },
  { id: "epic", name: "Епічний", xp: 20 },
];

const INITIAL = () => ({
  v: 1, start: null, aura: 0, done: {}, boss: {},
  look: { aura: 0, avatar: "a", pet: "dragon", form: "m" }, tier: "bold",
});

export function mountCharacter(deps) {
  const $ = (id) => document.getElementById(id);
  let state = INITIAL();
  let open = "board";
  let loaded = false;

  const g = (male, female) => (state.look.form === "f" ? female : male);

  // Four weekly programs in turn: self-esteem, anxiety, energy and mood, and
  // self-support. Each day has a light, a bold and an epic tier; each week
  // ends with its own boss. The techniques are the ones the bot's practices
  // teach: breathing, grounding, worry time, thought checks, graded steps,
  // behavioural activation, three good things, self-compassion.
  function program() {
    const all = [
      {
        name: "Самооцінка",
        boss: "Зроби те, чого " + g("уникав", "уникала") + " увесь тиждень. Як пройшло, неважливо: важливо, що ти " + g("вийшов", "вийшла") + " назустріч.",
        days: [
          { id: "qualities", title: "Мої якості", sticker: "📖", tiers: ["Назви одну свою якість, яка тобі подобається.", "Назви три якості і приклад до однієї.", "Спитай друга, що він у тобі цінує, і запиши це."] },
          { id: "proof", title: "Докази дня", sticker: "🫙", tiers: ["Згадай одну річ, яка сьогодні вдалася.", "Знайди три докази за день, що ти справляєшся.", "П'ять доказів, і один з них про те, де ти " + g("був сміливим", "була сміливою") + "."] },
          { id: "critic", title: "Відповідь критикові", sticker: "📣", tiers: ["Поміть одну думку критика і назви її: «Це критик, а не правда».", "Відповідай критикові так, як відповів би друг.", "Відповідай уголос, звертаючись до себе на ім'я, і зроби одну дію наперекір критику."] },
          { id: "kindword", title: "Добре слово", sticker: "💬", tiers: ["Згадай комплімент, який тобі зробили.", "На будь-яку похвалу сьогодні відповідай: «Дякую, мені приємно».", "Зроби три щирі компліменти іншим і прийми один без «та нічого»."] },
          { id: "brave", title: "Маленька сміливість", sticker: "⚡", tiers: ["Запиши прогноз: що станеться, якщо зробиш крок.", "Зроби маленький крок: спитай, відмов або попроси.", "Скажи свою думку там, де зазвичай мовчиш."] },
          { id: "wins", title: "Мої досягнення", sticker: "🏆", tiers: ["Згадай одне досягнення за рік.", "По одному досягненню з чотирьох періодів життя.", "Розкажи комусь про головне досягнення, як промову переможця."] },
          { id: "lookback", title: "Погляд збоку", sticker: "👁", tiers: ["Назви одне, чим ти пишаєшся за тиждень.", "Перечитай свій перший запис і скажи, що бачиш хорошого.", "Напиши звернення до себе з першого дня тижня."] },
        ],
      },
      {
        name: "Спокій",
        boss: "Зроби ту справу, яку " + g("відкладав", "відкладала") + " через тривогу. Не ідеально, просто зроби.",
        days: [
          { id: "breath", title: "Дихання-якір", sticker: "🌬", tiers: ["Зроби 5 повільних видихів, довших за вдих.", "Двічі за день по 2 хвилини дихання 4-6.", "Подихай 4-6, коли тривога вже піднялась, і запиши, на скільки вона впала від 0 до 10."] },
          { id: "herenow", title: "Тут і зараз", sticker: "🖐", tiers: ["Назви 5 речей, які бачиш просто зараз.", "Один раз за день зроби повне заземлення 5-4-3-2-1.", "Зроби заземлення в людному або шумному місці, де зазвичай стає тривожно."] },
          { id: "worrytime", title: "Час для тривоги", sticker: "⏰", tiers: ["Запиши всі тривожні думки одним списком.", "Виділи 15 хвилин «часу для тривоги» і відкладай думки до нього.", "Цілий день переноси тривожні думки на свій час і не тривожся поза ним."] },
          { id: "detective", title: "Детектив думок", sticker: "🔍", tiers: ["Запиши одну тривожну думку і оціни, наскільки віриш у неї, від 0 до 100.", "Знайди три факти за цю думку і три проти.", "Перевір прогноз на практиці: зроби крок і подивись, чи справдилось найгірше."] },
          { id: "release", title: "Тіло відпускає", sticker: "🫧", tiers: ["Напружи і відпусти кулаки три рази.", "Розслаб по черзі кулаки, плечі, обличчя, живіт і ноги.", "Зроби розслаблення перед ситуацією, яка зазвичай напружує, і поміть різницю."] },
          { id: "ladder", title: "Сходинка", sticker: "🪜", tiers: ["Склади список із 5 ситуацій, яких уникаєш, від легкої до важкої.", "Зроби найлегшу сходинку і залишайся в ній, поки тривога не впаде наполовину.", "Зроби наступну сходинку, вищу за вчорашню."] },
          { id: "plan", title: "Мій план спокою", sticker: "📓", tiers: ["Назви одну техніку, яка допомогла найбільше.", "Запиши свій план: що робиш, коли тривога росте.", "Розкажи комусь близькому, як ти справляєшся з тривогою."] },
        ],
      },
      {
        name: "Сили",
        boss: "Зроби справу, на яку давно не було сил, і подивись на себе після: ти це " + g("зробив", "зробила") + ".",
        days: [
          { id: "joy", title: "Маленька радість", sticker: "☕", tiers: ["Зроби одну приємну дрібницю на 5 хвилин.", "Заплануй і зроби справу на 15 хвилин, яка колись радувала.", "Поверни заняття, яке ти " + g("покинув", "покинула") + ", хоча б на пів години."] },
          { id: "move", title: "Рух", sticker: "👟", tiers: ["Пройдися 5 хвилин або потягнись під одну пісню.", "10 хвилин руху на свіжому повітрі.", "20 хвилин руху, і запиши, як змінився настрій від 0 до 10."] },
          { id: "done", title: "У мене вийшло", sticker: "✔️", tiers: ["Зроби одну маленьку корисну справу: застели ліжко або вимий чашку.", "Розбий велику справу на три кроки і зроби перший.", "Доведи до кінця справу, яку давно відкладаєш."] },
          { id: "people", title: "Люди поруч", sticker: "🤝", tiers: ["Напиши комусь одне коротке повідомлення.", "Поговори з кимось голосом хоча б 5 хвилин.", "Домовся про зустріч із другом і піди на неї."] },
          { id: "good3", title: "Три добрі речі", sticker: "🌤", tiers: ["Згадай одну добру річ за сьогодні.", "Запиши три добрі речі і чому вони сталися.", "Записуй три добрі речі щовечора до кінця тижня."] },
          { id: "rhythm", title: "Ритм дня", sticker: "🌙", tiers: ["Ляж сьогодні спати на пів години раніше, ніж учора.", "Завтра встань у той самий час, що й сьогодні, і одразу вийди на денне світло.", "Сплануй увесь завтрашній день: сон, їжа, рух, одна приємна і одна корисна справа."] },
          { id: "myweek", title: "Мій тиждень", sticker: "📈", tiers: ["Назви день, коли було трохи краще, і що тоді допомогло.", "Склади список: що дає сили, а що забирає.", "Напиши план на наступний тиждень із трьома справами, які дають сили."] },
        ],
      },
      {
        name: "Опора",
        boss: "Зроби крок, якого боїшся, заради того, що для тебе справді важливо.",
        days: [
          { id: "friend", title: "Друг для себе", sticker: "🫶", tiers: ["Скажи собі одну фразу підтримки, як сказав би найкращий друг.", "Коли картаєш себе, поклади руку на груди і скажи: «Мені зараз важко, так буває»." , "Напиши собі лист підтримки від імені найкращого друга."] },
          { id: "values", title: "Мої цінності", sticker: "🧭", tiers: ["Назви одну річ, яка для тебе справді важлива.", "Обери три цінності і по одному вчинку для кожної.", "Зроби сьогодні вчинок за своєю цінністю, навіть якщо страшно."] },
          { id: "limits", title: "Мої межі", sticker: "🛡", tiers: ["Згадай ситуацію, де хотілося сказати «ні».", "Скажи «ні» в дрібниці, де зазвичай погоджуєшся.", "Спокійно скажи про свою потребу людині, з якою зазвичай мовчиш."] },
          { id: "mistake", title: "Помилка як досвід", sticker: "🧩", tiers: ["Згадай помилку, з якої ти чогось " + g("навчився", "навчилася") + ".", "Розбери помилку тижня, як тренер: що вийшло і що змінити.", "Навмисно зроби щось неідеально і переконайся, що світ не завалився."] },
          { id: "strengths", title: "Сильні сторони", sticker: "💪", tiers: ["Назви одну свою сильну сторону.", "Спитай двох людей, у чому ти " + g("сильний", "сильна") + ".", "Використай свою сильну сторону по-новому і розкажи, що вийшло."] },
          { id: "care", title: "Турбота про тіло", sticker: "🛁", tiers: ["Зроби одну річ для тіла: вода, душ, крем.", "Влаштуй собі годину турботи без телефону.", "Скажи щось добре своєму тілу перед дзеркалом."] },
          { id: "portrait", title: "Мій портрет", sticker: "🖼", tiers: ["Опиши себе трьома добрими словами.", "Порівняй себе із собою місяць тому: що змінилося.", "Запиши звернення до себе через рік."] },
        ],
      },
    ];
    return all[(weekNo() - 1) % all.length];
  }
  const week = () => program().days;
  const BOSS_XP = 50;
  const bossText = () => program().boss;
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
      // Records from before the painted characters chose hair and hoodie.
      delete state.look.hair;
      delete state.look.fit;
      if (!AVATARS.some((item) => item[1] === state.look.avatar)) state.look.avatar = "a";
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

  const rect = (x, y, w, h, rx, fill, extra) => '<rect x="' + r1(x) + '" y="' + r1(y) + '" width="' + r1(w) + '" height="' + r1(h) + '" rx="' + rx + '" fill="' + fill + '"' + (extra || "") + "/>";
  const circle = (x, y, r, fill, extra) => '<circle cx="' + r1(x) + '" cy="' + r1(y) + '" r="' + r + '" fill="' + fill + '"' + (extra || "") + "/>";
  const ellipse = (x, y, rx, ry, fill, extra) => '<ellipse cx="' + r1(x) + '" cy="' + r1(y) + '" rx="' + rx + '" ry="' + ry + '" fill="' + fill + '"' + (extra || "") + "/>";
  const path = (d, fill, extra) => '<path d="' + d + '" fill="' + fill + '"' + (extra || "") + "/>";
  const stroke = (d, color, width, extra) => '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="' + width + '" stroke-linecap="round" stroke-linejoin="round"' + (extra || "") + "/>";
  const flame = (x, y, s, fill) => '<path class="flame" d="M' + r1(x) + " " + r1(y + s) + " Q" + r1(x - s * 0.85) + " " + r1(y) + " " + r1(x) + " " + r1(y - s * 1.7) + " Q" + r1(x + s * 0.85) + " " + r1(y) + " " + r1(x) + " " + r1(y + s) + 'Z" fill="' + fill + '"/>';
  // A painted sprite in a box, anchored to the box's bottom centre.
  const sprite = (name, x, y, w, h, extra) => '<image href="' + SPRITES + name + '.png" x="' + r1(x) + '" y="' + r1(y) + '" width="' + r1(w) + '" height="' + r1(h) + '" preserveAspectRatio="xMidYMax meet"' + (extra || "") + "/>";

  // A plain gradient under the painted location, shown while it loads.
  function backdrop(level, risk) {
    const tops = ["#2B1B4E", "#2B1B4E", "#3A1D3A", "#0B0F30", "#1A0E33"];
    const top = risk ? "#3B2A40" : tops[level];
    return '<linearGradient id="gBase" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + top + '"/><stop offset="1" stop-color="#120B22"/></linearGradient>' +
      '<rect width="400" height="260" fill="url(#gBase)"/>';
  }

  // The props you tap sit in the same places in every location.
  function hotspots(level) {
    const ping = (x, y) => '<circle class="ping" cx="' + x + '" cy="' + y + '" r="7" fill="none"/>';
    let s = '<g data-hot="board" tabindex="0" role="button" aria-label="Дошка викликів">' +
      sprite("board", 14, 54, 92, 62) + (todayDone() ? "" : ping(92, 64)) + "</g>";
    // The sticker panel shows this week's catch in its eight slots.
    const got = weekDone().length + (state.boss[weekNo()] ? 1 : 0);
    s += '<g data-hot="stickers" tabindex="0" role="button" aria-label="Стіна стікерів">' + sprite("panel", 112, 30, 76, 45);
    for (let i = 0; i < 8; i++) {
      const cx = 112 + 76 * (0.18 + 0.213 * (i % 4));
      const cy = 30 + 45 * (i < 4 ? 0.33 : 0.67);
      if (i < got) s += circle(cx, cy, 5, ["#FF4FA3", "#2EE6D6", "#FFC93C", "#B6FF3C"][i % 4], ' filter="url(#neon)"');
    }
    s += "</g>";
    const bossReady = dayNo() === 7 && !state.boss[weekNo()];
    const open = bossReady || state.boss[weekNo()];
    s += '<g data-hot="door" tabindex="0" role="button" aria-label="Двері до боса">' +
      sprite(open ? "door-open" : "door", 326, 84, 64, 150) + (bossReady ? ping(358, 160) : "") + "</g>";
    const lvl = LEVELS[level];
    const next = LEVELS[level + 1];
    const share = next ? (state.aura - lvl.at) / (next.at - lvl.at) : 1;
    // The crystal glows brighter as the next level comes closer.
    s += '<g data-hot="crystal" tabindex="0" role="button" aria-label="Кристал аури"><g class="pulse">' +
      circle(304, 62, 20, auraColor(), ' opacity="' + (0.15 + 0.35 * share).toFixed(2) + '"') +
      sprite("crystal", 289, 36, 30, 50, ' opacity="' + (0.6 + 0.4 * share).toFixed(2) + '"') + "</g></g>";
    return s;
  }

  // ---------------------------------------------------------------- the character

  function pose(level, risk) {
    if (risk) return "safe";
    return ["sit", "stand", "skate", "pockets", "victory"][level];
  }

  function character(level, risk) {
    const p = pose(level, risk);
    const seated = p === "sit" || p === "safe";
    // Seated poses are wider and lower; standing ones fill the height.
    const h = seated ? 128 : 160;
    const w = seated ? 150 : 130;
    const avatar = AVATARS.some((item) => item[1] === state.look.avatar) ? state.look.avatar : "a";
    return '<g style="filter: drop-shadow(0 0 4px ' + auraColor() + ')">' + sprite(avatar + "-" + p, 200 - w / 2, 240 - h, w, h) + "</g>";
  }

  function auraLayer(level, risk) {
    const aura = auraColor();
    const seated = pose(level, risk) === "sit" || risk;
    const cy = seated ? 180 : 160;
    if (risk) return circle(200, cy, 70, "url(#gAura)", ' opacity="0.5"');
    let s = circle(200, cy, [40, 70, 95, 120, 160][level], "url(#gAura)", ' opacity="' + [0.55, 0.6, 0.7, 0.8, 0.9][level] + '"');
    if (level >= 3) {
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2;
        s += stroke("M" + r1(200 + Math.cos(a) * 60) + " " + r1(cy + Math.sin(a) * 70) + " L" + r1(200 + Math.cos(a) * (level === 4 ? 150 : 115)) + " " + r1(cy + Math.sin(a) * (level === 4 ? 140 : 108)), aura, 3, ' opacity="0.4"');
      }
    }
    if (level >= 1) {
      const spots = level === 1 ? [[150, 222, 6], [250, 222, 6], [142, 206, 4], [258, 206, 4]] :
        [[140, 130, 9], [260, 130, 9], [130, 170, 10], [270, 170, 10], [140, 214, 9], [260, 214, 9], [168, 96, 8], [232, 96, 8], [200, 74, 10]];
      let flames = "";
      spots.forEach(([x, y, size]) => { flames += flame(x, y, size * (level === 4 ? 1.4 : 1), aura); });
      s += '<g filter="url(#neon)" opacity="0.85">' + flames + "</g>";
    }
    for (let i = 0; i < level * 5; i++) s += '<circle class="mote" cx="' + (130 + (i * 47) % 140) + '" cy="' + (220 - (i * 29) % 100) + '" r="1.8" fill="#FFFFFF" style="animation-delay:' + (i * 0.37).toFixed(2) + 's"/>';
    return s;
  }

  function companion() {
    const kind = state.look.pet;
    if (kind === "none" || !PETS.some((item) => item[1] === kind)) return "";
    return '<g data-hot="pet" tabindex="0" role="button" aria-label="Компаньйон">' + ellipse(294, 236, 26, 5, "#000000", ' opacity="0.3"') +
      sprite("pet-" + kind, 262, 178, 64, 60) + "</g>";
  }

  function sceneSvg() {
    const level = levelIndex();
    const risk = deps.riskActive();
    const aura = auraColor();
    const defs = "<defs>" +
      '<filter id="neon" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
      '<radialGradient id="gAura"><stop offset="0" stop-color="' + aura + '" stop-opacity="0.9"/><stop offset="0.55" stop-color="' + aura + '" stop-opacity="0.35"/><stop offset="1" stop-color="' + aura + '" stop-opacity="0"/></radialGradient>' +
      '<linearGradient id="gWash" x1="0" y1="0" x2="0" y2="1"><stop offset="0.45" stop-color="#0D0918" stop-opacity="0"/><stop offset="1" stop-color="#0D0918" stop-opacity="0.55"/></linearGradient>' +
      "</defs>";
    const label = risk ? "Персонаж у затишному місці, загорнутий у плед, з какао." : "Рівень " + LEVELS[level].name + ": " + LEVELS[level].place + ".";
    const picture = risk ? SCENE_IMAGES.care : SCENE_IMAGES[level];
    return '<svg viewBox="0 0 400 260" role="img" aria-label="' + label + '">' + defs + backdrop(level, risk) +
      '<image href="' + picture + '" x="0" y="0" width="400" height="260" preserveAspectRatio="xMidYMid slice"/>' +
      '<rect width="400" height="260" fill="url(#gWash)"/>' + auraLayer(level, risk) +
      (risk ? "" : hotspots(level)) + companion() + ellipse(200, 240, 50, 7, "#000000", ' opacity="0.35"') +
      '<g data-hot="hero" tabindex="0" role="button" aria-label="Персонаж">' + character(level, risk) + "</g></svg>";
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
        return '<span class="eyebrow">День ' + dayNo() + " з 7 · виконано</span>" + '<div class="won">' + stickerImg(task.id) +
          "<h2>" + esc(task.title) + ": " + tier.name.toLowerCase() + " рівень пройдено</h2></div>" +
          "<p>+" + done.xp + " Аури і новий стікер на стіні. Наступний виклик завтра." + (dayNo() === 7 && !state.boss[weekNo()] ? " А зараз двері до боса відчинені." : "") + "</p>";
      }
      const next = comboMultiplier(count + 1);
      return '<span class="eyebrow">' + program().name + " · день " + dayNo() + " з 7</span><h2>" + esc(task.title) + "</h2>" +
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
      const all = tasks.map((item, index) => [item.id, item.title, Boolean(doneDays[index + 1])])
        .concat([[bossSticker(), "Бос тижня", Boolean(state.boss[weekNo()])]]);
      return '<span class="eyebrow">Стіна стікерів · ' + program().name + "</span><h2>Зібрано " + all.filter((item) => item[2]).length + " з 8</h2>" +
        '<div class="stickers">' + all.map(([id, title, got]) => '<div class="sticker' + (got ? " got" : "") + '">' + stickerImg(id) + esc(title) + "</div>").join("") + "</div>";
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

  function stickerImg(id) {
    return '<img class="e" src="' + SPRITES + "st-" + id + '.png" alt="" loading="lazy">';
  }
  const bossSticker = () => "boss" + (((weekNo() - 1) % 4) + 1);

  // Pictures to tap rather than lists to read: characters, pets, aura colours.
  function lookHtml() {
    const choice = (key, value, label, inner) => '<button type="button" class="pick" data-pick="' + key + '" data-value="' + value + '" aria-pressed="' +
      (String(state.look[key]) === String(value)) + '" aria-label="' + esc(label) + '">' + inner + "</button>";
    const avatars = AVATARS.map(([label, id]) => choice("avatar", id, label, '<img src="' + SPRITES + id + '-stand.png" alt="">')).join("");
    const pets = PETS.map(([label, id]) => choice("pet", id, label, id === "none"
      ? '<span class="none">Нікого</span>' : '<img src="' + SPRITES + "pet-" + id + '.png" alt="">')).join("");
    const auras = AURAS.map(([label, color], index) => choice("aura", index, label + " аура", '<i style="background:' + color + '"></i>')).join("");
    const forms = FORMS.map(([label, id]) => choice("form", id, label, "<span>" + label + "</span>")).join("");
    return '<span class="eyebrow">Вигляд</span><h2>Твій персонаж</h2>' +
      '<div class="picks avatars">' + avatars + "</div>" +
      '<span class="eyebrow">Компаньйон</span><div class="picks pets">' + pets + "</div>" +
      '<span class="eyebrow">Колір аури</span><div class="picks auras">' + auras + "</div>" +
      '<span class="eyebrow">Звертатися до тебе як</span><div class="picks forms">' + forms + "</div>" +
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

  // Picture choices in the look editor; registered first so a tap on one
  // never reaches the act buttons.
  $("char-sheet").addEventListener("click", (event) => {
    const pickNode = event.target.closest("[data-pick]");
    if (!pickNode) return;
    const key = pickNode.getAttribute("data-pick");
    const value = pickNode.getAttribute("data-value");
    state.look[key] = key === "aura" ? Number(value) : value;
    deps.haptic("light");
    save();
    render();
  }, true);

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
