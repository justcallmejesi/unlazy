// Ukrainian user-facing copy and message formatting. Zero dependencies. Node 16+.
//
// Every dynamic value is escaped before it enters an HTML-parsed message, so a
// display name or a stored answer can never inject markup.

import { clipText, escapeHtml } from "./telegram.mjs";
import {
  FREE_INSTRUMENT_LIST, INSTRUMENT_LIST, PAID_INSTRUMENT_LIST, interpretResult, severityOf,
} from "./instruments.mjs";
import { formatLocalDateTime, formatTimeOfDay, formatUtcOffset, offsetAt } from "./reminders.mjs";
import { MAX_NOTE_LENGTH } from "./store.mjs";
import {
  BOOKING_FORMATS, BOOKING_TIMES, MOOD_CRISIS, MOOD_LOW, MOOD_TAGS, PRACTICE_IDS, PRACTICES, SOS_BUTTON,
  SOS_EMERGENCY, SOS_INTRO, SOS_STEPS, SOS_TITLE, bookingOption, moodTag,
} from "./selfhelp.mjs";

// Nominative for naming the day, and the "every Monday" adverb form.
export const WEEKDAY_NAMES = [
  { name: "неділя", every: "щонеділі" },
  { name: "понеділок", every: "щопонеділка" },
  { name: "вівторок", every: "щовівторка" },
  { name: "середа", every: "щосереди" },
  { name: "четвер", every: "щочетверга" },
  { name: "п'ятниця", every: "щоп'ятниці" },
  { name: "субота", every: "щосуботи" },
];

export function weekdayWords(schedule) {
  const index = schedule && Number.isInteger(schedule.weekday) ? schedule.weekday : 1;
  return WEEKDAY_NAMES[((index % 7) + 7) % 7];
}

// Dates are rendered in the offset that was in effect at that very instant, so
// a result taken in summer keeps its summer wall-clock time after the October
// transition.
function stampIn(schedule, timestampMs) {
  return formatLocalDateTime(timestampMs, offsetAt(schedule, timestampMs));
}

function dateIn(schedule, timestampMs) {
  return stampIn(schedule, timestampMs).split(" ")[0];
}

export const DISCLAIMER =
  "Опитувальники GAD-7 і PHQ-9 це інструменти самоспостереження, а не діагноз. " +
  "Підсумковий бал не замінює консультацію лікаря або психотерапевта.";

export const COMMANDS = [
  { command: "app", description: "Відкрити застосунок у вікні" },
  { command: "gad7", description: "Пройти GAD-7 (тривога, 7 питань)" },
  { command: "phq9", description: "Пройти PHQ-9 (настрій, 9 питань)" },
  { command: "sleep", description: "Щоденник сну (7 питань)" },
  { command: "stress", description: "Рівень напруження (8 питань)" },
  { command: "pcl5", description: "PCL-5: посттравматичний стрес (20 питань)" },
  { command: "wellbeing", description: "Самопочуття: ресурс і опора (6 питань)" },
  { command: "mood", description: "Відмітити настрій сьогодні (повний доступ)" },
  { command: "selfhelp", description: "Техніки самодопомоги" },
  { command: "sos", description: "Мені зараз погано" },
  { command: "report", description: "Звіт для фахівця" },
  { command: "book", description: "Записатися на консультацію" },
  { command: "privacy", description: "Мої згоди на передачу даних фахівцю" },
  { command: "psy", description: "Кабінет фахівця: для психологів" },
  { command: "clients", description: "Мої клієнти (кабінет фахівця)" },
  { command: "invite", description: "Посилання для клієнтів (кабінет фахівця)" },
  { command: "results", description: "Історія результатів (повний доступ)" },
  { command: "last", description: "Останні результати (повний доступ)" },
  { command: "remind", description: "Нагадування (повний доступ)" },
  { command: "tz", description: "Часовий пояс: auto або, наприклад, /tz +3" },
  { command: "export", description: "Вивантажити мої дані у JSON" },
  { command: "delete", description: "Видалити всі мої дані" },
  { command: "cancel", description: "Перервати поточний опитувальник" },
  { command: "buy", description: "Повний доступ: шкали сну і стресу" },
  { command: "contact", description: "Звернутися за допомогою" },
  { command: "paysupport", description: "Питання щодо оплати і повернення" },
  { command: "about", description: "Про тести і про те, що зберігає бот" },
  { command: "help", description: "Список команд" },
];

export function crisisBlock(crisisContact) {
  return [
    "⚠️ <b>Важливо</b>",
    "Ви позначили думки про смерть або про те, щоб завдати собі шкоди. Будь ласка, не залишайтеся з цим наодинці.",
    escapeHtml(crisisContact),
    "Якщо є загроза життю прямо зараз, телефонуйте до екстрених служб.",
  ].join("\n");
}

export function greeting(name, schedule, options = {}) {
  const hello = name ? "Привіт, " + escapeHtml(name) + "!" : "Привіт!";
  const words = weekdayWords(schedule);
  const extra = options.extra || "";
  return [
    hello,
    "",
    "Я допомагаю регулярно відстежувати стан за короткими опитувальниками:",
  ].concat(INSTRUMENT_LIST.map((instrument) => "• <b>" + escapeHtml(instrument.title) + "</b>: " +
    escapeHtml(instrument.subtitle) + ", " + instrument.items.length + " " + questionWord(instrument.items.length)), [
    "",
    "Ще тут є щоденна відмітка настрою /mood, техніки самодопомоги /selfhelp і звіт для фахівця /report.",
    "Якщо зараз важко: кнопка «" + escapeHtml(SOS_BUTTON) + "» під полем введення або /sos.",
    "",
    options.remindersActive
      ? "Результати зберігаються, щоб Ви бачили динаміку. " +
        escapeHtml(words.every.charAt(0).toUpperCase() + words.every.slice(1)) + " я нагадаю пройти тести знову."
      : "Результати зберігаються. Історія, статистика і щотижневе нагадування входять у повний доступ.",
    "",
    DISCLAIMER,
    extra ? "" : null,
    extra || null,
    "",
    "Команди: /help",
  ]).filter((line) => line !== null).join("\n");
}

function questionWord(count) {
  const last = count % 10;
  const lastTwo = count % 100;
  if (last === 1 && lastTwo !== 11) return "питання";
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return "питання";
  return "питань";
}

export function helpText() {
  const lines = COMMANDS.map((entry) => "/" + entry.command + " " + entry.description);
  return ["<b>Команди</b>", ""].concat(lines).join("\n");
}

export function aboutText(reminderLine) {
  return [
    "<b>Про опитувальники</b>",
    "",
    "<b>GAD-7</b>: скринінг генералізованої тривоги. Діапазон від 0 до 21 бала.",
    "0 до 4 мінімальна, 5 до 9 легка, 10 до 14 помірна, 15 до 21 виражена тривога.",
    "",
    "<b>PHQ-9</b>: скринінг депресивної симптоматики. Діапазон від 0 до 27 балів.",
    "0 до 4 мінімальні, 5 до 9 легкі, 10 до 14 помірні, 15 до 19 помірно тяжкі, 20 до 27 тяжкі прояви.",
    "Десяте питання про те, наскільки симптоми ускладнювали життя, не входить у суму балів.",
    "",
    "Бал 10 і вище в GAD-7 або PHQ-9 прийнято вважати підставою обговорити стан із фахівцем.",
    "",
    "<b>Сон</b> і <b>Стрес</b> це власні шкали самоспостереження цього бота, а не валідовані опитувальники. " +
      "Вони показують динаміку, але не є скринінгом.",
    "Сон: 0 до 28 балів. 0 до 6 спокійно, 7 до 13 легкі порушення, 14 до 20 помірні, 21 до 28 виражені.",
    "Стрес: 0 до 32 балів. 0 до 9 низький, 10 до 19 помірний, 20 до 32 високий. Два питання враховуються " +
      "навпаки, щоб згода з усім не давала високий бал сама собою.",
    "",
    "<b>PCL-5</b>: скринінг посттравматичного стресу, 20 питань про останній місяць. Діапазон від 0 до 80 балів, " +
      "33 і вище прийнято вважати підставою звернутися до фахівця. Опитувальник у відкритому доступі.",
    "",
    "<b>Самопочуття</b>: власна шкала бота, 6 питань про ресурс і опору, від 0 до 24 балів. Тут вищий бал " +
      "означає кращий стан: 0 до 8 низьке, 9 до 16 помірне, 17 до 24 добре самопочуття.",
    "",
    "<b>Що зберігає бот</b>",
    "Ваш ідентифікатор чату, відповіді та бали кожного проходження, налаштування нагадувань.",
    "Дані потрібні лише для показу динаміки. /export вивантажує їх, /delete видаляє повністю.",
    "Фахівець бачить Ваші результати лише за Вашою згодою. Переглянути або відкликати її: /privacy.",
    "",
    reminderLine,
    "",
    DISCLAIMER,
  ].join("\n");
}

export function starWord(stars) {
  const last = stars % 10;
  const tens = stars % 100;
  if (tens >= 11 && tens <= 14) return "зірок";
  if (last === 1) return "зірка";
  if (last >= 2 && last <= 4) return "зірки";
  return "зірок";
}

export function priceLine(price) {
  return price.stars + " " + starWord(price.stars) + " одноразово, без підписки";
}

export function trialNotice(entitlementState, price) {
  if (entitlementState.kind !== "trial") return "";
  return "Безкоштовний період: залишилося днів " + entitlementState.daysLeft +
    ". Далі повний доступ коштує " + priceLine(price) + ".";
}

// Shown when a locked feature is asked for. Says plainly what stays free.
export function paywall(price, entitlementState) {
  const lines = ["<b>Повний доступ</b>", ""];
  if (entitlementState.kind === "expired") {
    lines.push("Безкоштовний період закінчився.");
  } else {
    lines.push("Ця частина входить у повний доступ.");
  }
  lines.push("");
  lines.push("<b>Що відкривається</b>");
  PAID_INSTRUMENT_LIST.forEach((instrument) => {
    lines.push("• " + escapeHtml(instrument.title) + ": " + escapeHtml(instrument.subtitle));
  });
  lines.push("• щоденна відмітка настрою з графіком");
  lines.push("• історія всіх проходжень і статистика з графіками");
  lines.push("• щотижневе нагадування і його налаштування");
  lines.push("");
  lines.push("<b>Що назавжди безкоштовно</b>");
  FREE_INSTRUMENT_LIST.forEach((instrument) => {
    lines.push("• " + escapeHtml(instrument.title) + ": " + escapeHtml(instrument.subtitle) + ", сам тест і результат");
  });
  lines.push("• блок підтримки, якщо в PHQ-9 позначено ризик");
  lines.push("• техніки самодопомоги і кнопка «Мені зараз погано»");
  lines.push("• звіт для фахівця і запис на консультацію");
  lines.push("• /export і /delete: Ваші дані завжди Ваші");
  lines.push("");
  lines.push("Ціна: <b>" + escapeHtml(priceLine(price)) + "</b>. Оплата зірками Telegram.");
  return lines.join("\n");
}

export function buyKeyboard(price) {
  return {
    inline_keyboard: [[{
      text: "Відкрити повний доступ за " + price.stars + " " + starWord(price.stars),
      callback_data: "pay|start",
    }]],
  };
}

export function purchaseThanks(price) {
  return [
    "Дякую, повний доступ відкрито назавжди.",
    "",
    "Тепер доступні " + listWords(PAID_INSTRUMENT_LIST.map((instrument) => instrument.title)) +
      ", відмітка настрою, повна історія і статистика за всіма шкалами.",
    "",
    "Питання щодо оплати: /paysupport",
  ].join("\n");
}

// "А, Б і В": commas, then one "і" before the last item.
function listWords(items) {
  if (items.length <= 1) return items.join("");
  return items.slice(0, -1).join(", ") + " і " + items[items.length - 1];
}

export function alreadyPro() {
  return "Повний доступ уже відкритий. Дякую, що підтримали бота.";
}

// Everything a refund needs: refundStarPayment takes the user id and the
// charge id. `charges` are labelled lines, empty when nothing was paid.
export function paySupportDraft(botUsername, chatId, charges) {
  return [
    "Вітаю! Питання щодо оплати в боті" + (botUsername ? " @" + botUsername : "") + ".",
    "Мій id: " + chatId + ".",
    charges.length ? "Платежі: " + charges.join("; ") + "." : "Платежів поки немає.",
  ].join("\n");
}

export function paySupportKeyboard(owner, draft) {
  return {
    inline_keyboard: [[{
      text: "Написати про оплату",
      url: "https://t.me/" + owner + "?text=" + encodeURIComponent(clipText(draft, 600)),
    }]],
  };
}

// Two invoices can both pass the pre-checkout before either payment lands.
// The first purchase stays on record; this one is to be refunded.
export function duplicatePurchase(chargeId) {
  return "Повний доступ уже був відкритий, тому цей платіж зайвий. Зірки повернуться: напишіть через " +
    "/paysupport і додайте номер платежу: <code>" + escapeHtml(chargeId) + "</code>";
}

// A message the person can read, edit and send themselves. Telegram never
// sends it automatically, which is exactly right for health data: the prefill
// is a draft, the send is their decision.
export function helpRequestText(store, chatId, schedule) {
  return ["Вітаю! Я пройшов опитувальники в боті і хотів би звернутися за допомогою.", "", "Мої результати:"]
    .concat(latestScoreLines(store, chatId, schedule)).join("\n");
}

// The latest run of every scale, one plain line each, for a draft the person
// sends themselves.
export function latestScoreLines(store, chatId, schedule) {
  const lines = [];
  INSTRUMENT_LIST.forEach((instrument) => {
    const entry = store.lastResult(chatId, instrument.id);
    if (!entry) return;
    const shape = describe(instrument, entry);
    lines.push(instrument.title + " (" + instrument.subtitle + "): " + entry.score + " з " + shape.maxScore +
      ", " + shape.severity + ", " + dateIn(schedule, Date.parse(entry.completedAt)));
  });
  return lines;
}

export function helpOffer(contact, requestText) {
  const who = contact.name || "@" + contact.username;
  const role = contact.role ? " (" + contact.role + ")" : "";
  return [
    "<b>Можна не розбиратися з цим самому</b>",
    "",
    // Phrased with a colon so the name never needs declining: "напишіть
    // Олексій" is the wrong case, and the bot cannot decline arbitrary names.
    "Якщо хочете обговорити ці результати з живою людиною, ось контакт: " +
      escapeHtml(who) + escapeHtml(role) + ".",
    "Кнопка нижче відкриє чат із уже готовим повідомленням: Ви побачите текст, зможете його змінити і надішлете самі.",
    "",
    "Текст, якщо зручніше скопіювати:",
    "<pre>" + escapeHtml(requestText) + "</pre>",
  ].join("\n");
}

// Telegram fills the message box from ?text= and leaves the sending to the
// person. The draft is capped so no client truncates the link.
export function helpKeyboard(contact, requestText, options = {}) {
  const draft = clipText(requestText, 600);
  const verb = options.verb || "Написати";
  const rows = [[{
    text: contact.name ? verb + ": " + contact.name : verb + " @" + contact.username,
    url: "https://t.me/" + contact.username + "?text=" + encodeURIComponent(draft),
  }]];
  if (options.booking) rows.push([{ text: "Записатися на консультацію", callback_data: "b|start" }]);
  return { inline_keyboard: rows };
}

export function contactUnavailable() {
  return "Контакт для звернення не налаштований у цьому боті.";
}

// The bot forwards nothing, so a refund request typed into this chat would
// reach no one. It goes to the owner's account instead, as a draft the person
// sends themselves. `owner` is a username or null.
export function paySupport(price, owner) {
  const refund = owner
    ? "Повернення можливе протягом 14 днів: напишіть @" + escapeHtml(owner) + " кнопкою нижче. Чернетка вже містить " +
      "усе, що потрібно для повернення, зірки повертаються через Telegram. "
    : "Повернення можливе протягом 14 днів через власника бота, зірки повертаються через Telegram. ";
  return [
    "<b>Оплата і повернення</b>",
    "",
    "Повний доступ це одноразова покупка за " + escapeHtml(priceLine(price)) + ". Підписки немає, " +
      "нічого не списується повторно.",
    "",
    refund + "Після повернення платні шкали закриються, а Ваші результати залишаться.",
    "",
    "Опитувальники GAD-7 і PHQ-9, блок підтримки, техніки самодопомоги, звіт для фахівця, вивантаження " +
      "і видалення даних працюють безкоштовно і після повернення.",
    "",
    "Кабінет фахівця це окрема щомісячна підписка. Автопродовження вимикається в /psy або в " +
      "налаштуваннях Telegram, кабінет працює до кінця оплаченого місяця.",
  ].join("\n");
}

export function questionText(instrument, index, sessionTotal) {
  const item = instrument.items[index];
  const lines = ["<b>" + escapeHtml(instrument.title) + "</b> Питання " + (index + 1) + " з " + sessionTotal, ""];
  // The unscored impairment item carries its own framing, so the shared
  // "last two weeks" prompt is only repeated above the scored items.
  if (item.scored) lines.push(escapeHtml(instrument.prompt), "");
  lines.push("<b>" + escapeHtml(item.text) + "</b>");
  return lines.join("\n");
}

export function answerKeyboard(instrument, session) {
  const item = instrument.items[session.index];
  return {
    inline_keyboard: item.options.map((option) => [{
      text: option.value + " " + option.label,
      callback_data: ["a", session.id, session.index, option.value].join("|"),
    }]),
  };
}

// The one full-width button under the input field. A keyboard button is the
// only launch type whose Mini App can send data back without a server, so this
// is what the app is opened from.
//
// The row under it is "Мені зараз погано", kept in reach at all times: it
// arrives as a plain message, which the router answers before anything else.
export function appKeyboard(webappUrl) {
  const rows = webappUrl ? [[{ text: "Відкрити застосунок", web_app: { url: webappUrl } }]] : [];
  rows.push([{ text: SOS_BUTTON }]);
  return { keyboard: rows, resize_keyboard: true, is_persistent: true };
}

export function sosHint() {
  return "Якщо колись стане зовсім важко, кнопка «" + escapeHtml(SOS_BUTTON) + "» під полем введення завжди поруч.";
}

export function appIntro() {
  return [
    "<b>Застосунок</b>",
    "",
    "Кнопка «Відкрити застосунок» під полем введення відкриває вікно поверх чату.",
    "Там опитувальники, статистика з графіками, історія, нагадування і ваші дані.",
    "",
    "У чат приходить лише підсумок кожного проходження. Опитувальники так само працюють і тут, командами /gad7 та /phq9.",
  ].join("\n");
}

export function appResultSaved(instrument, result) {
  return "Збережено із застосунку: <b>" + escapeHtml(instrument.title) + "</b> " +
    result.score + "/" + instrument.maxScore + ", " + escapeHtml(result.severity) + ".";
}

export function appRejected() {
  return "Не вдалося прочитати дані із застосунку. Спробуйте ще раз або пройдіть опитувальник у чаті: /gad7, /phq9.";
}

export function startKeyboard(unlocked = true) {
  const paidRow = PAID_INSTRUMENT_LIST.map((instrument) => ({
    text: unlocked ? instrument.title : instrument.title + " 🔒",
    callback_data: "s|" + instrument.id,
  }));
  return {
    inline_keyboard: [
      FREE_INSTRUMENT_LIST.map((instrument) => ({
        text: instrument.title,
        callback_data: "s|" + instrument.id,
      })),
      paidRow,
      [
        { text: unlocked ? "Настрій сьогодні" : "Настрій сьогодні 🔒", callback_data: "m|ask" },
        { text: "Техніки самодопомоги", callback_data: "pp|menu" },
      ],
      [
        { text: "Мої результати", callback_data: "h|all" },
        { text: "Нагадування", callback_data: "r|status" },
      ],
      [{ text: "Звіт для фахівця", callback_data: "rep|ask" }],
    ],
  };
}

// Under every result: practices matched to the scale, free for everyone.
export function resultKeyboard(instrument) {
  return { inline_keyboard: [[{ text: "Що можна зробити зараз", callback_data: "p|" + instrument.id }]] };
}

function practiceBlock(practice) {
  return ["<b>" + escapeHtml(practice.title) + "</b>"]
    .concat(practice.steps.map((step, index) => (index + 1) + ". " + escapeHtml(step)))
    .join("\n");
}

export function practicesMessage(practices) {
  return ["<b>Що можна зробити зараз</b>", "Кілька хвилин, без підготовки.", ""]
    .concat(practices.map(practiceBlock).join("\n\n"))
    .concat(["", "Усі техніки: /selfhelp"])
    .join("\n");
}

export function practicesMenu() {
  return "<b>Техніки самодопомоги</b>\n\nКороткі вправи на кілька хвилин. Оберіть одну:";
}

export function practicesMenuKeyboard() {
  const buttons = PRACTICE_IDS.map((id) => ({ text: PRACTICES[id].title, callback_data: "pp|" + id }));
  const rows = [];
  for (let index = 0; index < buttons.length; index += 2) rows.push(buttons.slice(index, index + 2));
  return { inline_keyboard: rows };
}

export function practiceMessage(practice) {
  return practiceBlock(practice) + "\n\nІнші техніки: /selfhelp";
}

// Emergency services always come before any personal contact.
export function sosMessage(crisisContact, contact) {
  const lines = ["<b>" + escapeHtml(SOS_TITLE) + "</b>", escapeHtml(SOS_INTRO), ""];
  SOS_STEPS.forEach((step, index) => {
    lines.push("<b>" + (index + 1) + ". " + escapeHtml(step.title) + ".</b> " + escapeHtml(step.text));
  });
  lines.push("", "<b>" + escapeHtml(SOS_EMERGENCY) + "</b>", escapeHtml(crisisContact));
  if (contact && contact.username) {
    const who = contact.name || "@" + contact.username;
    const role = contact.role ? " (" + contact.role + ")" : "";
    lines.push("", "Можна також написати фахівцю, контакт: " + escapeHtml(who) + escapeHtml(role) + ".");
  }
  return lines.join("\n");
}

export function sosKeyboard(contact) {
  if (!contact || !contact.username) return undefined;
  return {
    inline_keyboard: [[{
      text: contact.name ? "Написати: " + contact.name : "Написати @" + contact.username,
      url: "https://t.me/" + contact.username,
    }]],
  };
}

export function moodQuestion() {
  return "<b>Настрій сьогодні</b>\n\nОцініть від 1 до 10, де 1 дуже погано, а 10 чудово. Одного натискання достатньо.";
}

export function moodKeyboard() {
  const button = (value) => ({ text: String(value), callback_data: "m|" + value });
  return { inline_keyboard: [[1, 2, 3, 4, 5].map(button), [6, 7, 8, 9, 10].map(button)] };
}

function moodTagLine(entry) {
  const labels = entry.tags.map((id) => moodTag(id)).filter(Boolean).map((tag) => tag.label);
  return labels.length ? " · " + escapeHtml(labels.join(", ")) : "";
}

export function moodSaved(entry) {
  const lines = ["Настрій сьогодні: <b>" + entry.rating + "</b> з 10. Збережено.", "",
    "Що найбільше впливало? Можна вибрати кілька або одразу натиснути «Готово»."];
  if (entry.rating <= MOOD_CRISIS) {
    lines.push("", "Якщо зараз дуже важко, натисніть «" + escapeHtml(SOS_BUTTON) + "» або /sos.");
  } else if (entry.rating <= MOOD_LOW) {
    lines.push("", "Якщо хочеться, кнопка нижче підкаже, що може трохи допомогти.");
  }
  return lines.join("\n");
}

export function moodTagKeyboard(entry) {
  const buttons = MOOD_TAGS.map((tag) => ({
    text: (entry.tags.indexOf(tag.id) !== -1 ? "✓ " : "") + tag.label,
    callback_data: "mt|" + entry.date + "|" + tag.id,
  }));
  const rows = [buttons.slice(0, 3), buttons.slice(3)];
  if (entry.rating <= MOOD_LOW) rows.push([{ text: "Що можна зробити зараз", callback_data: "p|mood" }]);
  rows.push([{ text: "Готово", callback_data: "md|" + entry.date }]);
  return { inline_keyboard: rows };
}

export function moodDone(entry, weekAverage) {
  const average = weekAverage === null ? "" : "\nСереднє за останні 7 днів: " + weekAverage.toFixed(1).replace(".", ",") + ".";
  return "Настрій сьогодні: <b>" + entry.rating + "</b> з 10" + moodTagLine(entry) + "." + average;
}

export function reportIntro() {
  return [
    "<b>Звіт для фахівця</b>",
    "",
    "Одна сторінка з балами, графіками і, за бажанням, Вашими нотатками про тиждень. Файл відкривається в " +
      "браузері: його можна показати на консультації, роздрукувати або зберегти як PDF.",
    "",
    "Нотатки особисті, тому вирішіть, чи додавати їх.",
  ].join("\n");
}

export function reportKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "З нотатками", callback_data: "rep|notes" }, { text: "Без нотаток", callback_data: "rep|plain" }],
    ],
  };
}

export function reportEmpty() {
  return "Поки немає даних для звіту. Пройдіть /gad7 або /phq9, і звіт стане доступним.";
}

export function reportCaption() {
  return "Звіт для фахівця. Відкрийте файл у браузері, щоб переглянути, роздрукувати або зберегти як PDF.";
}

export function bookingIntro() {
  return [
    "<b>Запис на консультацію</b>",
    "",
    "Кілька коротких питань, щоб легше було домовитися про час. Нічого не надсилається автоматично: " +
      "наприкінці Ви побачите готове повідомлення і надішлете його самі.",
    "",
    "<b>Який формат зручніший?</b>",
  ].join("\n");
}

function optionKeyboard(options, prefix) {
  const buttons = options.map((option) => ({ text: option.label, callback_data: prefix + option.id }));
  const rows = [];
  for (let index = 0; index < buttons.length; index += 3) rows.push(buttons.slice(index, index + 3));
  return { inline_keyboard: rows };
}

export function bookingFormatKeyboard() {
  return optionKeyboard(BOOKING_FORMATS, "b|f|");
}

export function bookingTimeQuestion() {
  return "<b>Коли Вам зручно?</b>";
}

export function bookingTimeKeyboard() {
  return optionKeyboard(BOOKING_TIMES, "b|t|");
}

export function bookingRequestQuestion() {
  return "<b>З чим хотіли б попрацювати?</b>\n\nОдне-два речення одним повідомленням. Можна пропустити.";
}

export function bookingRequestKeyboard() {
  return { inline_keyboard: [[{ text: "Пропустити", callback_data: "b|r|skip" }]] };
}

export function bookingScoresQuestion() {
  return "<b>Додати до повідомлення Ваші останні результати?</b>\n\nФахівцю так простіше підготуватися. " +
    "Ви все одно побачите текст перед надсиланням.";
}

export function bookingScoresKeyboard() {
  return { inline_keyboard: [[{ text: "Так", callback_data: "b|s|yes" }, { text: "Ні", callback_data: "b|s|no" }]] };
}

export function bookingDraft(booking, scoreLines) {
  const format = bookingOption(BOOKING_FORMATS, booking.format);
  const time = bookingOption(BOOKING_TIMES, booking.time);
  const lines = ["Вітаю! Хочу записатися на консультацію."];
  if (format) lines.push("Формат: " + format.label.toLowerCase());
  if (time) lines.push("Зручний час: " + time.label.toLowerCase());
  if (booking.request) lines.push("Запит: " + booking.request);
  if (scoreLines && scoreLines.length) lines.push("", "Мої останні результати:");
  return lines.concat(scoreLines && scoreLines.length ? scoreLines : []).join("\n");
}

export function bookingReady(contact, draft) {
  const who = contact.name || "@" + contact.username;
  const role = contact.role ? " (" + contact.role + ")" : "";
  return [
    "<b>Готово</b>",
    "",
    "Кнопка нижче відкриє чат із готовим повідомленням, контакт: " + escapeHtml(who) + escapeHtml(role) + ". " +
      "Ви побачите текст, зможете його змінити і надішлете самі.",
    "",
    "Текст, якщо зручніше скопіювати:",
    "<pre>" + escapeHtml(draft) + "</pre>",
  ].join("\n");
}

export function bookingExpired() {
  return "Запис уже завершено або перервано. Почати знову: /book";
}

export function resultMessage(instrument, result, previous, schedule, crisisContact) {
  const lines = [
    // A colon, because "Сон готовий" and "Самопочуття готове" disagree in gender.
    "<b>" + escapeHtml(instrument.title) + ": готово</b>",
    "",
    "Бали: <b>" + result.score + "</b> з " + instrument.maxScore,
    "Оцінка: " + escapeHtml(result.severity),
  ];
  if (previous) {
    const delta = result.score - previous.score;
    const sign = delta > 0 ? "+" : "";
    const direction = delta === 0 ? "без змін" : sign + delta + " до минулого разу";
    lines.push("Динаміка: " + escapeHtml(direction) +
      " (" + previous.score + " від " + stampIn(schedule, Date.parse(previous.completedAt)) + ")");
  }
  if (result.impairment !== null && result.impairment !== undefined) {
    const impairmentItem = instrument.items.find((item) => !item.scored);
    const option = impairmentItem.options.find((candidate) => candidate.value === result.impairment);
    if (option) lines.push("Вплив на життя: " + escapeHtml(option.label.toLowerCase()));
  }
  // What the level means, then that it is understandable, then what to do.
  const meaning = interpretResult(instrument, result);
  lines.push("");
  lines.push(escapeHtml(meaning.description));
  lines.push("");
  lines.push("<i>" + escapeHtml(meaning.support) + "</i>");
  lines.push("");
  lines.push(escapeHtml(meaning.advice));
  // The crisis block goes before the fine print, never after it.
  if (result.risk) {
    lines.push("");
    lines.push(crisisBlock(crisisContact));
  }
  if (instrument.caveat) {
    lines.push("");
    lines.push("<i>" + escapeHtml(instrument.caveat) + "</i>");
  }
  lines.push("");
  lines.push(DISCLAIMER);
  return lines.join("\n");
}

// A snapshot edited by hand can omit the derived fields, so both are recomputed
// from the score when they are missing.
function describe(instrument, entry) {
  const maxScore = Number.isFinite(entry.maxScore) ? entry.maxScore : instrument.maxScore;
  const severity = typeof entry.severity === "string" ? entry.severity : severityOf(instrument, entry.score);
  return { maxScore, severity };
}

// The one open question, asked after the scored items. It is not scored and
// exists so a number has a story next to it a month later.
export function noteQuestion() {
  return [
    "<b>І останнє, вільними словами</b>",
    "",
    "Яким був цей тиждень? Що впливало на стан, що допомагало, а що виснажувало.",
    "Кілька речень достатньо, можна й одне.",
    "",
    "Це не оцінюється і на бали не впливає. Саме ці рядки через місяць пояснять, чому бал був таким.",
    "",
    "Напишіть відповідь одним повідомленням або натисніть «Пропустити».",
  ].join("\n");
}

export function noteKeyboard(pendingId) {
  return { inline_keyboard: [[{ text: "Пропустити", callback_data: "n|" + pendingId + "|skip" }]] };
}

export function noteSaved(note) {
  const shortened = note.length >= MAX_NOTE_LENGTH
    ? "\n\nЗапис довгий, тому збережені перші " + MAX_NOTE_LENGTH + " символів."
    : "";
  return "Записав, опис збережено разом із результатом. Побачити його знову: /results" + shortened;
}

export function noteSkipped() {
  return "Гаразд, без опису. Результат уже збережено.";
}

// Telegram refuses a message over 4096 characters, so a list that can grow is
// packed into as few messages as fit. A block is never split, which keeps its
// markup whole; the ceiling leaves a margin, since tags and entities count
// here and not in Telegram's own measure.
export const MESSAGE_LIMIT = 4000;

export function packMessages(blocks, separator, limit = MESSAGE_LIMIT) {
  const messages = [];
  let current = null;
  blocks.forEach((block) => {
    if (current !== null && current.length + separator.length + block.length > limit) {
      messages.push(current);
      current = null;
    }
    current = current === null ? block : current + separator + block;
  });
  if (current !== null) messages.push(current);
  return messages;
}

// One line for a list, never the whole note.
function noteSnippet(note, limit = 90) {
  const flat = note.replace(/\s+/g, " ").trim();
  return escapeHtml(flat.length > limit ? flat.slice(0, limit) + "..." : flat);
}

// Returns the texts of one or more messages.
export function historyMessages(store, chatId, schedule, limit = 10) {
  const sections = INSTRUMENT_LIST.map((instrument) => {
    const entries = store.history(chatId, instrument.id, limit);
    if (!entries.length) {
      return "<b>" + escapeHtml(instrument.title) + "</b>\nще немає проходжень: " + instrument.command;
    }
    const rows = entries.map((entry) => {
      const stamp = stampIn(schedule, Date.parse(entry.completedAt));
      const shape = describe(instrument, entry);
      const row = "• " + stamp + " : <b>" + entry.score + "</b>/" + shape.maxScore +
        " " + escapeHtml(shape.severity);
      return entry.note ? row + "\n  <i>" + noteSnippet(entry.note) + "</i>" : row;
    });
    const total = store.history(chatId, instrument.id).length;
    const shown = total > entries.length ? "\nпоказані останні " + entries.length + " з " + total : "";
    return "<b>" + escapeHtml(instrument.title) + "</b>\n" + rows.join("\n") + shown;
  });
  return packMessages(["<b>Історія результатів</b>"].concat(sections), "\n\n");
}

// Returns the texts of one or more messages: every note is shown in full, and
// six of them can outgrow a single message.
export function lastMessages(store, chatId, schedule) {
  const rows = INSTRUMENT_LIST.map((instrument) => {
    const entry = store.lastResult(chatId, instrument.id);
    if (!entry) return "<b>" + escapeHtml(instrument.title) + "</b>: немає даних";
    const shape = describe(instrument, entry);
    const head = "<b>" + escapeHtml(instrument.title) + "</b>: " + entry.score + "/" + shape.maxScore +
      " " + escapeHtml(shape.severity) + ", " + stampIn(schedule, Date.parse(entry.completedAt));
    return entry.note ? head + "\n<i>" + escapeHtml(entry.note) + "</i>" : head;
  });
  return packMessages(["<b>Останні результати</b>\n"].concat(rows), "\n");
}

export function reminderStatus(user, schedule, nextDueMs) {
  const state = user.remindersEnabled ? "увімкнені" : "вимкнені";
  const offsetNow = offsetAt(schedule, nextDueMs);
  const zoneNote = schedule.zone
    ? escapeHtml(schedule.zone) + ", зараз " + formatUtcOffset(offsetNow) + ", перехід на літній час враховується"
    : formatUtcOffset(offsetNow) + ", фіксований зсув";
  const lines = [
    "<b>Нагадування</b>: " + state,
    "День: " + weekdayWords(schedule).name + ", час " + formatTimeOfDay(schedule),
    "Часовий пояс: " + zoneNote,
  ];
  if (user.remindersEnabled) {
    lines.push("Наступне: " + formatLocalDateTime(nextDueMs, offsetNow));
  }
  lines.push("");
  lines.push("/remind off вимикає, /remind on вмикає, /remind 20:30 змінює час.");
  lines.push("/tz +3 задає свій зсув, /tz auto повертає автоматичний.");
  return lines.join("\n");
}

export function weeklyReminder(store, chatId, schedule) {
  const rows = INSTRUMENT_LIST.map((instrument) => {
    const entry = store.lastResult(chatId, instrument.id);
    if (!entry) return "• " + instrument.title + ": ще не проходили";
    return "• " + instrument.title + ": минулий бал " + entry.score + "/" + describe(instrument, entry).maxScore;
  });
  const day = weekdayWords(schedule).name;
  return ["<b>" + escapeHtml(day.charAt(0).toUpperCase() + day.slice(1)) + ", час для перевірки</b>", "",
    "Пройдіть опитувальники, кожен займає одну-дві хвилини."]
    .concat(rows)
    .concat(["", "Вимкнути нагадування: /remind off"])
    .join("\n");
}

// Up to this size the export is a message, easy to read and to copy into the
// app's import. Past it the export is a file: a clipped JSON is neither the
// person's full data nor parseable by that import.
export const EXPORT_INLINE_LIMIT = 3500;

export function exportJson(payload) {
  return JSON.stringify(payload, null, 2);
}

export function exportMessage(body) {
  return "<b>Ваші дані</b>\n<pre>" + escapeHtml(body) + "</pre>";
}

export function exportCaption() {
  return "Ваші дані повністю, файлом JSON. Його відкриває будь-який текстовий редактор, а вміст можна " +
    "вставити в застосунок: «Мої дані», «Імпорт із чату».";
}

export function unknownInput() {
  return "Не зрозумів команду. /help показує список, /gad7 і /phq9 запускають опитувальники.";
}
