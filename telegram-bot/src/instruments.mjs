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

// ISI uses a different label set per item, which is why options live on the
// item rather than on the instrument.
const ISI_SEVERITY = [
  { value: 0, label: "Немає" },
  { value: 1, label: "Легкі" },
  { value: 2, label: "Помірні" },
  { value: 3, label: "Серйозні" },
  { value: 4, label: "Дуже серйозні" },
];

const ISI_SATISFACTION = [
  { value: 0, label: "Дуже задоволений" },
  { value: 1, label: "Задоволений" },
  { value: 2, label: "Нейтрально" },
  { value: 3, label: "Незадоволений" },
  { value: 4, label: "Дуже незадоволений" },
];

const ISI_DEGREE = [
  { value: 0, label: "Зовсім ні" },
  { value: 1, label: "Трохи" },
  { value: 2, label: "Помірно" },
  { value: 3, label: "Сильно" },
  { value: 4, label: "Дуже сильно" },
];

export const ISI = {
  id: "isi",
  title: "ISI",
  subtitle: "скринінг безсоння",
  command: "/isi",
  prompt: "Оцініть свій сон протягом останніх 2 тижнів.",
  maxScore: 28,
  cutoff: 15,
  paid: true,
  items: [
    { text: "Труднощі із засинанням", options: ISI_SEVERITY, scored: true },
    { text: "Труднощі з підтриманням сну: прокидаєтеся вночі", options: ISI_SEVERITY, scored: true },
    { text: "Занадто раннє прокидання", options: ISI_SEVERITY, scored: true },
    { text: "Наскільки Ви задоволені своїм сном зараз?", options: ISI_SATISFACTION, scored: true },
    {
      text: "Наскільки, на Вашу думку, проблеми зі сном помітні іншим і псують якість Вашого життя?",
      options: ISI_DEGREE,
      scored: true,
    },
    { text: "Наскільки Ви занепокоєні своїм сном?", options: ISI_DEGREE, scored: true },
    { text: "Наскільки сон мішає Вашим щоденним справам?", options: ISI_DEGREE, scored: true },
  ],
  bands: [
    { max: 7, label: "без клінічно значущого безсоння" },
    { max: 14, label: "підпорогове безсоння" },
    { max: 21, label: "помірне безсоння" },
    { max: 28, label: "тяжке безсоння" },
  ],
};

const PSS_OPTIONS = [
  { value: 0, label: "Ніколи" },
  { value: 1, label: "Майже ніколи" },
  { value: 2, label: "Іноді" },
  { value: 3, label: "Досить часто" },
  { value: 4, label: "Дуже часто" },
];

const stress = (text, reverse = false) => ({ text, options: PSS_OPTIONS, scored: true, reverse });

export const PSS10 = {
  id: "pss10",
  title: "PSS-10",
  subtitle: "рівень стресу",
  command: "/stress",
  // A month, not two weeks: that is the window this scale is built around.
  prompt: "Як часто протягом останнього місяця Ви відчували або думали таке?",
  maxScore: 40,
  cutoff: 27,
  paid: true,
  items: [
    stress("Були засмучені через те, що сталося неочікувано?"),
    stress("Відчували, що не можете контролювати важливі речі у своєму житті?"),
    stress("Відчували нервозність і напруження?"),
    stress("Були впевнені у своїй здатності справлятися з особистими проблемами?", true),
    stress("Відчували, що все йде так, як Ви хочете?", true),
    stress("Відчували, що не справляєтеся з усім, що потрібно зробити?"),
    stress("Могли контролювати роздратування у своєму житті?", true),
    stress("Відчували, що тримаєте все під контролем?", true),
    stress("Гнівалися через те, що відбувалося поза Вашим контролем?"),
    stress("Відчували, що труднощів накопичилося так багато, що їх не подолати?"),
  ],
  bands: [
    { max: 13, label: "низький стрес" },
    { max: 26, label: "помірний стрес" },
    { max: 40, label: "високий стрес" },
  ],
};

export const INSTRUMENTS = { [GAD7.id]: GAD7, [PHQ9.id]: PHQ9, [ISI.id]: ISI, [PSS10.id]: PSS10 };
export const INSTRUMENT_LIST = [GAD7, PHQ9, ISI, PSS10];
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
