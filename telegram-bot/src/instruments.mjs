// GAD-7 and PHQ-9 item text, answer options, scoring, and severity bands.
// User-facing text is Ukrainian. Zero dependencies. Node 16+.
//
// Scoring and band boundaries follow the published scoring instructions for
// both instruments. Item 10 of the PHQ-9 (functional impairment) is asked but
// never added to the total, which is how the instrument defines it.

const FREQUENCY_OPTIONS = [
  { value: 0, label: "Зовсім не турбували" },
  { value: 1, label: "Кілька днів" },
  { value: 2, label: "Більше половини днів" },
  { value: 3, label: "Майже щодня" },
];

const IMPAIRMENT_OPTIONS = [
  { value: 0, label: "Зовсім не ускладнювали" },
  { value: 1, label: "Дещо ускладнювали" },
  { value: 2, label: "Дуже ускладнювали" },
  { value: 3, label: "Надзвичайно ускладнювали" },
];

const scored = (text) => ({ text, options: FREQUENCY_OPTIONS, scored: true });

// The highest value an item's options offer, used to reverse-score.
function topValue(item) {
  return item.options.reduce((best, option) => Math.max(best, option.value), 0);
}

// PSS-10 asks four questions the positive way round, so their answers count
// backwards: "often felt in control" lowers the stress total.
export function itemContribution(item, answer) {
  return item.reverse ? topValue(item) - answer : answer;
}

export const GAD7 = {
  id: "gad7",
  title: "GAD-7",
  subtitle: "скринінг тривоги",
  command: "/gad7",
  prompt: "Як часто протягом останніх 2 тижнів Вас турбували такі проблеми?",
  maxScore: 21,
  cutoff: 10,
  items: [
    scored("Відчуття нервозності, тривоги або напруження"),
    scored("Неспроможність припинити хвилювання або контролювати його"),
    scored("Надмірне хвилювання з різних причин"),
    scored("Труднощі з розслабленням"),
    scored("Такий неспокій, що важко сидіти на місці"),
    scored("Дратівливість або спалахи гніву"),
    scored("Страх, що станеться щось жахливе"),
  ],
  bands: [
    { max: 4, label: "мінімальна тривога" },
    { max: 9, label: "легка тривога" },
    { max: 14, label: "помірна тривога" },
    { max: 21, label: "виражена тривога" },
  ],
};

export const PHQ9 = {
  id: "phq9",
  title: "PHQ-9",
  subtitle: "скринінг депресії",
  command: "/phq9",
  prompt: "Як часто протягом останніх 2 тижнів Вас турбували такі проблеми?",
  maxScore: 27,
  cutoff: 10,
  // Item 9 asks about thoughts of self-harm. Any answer above zero opens the
  // support block, independent of the total score.
  riskItem: { index: 8, threshold: 1 },
  items: [
    scored("Майже відсутній інтерес або задоволення від звичних справ"),
    scored("Знижений настрій, смуток або відчуття безнадії"),
    scored("Труднощі із засинанням, уривчастий сон або надто довгий сон"),
    scored("Відчуття втоми або брак сил"),
    scored("Поганий апетит або переїдання"),
    scored("Погана думка про себе: відчуття, що Ви невдаха або підвели близьких"),
    scored("Труднощі з концентрацією, наприклад під час читання або перегляду фільму"),
    scored("Помітна для інших загальмованість мовлення і рухів або, навпаки, надмірна рухливість"),
    scored("Думки про те, що Вам було б краще померти або завдати собі шкоди"),
    {
      text: "Наскільки ці проблеми ускладнювали Вам роботу, навчання, домашні справи або спілкування з людьми?",
      options: IMPAIRMENT_OPTIONS,
      scored: false,
    },
  ],
  bands: [
    { max: 4, label: "мінімальні прояви" },
    { max: 9, label: "легкі прояви" },
    { max: 14, label: "помірні прояви" },
    { max: 19, label: "помірно тяжкі прояви" },
    { max: 27, label: "тяжкі прояви" },
  ],
};

// Sleep and stress are written for this bot rather than taken from a published
// instrument. ISI and PSS-10 would be the recognizable choices, but both are
// copyrighted and this bot is sold, so these two are original, carry no
// licence, and say plainly in every result that they are self-observation
// scales and not validated screening tools.

const SLEEP_OPTIONS = [
  { value: 0, label: "Ніколи" },
  { value: 1, label: "Рідко" },
  { value: 2, label: "Іноді" },
  { value: 3, label: "Часто" },
  { value: 4, label: "Майже щоночі" },
];

const sleepItem = (text) => ({ text, options: SLEEP_OPTIONS, scored: true });

export const SLEEP = {
  id: "sleep",
  title: "Сон",
  subtitle: "щоденник сну",
  command: "/sleep",
  prompt: "Як часто протягом останніх 2 тижнів це було з Вами?",
  maxScore: 28,
  cutoff: 14,
  paid: true,
  caveat: "Це власна шкала самоспостереження цього бота, а не валідований опитувальник.",
  items: [
    sleepItem("Довго не могли заснути"),
    sleepItem("Прокидалися вночі і не могли заснути знову"),
    sleepItem("Прокидалися раніше, ніж потрібно, і вже не засинали"),
    sleepItem("Прокидалися втомленими, ніби зовсім не відпочили"),
    sleepItem("Хотілося спати вдень або було важко залишатися бодрим"),
    sleepItem("Лягали спати значно пізніше, ніж планували"),
    sleepItem("Хвилювалися через власний сон"),
  ],
  bands: [
    { max: 6, label: "сон спокійний" },
    { max: 13, label: "легкі порушення сну" },
    { max: 20, label: "помірні порушення сну" },
    { max: 28, label: "виражені порушення сну" },
  ],
};

const STRESS_OPTIONS = [
  { value: 0, label: "Ніколи" },
  { value: 1, label: "Рідко" },
  { value: 2, label: "Іноді" },
  { value: 3, label: "Часто" },
  { value: 4, label: "Дуже часто" },
];

// Two items are worded the other way round, so agreeing with everything cannot
// produce a high score by itself.
const stressItem = (text, reverse = false) => ({ text, options: STRESS_OPTIONS, scored: true, reverse });

export const STRESS = {
  id: "stress",
  title: "Стрес",
  subtitle: "рівень напруження",
  command: "/stress",
  prompt: "Як часто протягом останнього місяця Ви це відчували?",
  maxScore: 32,
  cutoff: 20,
  paid: true,
  caveat: "Це власна шкала самоспостереження цього бота, а не валідований опитувальник.",
  items: [
    stressItem("Напруження, від якого важко було розслабитися"),
    stressItem("Відчуття, що справ більше, ніж Ви здатні витримати"),
    stressItem("Роздратування через дрібниці"),
    stressItem("Відчуття, що Ви впоралися з тим, що на Вас звалилося", true),
    stressItem("Труднощі зосередитися через хвилювання"),
    stressItem("Відпочинок, після якого справді ставало легше", true),
    stressItem("Тілесне напруження: головний біль, стиснуті м'язи, важкість"),
    stressItem("Відчуття, що Ви не встигаєте за власним життям"),
  ],
  bands: [
    { max: 9, label: "низький рівень напруження" },
    { max: 19, label: "помірний рівень напруження" },
    { max: 32, label: "високий рівень напруження" },
  ],
};

export const INSTRUMENTS = { [GAD7.id]: GAD7, [PHQ9.id]: PHQ9, [SLEEP.id]: SLEEP, [STRESS.id]: STRESS };
export const INSTRUMENT_LIST = [GAD7, PHQ9, SLEEP, STRESS];
export const FREE_INSTRUMENT_LIST = INSTRUMENT_LIST.filter((instrument) => !instrument.paid);
export const PAID_INSTRUMENT_LIST = INSTRUMENT_LIST.filter((instrument) => instrument.paid);

export function getInstrument(id) {
  return Object.prototype.hasOwnProperty.call(INSTRUMENTS, id) ? INSTRUMENTS[id] : null;
}

export function scoredItemCount(instrument) {
  return instrument.items.filter((item) => item.scored).length;
}

// Answers arrive as one value per asked item, including unscored ones.
export function scoreAnswers(instrument, answers) {
  if (!Array.isArray(answers) || answers.length !== instrument.items.length) {
    throw new Error(instrument.title + " needs exactly " + instrument.items.length + " answers");
  }
  let total = 0;
  answers.forEach((answer, index) => {
    const item = instrument.items[index];
    const allowed = item.options.some((option) => option.value === answer);
    if (!allowed) throw new Error("answer " + index + " is outside the option set");
    if (item.scored) total += itemContribution(item, answer);
  });
  return total;
}

export function severityOf(instrument, score) {
  const band = instrument.bands.find((candidate) => score <= candidate.max);
  return band ? band.label : instrument.bands[instrument.bands.length - 1].label;
}

export function riskFlagged(instrument, answers) {
  const risk = instrument.riskItem;
  if (!risk || !Array.isArray(answers)) return false;
  return Number(answers[risk.index]) >= risk.threshold;
}

export function buildResult(instrument, answers, completedAtMs) {
  const score = scoreAnswers(instrument, answers);
  const impairmentIndex = instrument.items.findIndex((item) => !item.scored);
  return {
    instrument: instrument.id,
    score,
    maxScore: instrument.maxScore,
    severity: severityOf(instrument, score),
    aboveCutoff: score >= instrument.cutoff,
    risk: riskFlagged(instrument, answers),
    answers: answers.slice(),
    impairment: impairmentIndex === -1 ? null : answers[impairmentIndex],
    completedAt: new Date(completedAtMs).toISOString(),
  };
}
