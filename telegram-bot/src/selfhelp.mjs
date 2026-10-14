// Self-help content shared by the chat and the Mini App: short practices, the
// "Мені зараз погано" steps, the mood check-in scale and its tags, and the
// consultation booking options. User-facing text is Ukrainian. Zero
// dependencies. Node 16+ and browsers.
//
// Like instruments.mjs, this file is copied byte for byte into webapp/ by
// webapp/build.mjs, and a test fails when the copy is stale, so the chat and
// the window can never word a practice differently.

export const PRACTICES = {
  breathing: {
    title: "Дихання 4-6",
    steps: [
      "Сядьте зручно і поставте стопи на підлогу.",
      "Вдихніть носом на 4 рахунки.",
      "Повільно видихніть ротом на 6 рахунків.",
      "Повторіть 5-10 разів. Довший видих допомагає тілу заспокоїтися.",
    ],
  },
  grounding: {
    title: "Заземлення 5-4-3-2-1",
    steps: [
      "Назвіть подумки 5 речей, які бачите.",
      "Потім 4 речі, яких можете торкнутися.",
      "3 звуки, які чуєте.",
      "2 запахи і 1 смак.",
      "Це повертає увагу в теперішній момент, коли думки або спогади затягують.",
    ],
  },
  activation: {
    title: "Маленька приємна справа",
    steps: [
      "Оберіть одну невелику справу на 10-15 хвилин: прогулянка, музика, душ, чай біля вікна.",
      "Зробіть її, навіть якщо зараз не хочеться. Настрій часто приходить слідом за дією, а не навпаки.",
      "Помітьте, як Ви почуваєтеся після.",
    ],
  },
  connect: {
    title: "Зв'язок з людьми",
    steps: [
      "Напишіть або зателефонуйте комусь, кому довіряєте.",
      "Не обов'язково говорити про складне: навіть коротка розмова зменшує відчуття самотності.",
    ],
  },
  sleep: {
    title: "Підготовка до сну",
    steps: [
      "Лягайте і вставайте приблизно в один і той самий час, навіть у вихідні.",
      "За годину до сну відкладіть новини і телефон, приглушіть світло.",
      "Якщо не вдається заснути понад 20 хвилин, встаньте і займіться чимось спокійним, " +
        "поки не захочеться спати.",
    ],
  },
  muscles: {
    title: "Розслаблення м'язів",
    steps: [
      "Сядьте зручно.",
      "По черзі напружте на 5 секунд і відпустіть: кулаки, плечі, обличчя, живіт, ноги.",
      "Помічайте різницю між напруженням і розслабленням.",
    ],
  },
  worry: {
    title: "Час для тривоги",
    steps: [
      "Оберіть щодня 15 хвилин, наприклад о 18:00, коли можна тривожитися навмисно.",
      "Коли тривожна думка приходить раніше, запишіть її одним рядком і скажіть собі: «Повернуся до цього о шостій».",
      "У свій час перегляньте список. Для кожної думки спитайте: чи можу я щось зробити? Якщо так, запишіть один крок. Якщо ні, відпустіть.",
      "Після 15 хвилин закрийте список і займіться чимось руками. Тривога вчиться чекати свого часу.",
    ],
  },
  thought: {
    title: "Перевірка думки",
    steps: [
      "Запишіть думку, від якої стало гірше, наприклад: «Я все зіпсую».",
      "Які факти її підтверджують? Які факти їй суперечать?",
      "Що сказали б Ви другові з такою думкою?",
      "Сформулюйте більш збалансовану думку і помітьте, як змінилося почуття від 0 до 10.",
    ],
  },
  approach: {
    title: "Маленький крок назустріч страху",
    steps: [
      "Оберіть ситуацію, якої уникаєте, і розбийте її на сходинки від найлегшої до найважчої.",
      "Почніть з тієї, що викликає тривогу приблизно на 3-4 з 10.",
      "Залишайтеся в ній, поки тривога не знизиться хоча б наполовину. Не тікайте на піку.",
      "Повторюйте ту саму сходинку кілька днів, а потім переходьте до наступної.",
    ],
  },
  mastery: {
    title: "День з опорою",
    steps: [
      "Заплануйте на завтра одну приємну справу і одну справу, після якої буде відчуття «у мене вийшло».",
      "Обидві мають бути маленькими: 10-20 хвилин, без підготовки.",
      "Увечері оцініть від 0 до 10, наскільки було приємно і наскільки вийшло.",
      "Помічайте, які справи дають більше сил, і ставте їх у план частіше.",
    ],
  },
  movement: {
    title: "10 хвилин руху",
    steps: [
      "Вийдіть на коротку прогулянку або увімкніть одну пісню і порухайтеся під неї.",
      "Темп довільний, головне почати. Навіть кілька хвилин руху трохи піднімають настрій і знижують напруження.",
      "Після помітьте, що змінилося в тілі і в думках.",
    ],
  },
  goodthings: {
    title: "Три добрі речі",
    steps: [
      "Перед сном запишіть три речі, які сьогодні були хоч трохи добрими.",
      "Це можуть бути дрібниці: смачний чай, повідомлення від друга, сонце у вікні.",
      "Біля кожної допишіть, чому вона сталася або яку роль у ній відіграли Ви.",
      "Повторюйте тиждень: увага поступово вчиться помічати не лише погане.",
    ],
  },
  selfkind: {
    title: "Добре слово собі",
    steps: [
      "Коли картаєте себе, покладіть руку на груди або на плече.",
      "Скажіть собі: «Мені зараз важко. Так буває з усіма людьми».",
      "Додайте те, що сказали б близькій людині в такій самій ситуації.",
      "Помітьте, що змінилося. Підтримка не робить слабшим, вона дає сили спробувати знову.",
    ],
  },
  critic: {
    title: "Відповідь внутрішньому критику",
    steps: [
      "Помітьте різку думку про себе, наприклад: «Я нікчема».",
      "Назвіть її: «Це говорить критик, а не правда про мене».",
      "Знайдіть один факт, який їй суперечить: що Вам вдалося за останній тиждень?",
      "Сформулюйте справедливу відповідь, як сказав би друг, і запишіть її.",
    ],
  },
};

// Two practices per scale, the first the one most likely to help right away.
const PRACTICES_FOR = {
  gad7: ["breathing", "worry"],
  phq9: ["activation", "mastery"],
  sleep: ["sleep", "breathing"],
  stress: ["muscles", "breathing"],
  pcl5: ["grounding", "breathing"],
  wellbeing: ["activation", "goodthings"],
  selfesteem: ["critic", "selfkind"],
  mood: ["activation", "breathing"],
};

export const PRACTICE_IDS = Object.keys(PRACTICES);

export function getPractice(id) {
  return Object.prototype.hasOwnProperty.call(PRACTICES, id) ? PRACTICES[id] : null;
}

// Practices for a scale id or "mood"; an unknown key falls back to breathing
// and grounding, which suit almost any state.
export function practicesFor(key) {
  const ids = Object.prototype.hasOwnProperty.call(PRACTICES_FOR, key) ? PRACTICES_FOR[key] : ["breathing", "grounding"];
  return ids.map((id) => Object.assign({ id }, PRACTICES[id]));
}

// "Мені зараз погано". Short, one step at a time, and it always ends with
// people: emergency services first, then whoever the bot is configured with.
export const SOS_BUTTON = "🆘 Мені зараз погано";
export const SOS_TITLE = "Ви не самі";
export const SOS_INTRO = "Давайте зробимо кілька кроків просто зараз, по одному.";
export const SOS_STEPS = [
  { title: "Подих", text: "Вдих носом на 4 рахунки, повільний видих на 6. П'ять разів." },
  {
    title: "Опора",
    text: "Поставте стопи на підлогу і відчуйте, як вона Вас тримає. Назвіть подумки 5 речей, " +
      "які бачите, 4, яких можете торкнутися, 3 звуки, які чуєте.",
  },
  {
    title: "Люди",
    text: "Напишіть або зателефонуйте комусь, кому довіряєте. Можна просто сказати: " +
      "«Мені зараз важко, побудь зі мною».",
  },
];
export const SOS_EMERGENCY = "Якщо є загроза життю, телефонуйте 103 або 112.";

export function isSosText(text) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  return trimmed === SOS_BUTTON || trimmed === SOS_BUTTON.replace(/^\S+\s/, "");
}

// Daily mood check-in: one tap from 1 to 10, then optional tags.
export const MOOD_MIN = 1;
export const MOOD_MAX = 10;
// At or below this the check-in offers a practice, and at or below the crisis
// line it also points to the SOS steps.
export const MOOD_LOW = 4;
export const MOOD_CRISIS = 2;
export const MOOD_TAGS = [
  { id: "sleep", label: "Сон" },
  { id: "work", label: "Робота" },
  { id: "people", label: "Стосунки" },
  { id: "news", label: "Новини" },
  { id: "health", label: "Здоров'я" },
  { id: "money", label: "Гроші" },
];

export function moodTag(id) {
  return MOOD_TAGS.find((tag) => tag.id === id) || null;
}

// Consultation request. The bot never sends it: the person gets a prefilled
// draft to the configured contact and presses send themselves.
export const BOOKING_FORMATS = [
  { id: "online", label: "Онлайн" },
  { id: "offline", label: "Очно" },
  { id: "any", label: "Ще не знаю" },
];
export const BOOKING_TIMES = [
  { id: "morning", label: "Ранок" },
  { id: "day", label: "День" },
  { id: "evening", label: "Вечір" },
  { id: "weekend", label: "Вихідні" },
  { id: "any", label: "Будь-коли" },
];
export const MAX_BOOKING_REQUEST = 300;

export function bookingOption(list, id) {
  return list.find((option) => option.id === id) || null;
}
