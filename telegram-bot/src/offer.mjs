// What the one-time purchase opens, and what never needs it. Zero
// dependencies, Node 16+ and browsers.
//
// The chat and the Mini App both list this, so it lives in one file that
// webapp/build.mjs copies byte for byte: a list that drifted would promise one
// thing in the window and another in the chat. The scales come from the
// instrument definitions, so a new paid scale is listed without an edit here.

import { FREE_INSTRUMENT_LIST, PAID_INSTRUMENT_LIST } from "./instruments.mjs";

export const OFFER_TITLE = "Повний доступ";

// Each line reads after a bullet.
export function unlockedLines() {
  return PAID_INSTRUMENT_LIST.map((instrument) => instrument.title + ": " + instrument.subtitle).concat([
    "щоденна відмітка настрою з графіком",
    "історія всіх проходжень і статистика з графіками",
    "щотижневе нагадування і його налаштування",
  ]);
}

export function freeLines() {
  return FREE_INSTRUMENT_LIST.map((instrument) => instrument.title + ": " + instrument.subtitle +
    ", сам тест і результат").concat([
    "блок підтримки, якщо в PHQ-9 позначено ризик",
    "техніки самодопомоги і кнопка «Мені зараз погано»",
    "звіт для фахівця і запис на консультацію",
    "вивантаження і видалення даних: Ваші дані завжди Ваші",
  ]);
}

export function starWord(stars) {
  const last = stars % 10;
  const tens = stars % 100;
  if (tens >= 11 && tens <= 14) return "зірок";
  if (last === 1) return "зірка";
  if (last >= 2 && last <= 4) return "зірки";
  return "зірок";
}

export function priceLine(stars) {
  return stars + " " + starWord(stars) + " одноразово, без підписки";
}

export function payLabel(stars) {
  return "Відкрити повний доступ за " + stars + " " + starWord(stars);
}

// Where access stands, for the offer screen. `kind` is pro, trial, expired or
// none, as billing.entitlement() names it; none has nothing to say.
export function offerStatus(kind, daysLeft) {
  if (kind === "pro") return "✅ Відкрито назавжди. Дякую, що підтримали бота.";
  if (kind === "trial") {
    return "Зараз усе відкрито: безкоштовний період, залишилося днів " + daysLeft + ". " +
      "Потім платні функції закриються, а всі Ваші результати залишаться.";
  }
  if (kind === "expired") return "Безкоштовний період закінчився. Платні функції закриті, а всі Ваші результати збережені.";
  return "";
}
