// User-facing text for specialist mode: the specialist's account, the owner's
// review of applications, and the client's consent. Ukrainian. Zero
// dependencies. Node 16+.
//
// The consent form is the one text here with legal weight. It is versioned by
// CONSENT_VERSION in psy.mjs, and the version a client saw is stored with the
// consent, so any change of substance here must bump that version.

import { escapeHtml } from "./telegram.mjs";
import { starWord } from "./texts.mjs";
import { CONSENT_VERSION, INVITE_PREFIX } from "./psy.mjs";

export function psyPriceLine(price) {
  return price.stars + " " + starWord(price.stars) + " на місяць";
}

export function psyIntro(price) {
  return [
    "<b>Кабінет фахівця</b>",
    "",
    "Для психологів і психотерапевтів, які хочуть бачити стан клієнтів між зустрічами.",
    "",
    "• Клієнти проходять опитувальники і відмічають настрій у цьому боті.",
    "• За їхньою згодою Ви бачите бали, динаміку і звіт по кожному клієнту.",
    "• Сповіщення приходить, коли результат перетинає поріг або в PHQ-9 позначено питання про думки щодо смерті.",
    "",
    "Клієнт сам вирішує, чи ділитися даними, і може відкликати згоду одним натисканням.",
    "",
    "Щоб захистити клієнтів, кожного фахівця перевіряє власник бота. Після схвалення кабінет коштує " +
      escapeHtml(psyPriceLine(price)) + ": підписка в зірках Telegram, продовжується автоматично, " +
      "скасовується будь-коли.",
  ].join("\n");
}

export function psyApplyKeyboard() {
  return { inline_keyboard: [[{ text: "Подати заявку", callback_data: "py|apply" }]] };
}

export function psyAskName() {
  return "<b>Заявка фахівця, крок 1 з 3</b>\n\nЯк Вас звати? Ім'я та прізвище, так їх побачать клієнти у формі згоди.";
}

export function psyAskCredentials() {
  return "<b>Крок 2 з 3</b>\n\nКоротко про кваліфікацію: освіта, де практикуєте, посилання на профіль або " +
    "сертифікат. Це бачить лише власник бота.";
}

export function psyTerms() {
  return [
    "<b>Крок 3 з 3: умови для фахівця</b>",
    "",
    "• Ви використовуєте дані клієнтів лише для роботи з ними і лише поки діє їхня згода.",
    "• Не передаєте ці дані третім особам і не публікуєте їх.",
    "• Звіти, які завантажуєте, зберігаєте захищено і видаляєте, коли вони більше не потрібні.",
    "• Сповіщення про ризик не замінюють екстрену допомогу: якщо життю клієнта загрожує небезпека, " +
      "Ви дієте за своїм фаховим протоколом.",
    "• Ви дотримуєтеся законодавства про захист персональних даних і професійної етики.",
    "",
    "Натискаючи «Приймаю», Ви погоджуєтеся з цими умовами.",
  ].join("\n");
}

export function psyTermsKeyboard() {
  return {
    inline_keyboard: [[
      { text: "Приймаю", callback_data: "py|terms" },
      { text: "Скасувати", callback_data: "py|abort" },
    ]],
  };
}

export function psyApplied() {
  return "Заявку надіслано. Власник бота перевірить її і напише результат тут.";
}

export function psyAborted() {
  return "Заявку скасовано. Повернутися до неї: /psy";
}

export function psyPending() {
  return "Заявка на розгляді. Щойно власник бота її перевірить, Ви отримаєте повідомлення тут.";
}

export function psyRejected() {
  return "Заявку відхилено. Якщо це помилка, напишіть власнику бота.";
}

export function psySubscribeKeyboard(price) {
  return {
    inline_keyboard: [[{
      text: "Оформити підписку: " + price.stars + " " + starWord(price.stars) + " на місяць",
      callback_data: "py|sub",
    }]],
  };
}

export function psyApproved(price) {
  return "<b>Заявку схвалено</b>\n\nЛишилося оформити підписку: " + escapeHtml(psyPriceLine(price)) +
    ", продовжується автоматично. Після оплати тут з'явиться Ваше посилання для клієнтів.";
}

export function psyInactive(state, price, expiredOn) {
  const head = state.kind === "expired"
    ? "Підписка закінчилася " + escapeHtml(expiredOn) + "."
    : "Підписка ще не оформлена.";
  return "<b>Кабінет фахівця</b>\n\n" + head + " Кабінет коштує " + escapeHtml(psyPriceLine(price)) +
    ". Клієнти і їхні згоди збережені: після оплати все стане доступним знову.";
}

export function psyInvoiceMessage() {
  return "Кнопка нижче відкриє оплату зірками Telegram. Підписка продовжуватиметься щомісяця, поки Ви її " +
    "не скасуєте: у /psy або в налаштуваннях Telegram.";
}

export function psyInvoiceKeyboard(link, price) {
  return {
    inline_keyboard: [[{
      text: "Оформити підписку за " + price.stars + " " + starWord(price.stars),
      url: link,
    }]],
  };
}

export function psyActivated(until) {
  return "Кабінет відкрито. Підписка діє до " + escapeHtml(until) + " і продовжиться автоматично.\n\n" +
    "Посилання для клієнтів: /invite. Список клієнтів: /clients.";
}

export function psyRenewed(until) {
  return "Підписку на кабінет продовжено до " + escapeHtml(until) + ".";
}

export function inviteLink(botUsername, code) {
  return botUsername
    ? "https://t.me/" + botUsername + "?start=" + INVITE_PREFIX + code
    : "/start " + INVITE_PREFIX + code;
}

export function psyDashboard(state, link, clientCount, until) {
  let status = "Ви власник бота, кабінет безкоштовний.";
  if (state.kind === "subscribed") {
    status = "Підписка діє до " + escapeHtml(until) +
      (state.canceled ? ", автопродовження вимкнено." : ", продовжиться автоматично.");
  }
  return [
    "<b>Кабінет фахівця</b>",
    "",
    status,
    "Клієнтів зі згодою: " + clientCount,
    "",
    "<b>Посилання для клієнтів</b>",
    escapeHtml(link),
    "",
    "Клієнт відкриває посилання, бачить форму згоди і сам вирішує, чи ділитися даними.",
  ].join("\n");
}

export function psyDashboardKeyboard(state) {
  const rows = [
    [{ text: "Мої клієнти", callback_data: "py|clients" }],
    [{ text: "Нове посилання", callback_data: "py|newinv" }],
  ];
  if (state.kind === "subscribed") {
    rows.push([state.canceled
      ? { text: "Увімкнути автопродовження", callback_data: "py|resume" }
      : { text: "Вимкнути автопродовження", callback_data: "py|cancel" }]);
  }
  return { inline_keyboard: rows };
}

export function psyNewInvite(link) {
  return "Нове посилання для клієнтів:\n" + escapeHtml(link) + "\n\nСтаре більше не діє. Клієнти, які вже " +
    "дали згоду, залишаються у списку.";
}

export function psyCanceled(until) {
  return "Автопродовження вимкнено. Кабінет працює до " + escapeHtml(until) + ".";
}

export function psyResumed(until) {
  return "Автопродовження увімкнено. Наступне списання " + escapeHtml(until) + ".";
}

export function psyNeedsAccess() {
  return "Це частина кабінету фахівця. Подробиці і стан кабінету: /psy";
}

// A message holds at most 4096 characters, so a long list is cut and says so.
export const MAX_LISTED_CLIENTS = 30;

export function psyClientsList(rows) {
  if (!rows.length) {
    return "<b>Мої клієнти</b>\n\nПоки немає клієнтів зі згодою. Надішліть клієнту посилання з /invite.";
  }
  const shown = rows.slice(0, MAX_LISTED_CLIENTS).map(escapeHtml);
  const more = rows.length > shown.length ? ["", "Ще клієнтів: " + (rows.length - shown.length) + "."] : [];
  return ["<b>Мої клієнти</b>", ""].concat(shown, more).join("\n");
}

export function psyClientsKeyboard(entries) {
  return {
    inline_keyboard: entries.slice(0, MAX_LISTED_CLIENTS).map((entry) => [{
      text: entry.label,
      callback_data: "cl|" + entry.chatId,
    }]),
  };
}

export function psyClientKeyboard(chatId) {
  return {
    inline_keyboard: [
      [{ text: "Звіт файлом", callback_data: "clr|" + chatId }],
      [{ text: "Відключити клієнта", callback_data: "cld|" + chatId }],
    ],
  };
}

export function psyAlert(clientName, lines) {
  return ["⚠️ <b>" + escapeHtml(clientName || "Клієнт") + "</b>"].concat(lines.map(escapeHtml), [
    "",
    "Клієнт бачить у боті екстрені контакти. Сповіщення не замінює Вашого фахового протоколу.",
  ]).join("\n");
}

export function psyClientJoined(name) {
  return "Новий клієнт: " + escapeHtml(name || "без імені") + ". Згоду надано, картка в /clients.";
}

export function psyClientRevoked(name) {
  return escapeHtml(name || "Клієнт") + ": згоду відкликано. Дані цього клієнта Вам більше не доступні.";
}

export function psyClientDeleted(name) {
  return escapeHtml(name || "Клієнт") + ": клієнт видалив свої дані з бота. Картка більше не доступна.";
}

export function psyClientNotes(name, notes) {
  return escapeHtml(name || "Клієнт") + (notes ? ": дозволено бачити нотатки про тиждень." : ": нотатки про тиждень тепер приховані.");
}

export function psyDisconnected(name) {
  return escapeHtml(name || "Клієнта") + " відключено. Дані клієнта Вам більше не доступні.";
}

export function adminApplication(user) {
  const psy = user.psy;
  return [
    "<b>Нова заявка фахівця</b>",
    "",
    "Ім'я: " + escapeHtml(psy.name),
    "Кваліфікація: " + escapeHtml(psy.credentials),
    "Telegram: " + (psy.username ? "@" + escapeHtml(psy.username) + ", " : "") + "id " + user.chatId,
  ].join("\n");
}

export function adminDecisionKeyboard(chatId) {
  return {
    inline_keyboard: [[
      { text: "Схвалити", callback_data: "ap|" + chatId },
      { text: "Відхилити", callback_data: "rj|" + chatId },
    ]],
  };
}

export function adminNoPending(approvedCount) {
  return "Нових заявок немає. Схвалених фахівців: " + approvedCount + ".";
}

export function adminDecided(name, approved) {
  return (approved ? "Схвалено: " : "Відхилено: ") + escapeHtml(name);
}

export function notAdmin() {
  return "Ця команда лише для власника бота.";
}

// The consent form. What is collected, what the specialist sees and does not
// see, why, how to withdraw, and the legal basis, in that order.
export function consentForm(psyName) {
  return [
    "<b>Згода на передачу даних фахівцю</b>",
    "",
    "<b>Хто:</b> " + escapeHtml(psyName) + ". Фахівця перевірив власник бота.",
    "",
    "<b>Що бот збирає про Вас:</b> відповіді й бали опитувальників, відмітки настрою, нотатки про тиждень, " +
      "налаштування нагадувань і Ваше ім'я в Telegram.",
    "",
    "<b>Що бачитиме фахівець:</b>",
    "• Ваше ім'я в Telegram;",
    "• бали, рівні й дати опитувальників;",
    "• відмітки настрою;",
    "• сповіщення, коли результат перетне поріг або в PHQ-9 буде позначено питання про думки щодо смерті.",
    "Нотатки про тиждень фахівець бачитиме, лише якщо Ви окремо це дозволите.",
    "",
    "<b>Чого фахівець не бачитиме:</b> Ваших повідомлень, контактів і нічого, крім результатів.",
    "",
    "<b>Навіщо:</b> щоб фахівець бачив динаміку між зустрічами і міг вчасно зреагувати.",
    "",
    "<b>Як відкликати:</b> будь-коли, одним натисканням у /privacy або кнопкою, яка з'явиться після згоди. " +
      "Доступ припиняється одразу, фахівець отримає сповіщення. Звіти, які фахівець уже завантажив, " +
      "залишаються в нього.",
    "",
    "<b>Ваші права:</b> /export вивантажує всі Ваші дані, /delete видаляє їх повністю.",
    "",
    "Дані про здоров'я обробляються лише з Вашої явної згоди (Закон України «Про захист персональних даних»). " +
      "Натискаючи «Погоджуюся», Ви її надаєте. Версія згоди: " + CONSENT_VERSION + ".",
  ].join("\n");
}

export function consentKeyboard(code) {
  return {
    inline_keyboard: [[
      { text: "Погоджуюся", callback_data: "cs|yes|" + code },
      { text: "Не погоджуюся", callback_data: "cs|no|" + code },
    ]],
  };
}

export function consentNotesQuestion() {
  return "Згоду надано. Дозволити фахівцю бачити також нотатки про тиждень?\n\nЦе можна змінити будь-коли в /privacy.";
}

export function consentNotesKeyboard(psyChatId) {
  return {
    inline_keyboard: [[
      { text: "Так, дозволити", callback_data: "cn|" + psyChatId + "|1" },
      { text: "Ні", callback_data: "cn|" + psyChatId + "|0" },
    ]],
  };
}

export function consentDone(psyName, notes) {
  return "Готово. " + escapeHtml(psyName) + " бачить Ваші результати" + (notes ? " і нотатки." : ", без нотаток.") +
    "\n\nКерувати згодою або відкликати її: /privacy. Нижче про те, що вміє бот.";
}

export function revokeKeyboard(psyChatId) {
  return { inline_keyboard: [[{ text: "Відкликати згоду", callback_data: "rv|" + psyChatId }]] };
}

export function consentDeclined() {
  return "Гаразд, фахівець нічого не бачить. Якщо передумаєте, відкрийте посилання ще раз.";
}

export function consentAlready(psyName) {
  return "Ви вже ділитеся даними з " + escapeHtml(psyName) + ". Керувати згодою: /privacy";
}

export function consentInvalid() {
  return "Посилання недійсне або застаріло. Попросіть у фахівця нове.";
}

export function consentOwnLink() {
  return "Це Ваше власне посилання для клієнтів.";
}

export function privacyMessage(rows) {
  const lines = ["<b>Мої згоди</b>", ""];
  if (!rows.length) lines.push("Ви не ділитеся даними з жодним фахівцем.");
  else rows.forEach((row) => lines.push("• " + escapeHtml(row)));
  lines.push("", "Що зберігає бот: /about. Вивантажити дані: /export. Видалити все: /delete.");
  return lines.join("\n");
}

export function privacyKeyboard(entries) {
  const rows = [];
  entries.forEach((entry) => {
    rows.push([{ text: "Відкликати: " + entry.name, callback_data: "rv|" + entry.psy }]);
    rows.push([{
      text: entry.notes ? "Приховати нотатки від: " + entry.name : "Показувати нотатки: " + entry.name,
      callback_data: "rn|" + entry.psy + "|" + (entry.notes ? "0" : "1"),
    }]);
  });
  return rows.length ? { inline_keyboard: rows } : undefined;
}

export function revoked(psyName) {
  return "Згоду відкликано. " + escapeHtml(psyName) + " більше не бачить Ваших даних.";
}

export function notesChanged(psyName, notes) {
  return notes
    ? escapeHtml(psyName) + " тепер бачить і нотатки про тиждень."
    : "Нотатки про тиждень приховано від: " + escapeHtml(psyName) + ".";
}

export function clientDisconnectedByPsy(psyName) {
  return "Доступ фахівця " + escapeHtml(psyName) + " до Ваших даних припинено. Крім Вас, їх більше ніхто не бачить.";
}

export function psyGone(psyName) {
  return "Фахівець " + escapeHtml(psyName) + " більше не користується ботом, тож доступ до Ваших даних припинено.";
}
