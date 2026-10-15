// The safety plan, the thought diary, mood insights, and sessions with a
// specialist: the content, the pure logic and the texts. The router holds the
// conversations around them. Zero dependencies. Node 16+.
//
// Rules that are deliberate:
// - The safety plan is free forever and always comes after 103, 112 and 7333,
//   never instead of them. It is not shared with anyone.
// - A diary entry reaches a specialist only when the person sends that one
//   entry themselves.
// - A session card shows scores only while the client's consent stands; the
//   words the client wrote for the session they wrote for the specialist.

import { escapeHtml } from "./telegram.mjs";
import { MOOD_TAGS } from "./selfhelp.mjs";

export const MAX_CARE_TEXT = 500;
export const MAX_DIARY_ENTRIES = 100;
export const MAX_BOOKINGS_PER_USER = 50;
export const SESSION_MINUTES = 50;
export const BOOKING_DAYS_AHEAD = 14;

const clip = (text) => (typeof text === "string" ? text.trim().replace(/\s+\n/g, "\n").slice(0, MAX_CARE_TEXT) : "");

// ---------------------------------------------------------------- safety plan

// The person's own words for six steps. The services step is fixed and comes
// first when the plan is shown.
export const PLAN_STEPS = [
  { key: "signs", title: "Мої тривожні сигнали", ask: "Крок 1 з 6. <b>Мої тривожні сигнали.</b>\nЯкі думки, почуття чи ситуації кажуть, що мені стає гірше? Наприклад: «не можу заснути», «ні з ким не хочу говорити», «думаю, що я тягар»." },
  { key: "coping", title: "Що я можу зробити сам(а)", ask: "Крок 2 з 6. <b>Що я можу зробити сам(а).</b>\nЩо хоч трохи допомагає, коли важко? Наприклад: душ, прогулянка, музика, дихання 4-6, малювати." },
  { key: "places", title: "Люди і місця, що відволікають", ask: "Крок 3 з 6. <b>Люди і місця, що відволікають.</b>\nКуди можна піти або з ким побути, навіть не говорячи про важке? Наприклад: кав'ярня, парк, сусідка, сестра." },
  { key: "people", title: "Кому я можу написати чи подзвонити", ask: "Крок 4 з 6. <b>Кому я можу написати чи подзвонити.</b>\nІмена і, якщо хочете, номери людей, яким можна сказати: «Мені зараз дуже важко»." },
  { key: "environment", title: "Як зробити оточення безпечнішим", ask: "Крок 5 з 6. <b>Як зробити оточення безпечнішим.</b>\nЩо можна прибрати подалі чи віддати комусь на зберігання, коли стає гірше? Наприклад: ліки, гострі предмети, алкоголь." },
  { key: "reasons", title: "Заради чого я тримаюся", ask: "Крок 6 з 6. <b>Заради чого я тримаюся.</b>\nЛюди, справи, мрії, тварини, усе, що для Вас важливо." },
];

export function normalizePlan(raw) {
  if (!raw || typeof raw !== "object") return null;
  const plan = {};
  PLAN_STEPS.forEach((step) => {
    const value = clip(raw[step.key]);
    if (value) plan[step.key] = value;
  });
  if (!Object.keys(plan).length) return null;
  plan.updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : null;
  return plan;
}

export function planIntro() {
  return [
    "🛟 <b>План безпеки</b>",
    "",
    "Це Ваш власний план на важкий момент, складений заздалегідь, у спокійну хвилину. Коли стає дуже погано, " +
      "думати складно, а свої ж слова допомагають краще за загальні поради.",
    "",
    "Шість коротких кроків, будь-який можна пропустити. План бачите лише Ви, і він приходитиме разом із " +
      "кнопкою «Мені зараз погано». Якщо у Вас є фахівець, його можна скласти разом на сесії.",
  ].join("\n");
}

export function planStartKeyboard(exists) {
  return { inline_keyboard: [[{ text: exists ? "✏️ Змінити план" : "🛟 Скласти план", callback_data: "pl|start" }]] };
}

export function planStepKeyboard() {
  return { inline_keyboard: [[{ text: "Пропустити", callback_data: "pl|skip" }]] };
}

// Emergency services come first, always.
export function planMessage(plan, crisisContact) {
  const lines = ["🛟 <b>Мій план безпеки</b>", "", "<b>Якщо є загроза життю:</b> 103 або 112. LifeLine Ukraine: 7333, безкоштовно і цілодобово."];
  PLAN_STEPS.forEach((step) => {
    if (plan[step.key]) lines.push("", "<b>" + escapeHtml(step.title) + "</b>", escapeHtml(plan[step.key]));
  });
  if (crisisContact) lines.push("", escapeHtml(crisisContact));
  lines.push("", "Змінити план: /plan");
  return lines.join("\n");
}

export function planSaved() {
  return "План збережено. Він прийде разом із кнопкою «Мені зараз погано», а побачити чи змінити його можна будь-коли: /plan.";
}

// ---------------------------------------------------------------- thought diary

export const DIARY_STEPS = [
  { key: "situation", ask: "📓 <b>Щоденник думок</b>, крок 1 з 8.\nЩо сталося? Коротко опишіть ситуацію: де, коли, хто був поруч." },
  { key: "thought", ask: "Крок 2 з 8. Яка думка промайнула в голові? Запишіть її дослівно, як вона прозвучала." },
  { key: "emotion", ask: "Крок 3 з 8. Яку емоцію Ви відчули? Наприклад: тривога, сум, злість, сором." },
  { key: "before", ask: "Крок 4 з 8. Наскільки сильною була емоція, від 0 до 100?", scale: true },
  { key: "forFacts", ask: "Крок 5 з 8. Які факти підтверджують цю думку? Лише факти, не здогадки." },
  { key: "againstFacts", ask: "Крок 6 з 8. Які факти їй суперечать або не вписуються в неї?" },
  { key: "balanced", ask: "Крок 7 з 8. Як можна подумати більш збалансовано? Що Ви сказали б другові з такою думкою?" },
  { key: "after", ask: "Крок 8 з 8. Наскільки сильна емоція зараз, від 0 до 100?", scale: true },
];

export function diaryScaleKeyboard(key) {
  const button = (value) => ({ text: String(value), callback_data: "dy|" + (key === "before" ? "b" : "a") + "|" + value });
  return { inline_keyboard: [[0, 10, 20, 30, 40, 50].map(button), [60, 70, 80, 90, 100].map(button)] };
}

export function normalizeDiaryEntry(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !/^[A-Za-z0-9]{4,16}$/.test(raw.id)) return null;
  if (typeof raw.at !== "string" || !Number.isFinite(Date.parse(raw.at))) return null;
  const level = (value) => (Number.isInteger(value) && value >= 0 && value <= 100 ? value : null);
  return {
    id: raw.id, at: raw.at,
    situation: clip(raw.situation), thought: clip(raw.thought), emotion: clip(raw.emotion),
    before: level(raw.before), forFacts: clip(raw.forFacts), againstFacts: clip(raw.againstFacts),
    balanced: clip(raw.balanced), after: level(raw.after),
    sentTo: Array.isArray(raw.sentTo) ? raw.sentTo.filter(Number.isInteger).slice(0, 20) : [],
  };
}

export function diaryEntryText(entry, date) {
  const line = (title, value) => (value ? ["<b>" + title + "</b>", escapeHtml(value)] : []);
  const change = entry.before !== null && entry.after !== null ? entry.before + " → " + entry.after : null;
  return ["📓 <b>Запис щоденника</b>, " + escapeHtml(date)]
    .concat([""], line("Ситуація", entry.situation), line("Думка", entry.thought),
      line("Емоція", entry.emotion + (change ? " (" + change + ")" : "")),
      line("Факти «за»", entry.forFacts), line("Факти «проти»", entry.againstFacts),
      line("Збалансована думка", entry.balanced))
    .join("\n");
}

export function diaryDone(entry) {
  const drop = entry.before !== null && entry.after !== null ? entry.before - entry.after : null;
  const head = drop !== null && drop > 0
    ? "Записано. Емоція стала слабшою на " + drop + " з 100: так і працює перевірка думки."
    : "Записано. Навіть якщо емоція не змінилася, Ви подивилися на думку збоку, а це вже навичка.";
  return head + "\n\nЩоденник бачите лише Ви. Окремий запис можна надіслати своєму фахівцю кнопкою нижче.";
}

export function diaryDoneKeyboard(entry, specialists) {
  const rows = specialists.map((specialist) => [{
    text: "Надіслати фахівцю: " + specialist.name, callback_data: "dy|s|" + entry.id + "|" + specialist.chatId,
  }]);
  rows.push([{ text: "📓 Новий запис", callback_data: "dy|new" }, { text: "Мої записи", callback_data: "dy|list" }]);
  return { inline_keyboard: rows };
}

export function diaryIntro() {
  return [
    "📓 <b>Щоденник думок</b>",
    "",
    "Техніка когнітивно-поведінкової терапії: записати ситуацію, думку і емоцію, а потім перевірити думку фактами. " +
      "Вісім коротких кроків, близько п'яти хвилин. Безкоштовно.",
  ].join("\n");
}

export function diaryIntroKeyboard() {
  return { inline_keyboard: [[{ text: "📓 Новий запис", callback_data: "dy|new" }, { text: "Мої записи", callback_data: "dy|list" }]] };
}

// ---------------------------------------------------------------- insights

export const INSIGHTS_MIN_MOODS = 14;
const WEEKDAY_SHORT = ["неділя", "понеділок", "вівторок", "середа", "четвер", "пʼятниця", "субота"];
const average = (list) => list.reduce((sum, value) => sum + value, 0) / list.length;
const one = (value) => value.toFixed(1).replace(".", ",");

// Patterns in the person's own check-ins. Plain averages, at least three days
// on each side of a comparison, nothing shown below a 0.8 point difference.
export function moodInsights(moods) {
  const entries = moods.slice(-90);
  if (entries.length < INSIGHTS_MIN_MOODS) return { enough: false, count: entries.length };
  const all = average(entries.map((entry) => entry.rating));
  const tags = [];
  MOOD_TAGS.forEach((tag) => {
    const withTag = entries.filter((entry) => entry.tags.indexOf(tag.id) !== -1).map((entry) => entry.rating);
    const without = entries.filter((entry) => entry.tags.indexOf(tag.id) === -1).map((entry) => entry.rating);
    if (withTag.length < 3 || without.length < 3) return;
    const diff = average(withTag) - average(without);
    if (Math.abs(diff) >= 0.8) tags.push({ label: tag.label, diff, days: withTag.length });
  });
  tags.sort((left, right) => Math.abs(right.diff) - Math.abs(left.diff));
  const byDay = {};
  entries.forEach((entry) => {
    const day = new Date(entry.date + "T12:00:00Z").getUTCDay();
    (byDay[day] = byDay[day] || []).push(entry.rating);
  });
  const days = Object.keys(byDay).filter((day) => byDay[day].length >= 2)
    .map((day) => ({ day: Number(day), value: average(byDay[day]) })).sort((left, right) => right.value - left.value);
  const recent = entries.slice(-7).map((entry) => entry.rating);
  const before = entries.slice(-14, -7).map((entry) => entry.rating);
  return {
    enough: true, count: entries.length, all, tags: tags.slice(0, 3),
    best: days.length >= 2 && days[0].value - days[days.length - 1].value >= 1 ? days[0] : null,
    worst: days.length >= 2 && days[0].value - days[days.length - 1].value >= 1 ? days[days.length - 1] : null,
    trend: before.length >= 5 ? average(recent) - average(before) : null,
  };
}

export function insightsText(insights) {
  if (!insights.enough) {
    return "🔍 <b>Що впливає на настрій</b>\n\nЗакономірності видно після " + INSIGHTS_MIN_MOODS +
      " відміток настрою, зараз їх " + insights.count + ". Відмічайте настрій і теги, що впливали: /mood.";
  }
  const lines = ["🔍 <b>Що впливає на настрій</b>", "", "Відміток: " + insights.count + ", середній настрій " + one(insights.all) + " з 10."];
  if (insights.tags.length) {
    lines.push("");
    insights.tags.forEach((tag) => {
      lines.push("• У дні з тегом «" + escapeHtml(tag.label) + "» настрій у середньому " +
        (tag.diff > 0 ? "вищий" : "нижчий") + " на " + one(Math.abs(tag.diff)) + " (днів: " + tag.days + ").");
    });
  } else {
    lines.push("", "Помітних звʼязків із тегами поки немає: або вони слабкі, або тегів відмічено замало.");
  }
  if (insights.best) {
    lines.push("", "Найкращий день тижня: " + WEEKDAY_SHORT[insights.best.day] + " (" + one(insights.best.value) + "), " +
      "найважчий: " + WEEKDAY_SHORT[insights.worst.day] + " (" + one(insights.worst.value) + ").");
  }
  if (insights.trend !== null && Math.abs(insights.trend) >= 0.5) {
    lines.push("", "Останній тиждень " + (insights.trend > 0 ? "кращий" : "важчий") + " за попередній на " + one(Math.abs(insights.trend)) + ".");
  }
  lines.push("", "Це збіги у Ваших даних, а не доведені причини. Їх варто обговорити з фахівцем.");
  return lines.join("\n");
}

// ---------------------------------------------------------------- sessions

const WEEKDAY_WORDS = {
  нд: 0, нед: 0, неділя: 0, вс: 0, воскресенье: 0,
  пн: 1, пон: 1, понеділок: 1, понедельник: 1,
  вт: 2, вів: 2, вівторок: 2, вторник: 2,
  ср: 3, сер: 3, середа: 3, среда: 3,
  чт: 4, чет: 4, четвер: 4, четверг: 4,
  пт: 5, пят: 5, "пʼятниця": 5, "п'ятниця": 5, пятница: 5,
  сб: 6, суб: 6, субота: 6, суббота: 6,
};
export const WEEKDAY_TITLES = ["Нд", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

// "Пн 18:00, 19:00; Ср 10:00" to { "1": ["18:00", "19:00"], "3": ["10:00"] }.
// Returns null when nothing in it could be read.
export function parseWeeklyTemplate(text) {
  if (typeof text !== "string") return null;
  const slots = {};
  let any = false;
  text.split(/[;\n]+/).forEach((part) => {
    const words = part.trim().toLowerCase().replace(/[’`]/g, "ʼ").split(/[\s,]+/).filter(Boolean);
    if (!words.length) return;
    const day = WEEKDAY_WORDS[words[0].replace(/[.:]$/, "")];
    if (day === undefined) return;
    const times = words.slice(1).map((word) => /^([01]?\d|2[0-3])[:.]([0-5]\d)$/.exec(word))
      .filter(Boolean).map((match) => match[1].padStart(2, "0") + ":" + match[2]);
    if (!times.length) return;
    slots[day] = Array.from(new Set((slots[day] || []).concat(times))).sort();
    any = true;
  });
  return any ? slots : null;
}

export function normalizeSchedule(raw) {
  if (!raw || typeof raw !== "object" || !raw.slots || typeof raw.slots !== "object") return null;
  const slots = {};
  Object.keys(raw.slots).forEach((day) => {
    if (!/^[0-6]$/.test(day) || !Array.isArray(raw.slots[day])) return;
    const times = raw.slots[day].filter((time) => typeof time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(time));
    if (times.length) slots[day] = Array.from(new Set(times)).sort().slice(0, 24);
  });
  return Object.keys(slots).length ? { slots } : null;
}

export function templateText(schedule) {
  if (!schedule) return "розклад ще не задано";
  return [1, 2, 3, 4, 5, 6, 0].filter((day) => schedule.slots[day])
    .map((day) => WEEKDAY_TITLES[day] + " " + schedule.slots[day].join(", ")).join("; ");
}

// `offsetAt(ms)` gives the specialist's UTC offset in minutes at an instant.
// Local wall-clock time to an instant, corrected once for a transition.
function localToInstant(dateKey, time, offsetAt) {
  const naive = Date.parse(dateKey + "T" + time + ":00Z");
  const first = naive - offsetAt(naive) * 60000;
  return naive - offsetAt(first) * 60000;
}

function addDays(dateKey, days) {
  return new Date(Date.parse(dateKey + "T12:00:00Z") + days * 86400000).toISOString().slice(0, 10);
}

// Free slots of the coming BOOKING_DAYS_AHEAD days: { date, time, at }. A slot
// must start at least two hours from now and be taken by no booking.
export function freeSlots(schedule, todayKey, nowMs, offsetAt, takenAt) {
  if (!schedule) return [];
  const taken = new Set(takenAt);
  const slots = [];
  for (let index = 0; index <= BOOKING_DAYS_AHEAD; index++) {
    const date = addDays(todayKey, index);
    const day = new Date(date + "T12:00:00Z").getUTCDay();
    (schedule.slots[day] || []).forEach((time) => {
      const at = localToInstant(date, time, offsetAt);
      if (at - nowMs >= 2 * 3600000 && !taken.has(at)) slots.push({ date, time, at });
    });
  }
  return slots;
}

export function dayLabel(dateKey) {
  const day = new Date(dateKey + "T12:00:00Z").getUTCDay();
  return WEEKDAY_TITLES[day] + " " + dateKey.slice(8, 10) + "." + dateKey.slice(5, 7);
}

export function normalizeBooking(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !/^[A-Za-z0-9]{4,16}$/.test(raw.id)) return null;
  if (!Number.isInteger(raw.psy) || !Number.isFinite(raw.at)) return null;
  const status = ["pending", "confirmed", "canceled"].indexOf(raw.status) === -1 ? "pending" : raw.status;
  const prep = raw.prep && typeof raw.prep === "object"
    ? { changed: clip(raw.prep.changed), hard: clip(raw.prep.hard), talk: clip(raw.prep.talk) }
    : null;
  return {
    id: raw.id, psy: raw.psy, at: Number(raw.at), status, topic: clip(raw.topic),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : null,
    canceledBy: raw.canceledBy === "psy" || raw.canceledBy === "client" ? raw.canceledBy : null,
    prep, prepAskedAt: typeof raw.prepAskedAt === "string" ? raw.prepAskedAt : null,
    summarySentAt: typeof raw.summarySentAt === "string" ? raw.summarySentAt : null,
  };
}

export const PREP_STEPS = [
  { key: "changed", ask: "Питання 1 з 3. Що змінилося з минулої зустрічі? Що вдалося, що ні." },
  { key: "hard", ask: "Питання 2 з 3. Що було найважчим цього тижня?" },
  { key: "talk", ask: "Питання 3 з 3. Про що Ви хотіли б поговорити на сесії?" },
];

const STATUS_WORDS = { pending: "чекає підтвердження", confirmed: "підтверджено", canceled: "скасовано" };

// What a specialist reads about one session. `scoreLines` are given only
// while the consent stands, otherwise the card says so.
export function bookingCard(booking, details) {
  const lines = ["🗓 <b>" + escapeHtml(details.title) + ": " + escapeHtml(details.clientName || "Клієнт") + "</b>",
    escapeHtml(details.when) + ", " + SESSION_MINUTES + " хв. Статус: " + STATUS_WORDS[booking.status] + "."];
  if (booking.topic) lines.push("", "<b>Про що хоче поговорити:</b>", "<i>" + escapeHtml(booking.topic) + "</i>");
  if (booking.prep) {
    lines.push("", "<b>Підготовка до сесії</b>");
    PREP_STEPS.forEach((step, index) => {
      if (booking.prep[step.key]) lines.push((index + 1) + ". " + escapeHtml(["Що змінилося", "Що було найважчим", "Про що поговорити"][index]) + ": <i>" + escapeHtml(booking.prep[step.key]) + "</i>");
    });
  } else if (details.prepMissing) {
    lines.push("", "Підготовку клієнт не заповнив.");
  }
  if (details.scoreLines) {
    lines.push("", "<b>Стан</b>");
    details.scoreLines.forEach((line) => lines.push(escapeHtml(line)));
  } else {
    lines.push("", "Бали недоступні: згоди клієнта зараз немає.");
  }
  return lines.join("\n");
}

export function bookingPsyKeyboard(clientChatId, booking) {
  const rows = [];
  if (booking.status === "pending") rows.push([{ text: "✅ Підтвердити", callback_data: "bc|" + clientChatId + "|" + booking.id }]);
  if (booking.status !== "canceled") rows.push([{ text: "Скасувати запис", callback_data: "bx|" + clientChatId + "|" + booking.id }]);
  rows.push([{ text: "Картка клієнта", callback_data: "cl|" + clientChatId }]);
  return { inline_keyboard: rows };
}
