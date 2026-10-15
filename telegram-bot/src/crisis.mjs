// Crisis words typed as plain text, and a few simple intents. Zero
// dependencies. Node 16+.
//
// A person in crisis does not always find the button. "Мені погано", "хочу
// померти" or "помогите" typed into the chat must get the same help block as
// "Мені зараз погано", whatever else the bot was waiting for. The lists are
// Ukrainian and Russian, matched as whole phrases on a normalized text, so
// "погода погана" is not "мені погано". A false alarm costs one extra message
// with phone numbers; a missed one can cost more, so the lists lean wide.

// Lower case, one spelling for і/ї/и/ы, е/є/э/ё, no apostrophes, no
// punctuation, single spaces. The phrase lists go through the same function,
// so they can be written naturally.
export function normalizeText(text) {
  if (typeof text !== "string") return "";
  return text.toLowerCase()
    .replace(/[ʼ'’`´]/g, "")
    .replace(/[іїиы]/g, "и")
    .replace(/[єэё]/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const CRISIS_PHRASES = [
  // Ukrainian.
  "хочу померти", "хочеться померти", "краще б я помер", "краще б я померла", "не хочу жити",
  "не хочу більше жити", "не хочеться жити", "немає сенсу жити", "нема сенсу жити", "не бачу сенсу жити",
  "життя не має сенсу", "покінчити з собою", "покінчу з собою", "покінчити з життям", "накласти на себе руки",
  "вбити себе", "вбю себе", "убю себе", "самогубство", "суїцид", "суицид", "різати себе", "ріжу себе",
  "порізати себе", "порізала себе", "порізав себе", "завдати собі шкоди", "зашкодити собі", "шкоджу собі",
  "мені погано", "мені дуже погано", "мені зле", "мені дуже зле", "допоможіть", "допоможи мені",
  "хочу зникнути", "не можу більше", "не витримую", "краще б мене не було",
  // Russian.
  "хочу умереть", "хочется умереть", "не хочу жить", "не хочется жить", "нет смысла жить",
  "не вижу смысла жить", "жизнь не имеет смысла", "покончить с собой", "покончу с собой",
  "покончить с жизнью", "убить себя", "убью себя", "самоубийство", "резать себя", "режу себя",
  "порезать себя", "порезала себя", "порезал себя", "навредить себе", "причинить себе вред",
  "мне плохо", "мне очень плохо", "помогите", "помоги мне", "хочу исчезнуть", "не могу больше",
  "не выдерживаю", "лучше бы меня не было",
].map(normalizeText);

// True when the text holds one of the phrases as whole words.
function containsPhrase(normalized, phrases) {
  const padded = " " + normalized + " ";
  return phrases.some((phrase) => padded.indexOf(" " + phrase + " ") !== -1);
}

export function detectCrisis(text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return containsPhrase(normalized, CRISIS_PHRASES);
}

// What a free text most likely asks for, or null. Checked only after
// detectCrisis said no, so "допоможіть" never lands here.
const INTENTS = [
  { id: "greeting", words: ["привіт", "вітаю", "добрий день", "добрий вечір", "доброго ранку", "хай", "привет",
    "здравствуйте", "добрый день", "добрый вечер", "доброе утро", "hello", "hi", "hey"] },
  { id: "price", words: ["ціна", "скільки коштує", "скільки коштуе", "вартість", "оплата", "оплатити", "купити",
    "підписка", "цена", "сколько стоит", "стоимость", "оплатить", "купить", "подписка", "зірки", "звезды"] },
  { id: "test", words: ["тест", "тести", "опитувальник", "опитування", "пройти", "анкета", "опрос", "опросник",
    "gad7", "gad 7", "phq9", "phq 9"] },
  { id: "help", words: ["психолог", "психотерапевт", "терапевт", "допомога", "допомогу", "консультація",
    "консультацію", "фахівець", "помощь", "консультация", "специалист"] },
].map((intent) => Object.assign({}, intent, { words: intent.words.map(normalizeText) }));

export function detectIntent(text) {
  const normalized = normalizeText(text);
  if (!normalized) return null;
  const found = INTENTS.find((intent) => containsPhrase(normalized, intent.words));
  return found ? found.id : null;
}
