// GAD-7 and PHQ-9 item text, answer options, scoring, and severity bands.
// Zero dependencies. Node 16+.
//
// Scoring and band boundaries follow the published scoring instructions for
// both instruments. Item 10 of the PHQ-9 (functional impairment) is asked but
// never added to the total, which is how the instrument defines it.

const FREQUENCY_OPTIONS = [
  { value: 0, label: "Совсем нет" },
  { value: 1, label: "Несколько дней" },
  { value: 2, label: "Больше половины дней" },
  { value: 3, label: "Почти каждый день" },
];

const IMPAIRMENT_OPTIONS = [
  { value: 0, label: "Совсем не трудно" },
  { value: 1, label: "Немного трудно" },
  { value: 2, label: "Очень трудно" },
  { value: 3, label: "Крайне трудно" },
];

const scored = (text) => ({ text, options: FREQUENCY_OPTIONS, scored: true });

export const GAD7 = {
  id: "gad7",
  title: "GAD-7",
  subtitle: "скрининг тревоги",
  command: "/gad7",
  prompt: "Как часто за последние 2 недели Вас беспокоили следующие проблемы?",
  maxScore: 21,
  cutoff: 10,
  items: [
    scored("Чувство нервозности, тревоги или взвинченности"),
    scored("Неспособность остановить беспокойство или контролировать его"),
    scored("Слишком сильное беспокойство по разным поводам"),
    scored("Трудности с расслаблением"),
    scored("Неусидчивость, трудно сидеть спокойно"),
    scored("Раздражительность или вспыльчивость"),
    scored("Страх, что случится что-то ужасное"),
  ],
  bands: [
    { max: 4, label: "минимальная тревога" },
    { max: 9, label: "легкая тревога" },
    { max: 14, label: "умеренная тревога" },
    { max: 21, label: "выраженная тревога" },
  ],
};

export const PHQ9 = {
  id: "phq9",
  title: "PHQ-9",
  subtitle: "скрининг депрессии",
  command: "/phq9",
  prompt: "Как часто за последние 2 недели Вас беспокоили следующие проблемы?",
  maxScore: 27,
  cutoff: 10,
  // Item 9 asks about thoughts of self-harm. Any answer above zero opens the
  // support block, independent of the total score.
  riskItem: { index: 8, threshold: 1 },
  items: [
    scored("Практически нет интереса или удовольствия от обычных занятий"),
    scored("Подавленное настроение, уныние или чувство безнадежности"),
    scored("Трудности с засыпанием, прерывистый сон или слишком долгий сон"),
    scored("Чувство усталости или упадок сил"),
    scored("Плохой аппетит или переедание"),
    scored("Плохое мнение о себе: чувство, что Вы неудачник или подвели близких"),
    scored("Трудности с концентрацией, например при чтении или просмотре фильма"),
    scored("Заметная окружающим замедленность речи и движений или, наоборот, суетливость"),
    scored("Мысли о том, что Вам лучше было бы умереть или причинить себе вред"),
    {
      text: "Насколько трудно эти проблемы делали для Вас работу, учебу, домашние дела или общение с людьми?",
      options: IMPAIRMENT_OPTIONS,
      scored: false,
    },
  ],
  bands: [
    { max: 4, label: "минимальная выраженность" },
    { max: 9, label: "легкая выраженность" },
    { max: 14, label: "умеренная выраженность" },
    { max: 19, label: "умеренно тяжелая выраженность" },
    { max: 27, label: "тяжелая выраженность" },
  ],
};

export const INSTRUMENTS = { [GAD7.id]: GAD7, [PHQ9.id]: PHQ9 };
export const INSTRUMENT_LIST = [GAD7, PHQ9];

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
    if (item.scored) total += answer;
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
