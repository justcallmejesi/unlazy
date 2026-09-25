// GAD-7 and PHQ-9 item text, answer options, scoring, and severity bands.
// User-facing text is Ukrainian. Zero dependencies. Node 16+.
//
// Scoring and band boundaries follow the published scoring instructions for
// both instruments. Item 10 of the PHQ-9 (functional impairment) is asked but
// never added to the total, which is how the instrument defines it.
//
//   Spitzer RL, Kroenke K, Williams JBW, Lowe B. A brief measure for assessing
//   generalized anxiety disorder: the GAD-7. Arch Intern Med 2006;166:1092-7.
//   Kroenke K, Spitzer RL, Williams JBW. The PHQ-9: validity of a brief
//   depression severity measure. J Gen Intern Med 2001;16:606-13.
//
// Every band carries a short description of what that level usually means, and
// every result gets a line of support: validation in the therapeutic sense, the
// owner's word for it, telling the person the score is understandable and what
// the scales are for. It is not psychometric validation, which the bot's own
// scales never had and say so in their caveat.

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

// Items worded the positive way round count backwards: "coped with what came
// my way" lowers the stress total instead of raising it.
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
    {
      max: 4,
      label: "мінімальна тривога",
      description: "Тривога майже не турбує. Хвилювання, якщо й буває, минає саме і не заважає звичному життю.",
    },
    {
      max: 9,
      label: "легка тривога",
      description: "Тривога часом помітна: напруження, неспокій, думки, які важко відпустити. " +
        "Здебільшого вона не заважає справам.",
    },
    {
      max: 14,
      label: "помірна тривога",
      description: "Тривога турбує більшу частину часу і, ймовірно, вже позначається на сні, " +
        "зосередженості або стосунках.",
    },
    {
      max: 21,
      label: "виражена тривога",
      description: "Тривога сильна й майже постійна. Імовірно, вона суттєво заважає працювати, " +
        "відпочивати і спілкуватися.",
    },
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
    {
      max: 4,
      label: "мінімальні прояви",
      description: "Ознак депресії майже немає: настрій, інтерес до справ і сили здебільшого в нормі.",
    },
    {
      max: 9,
      label: "легкі прояви",
      description: "Є окремі ознаки зниженого настрою, втоми або втрати інтересу, але вони здебільшого " +
        "не заважають звичному життю.",
    },
    {
      max: 14,
      label: "помірні прояви",
      description: "Знижений настрій, втома або втрата інтересу помітні більшу частину часу і, ймовірно, " +
        "вже впливають на повсякдення.",
    },
    {
      max: 19,
      label: "помірно тяжкі прояви",
      description: "Прояви депресії виражені й суттєво заважають працювати, відпочивати та спілкуватися.",
    },
    {
      max: 27,
      label: "тяжкі прояви",
      description: "Прояви депресії дуже сильні й зачіпають більшість сфер життя. У такому стані " +
        "особливо важливо не залишатися з цим наодинці.",
    },
  ],
};

// Sleep and stress are written for this bot rather than taken from a published
// instrument. ISI and PSS-10 would be the recognizable choices, but both are
// copyrighted and this bot is sold, so these two are original, carry no
// licence, and say plainly in every result that they are self-observation
// scales and not validated screening tools.

const OWN_SCALE_CAVEAT = "Це власна шкала самоспостереження цього бота, а не валідований опитувальник.";

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
  caveat: OWN_SCALE_CAVEAT,
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
    {
      max: 6,
      label: "сон спокійний",
      description: "Сон здебільшого спокійний, і вранці Ви почуваєтеся відпочилими.",
    },
    {
      max: 13,
      label: "легкі порушення сну",
      description: "Сон часом збивається: довше засинаєте, прокидаєтеся вночі або зранку почуваєтеся " +
        "не зовсім відпочилими.",
    },
    {
      max: 20,
      label: "помірні порушення сну",
      description: "Проблеми зі сном повторюються регулярно і, ймовірно, вже позначаються на силах " +
        "і настрої вдень.",
    },
    {
      max: 28,
      label: "виражені порушення сну",
      description: "Сон порушений більшість ночей. Недосип помітно виснажує і позначається на " +
        "самопочутті вдень.",
    },
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
  caveat: OWN_SCALE_CAVEAT,
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
    {
      max: 9,
      label: "низький рівень напруження",
      description: "Напруження невелике, і після навантажень Вам здебільшого вдається відновлюватися.",
    },
    {
      max: 19,
      label: "помірний рівень напруження",
      description: "Напруження відчутне: бувають періоди, коли справ забагато, а відпочинок допомагає " +
        "не повністю.",
    },
    {
      max: 32,
      label: "високий рівень напруження",
      description: "Напруження високе і тримається довго. Відпочинок мало допомагає, і сили, ймовірно, " +
        "на межі.",
    },
  ],
};

// PCL-5 is a work of the US National Center for PTSD and is in the public
// domain, so unlike ISI or PSS-10 it can ship in a paid product as published:
//   Weathers FW, Litz BT, Keane TM, Palmieri PA, Marx BP, Schnurr PP. The PTSD
//   Checklist for DSM-5 (PCL-5). National Center for PTSD, 2013.
// A total of 31 to 33 marks probable PTSD across samples (Bovin et al. 2016);
// 33 is the value the authors first proposed and the one used here. The
// Ukrainian wording is a working translation, like GAD-7 and PHQ-9.
const PCL_OPTIONS = [
  { value: 0, label: "Зовсім ні" },
  { value: 1, label: "Трохи" },
  { value: 2, label: "Помірно" },
  { value: 3, label: "Досить сильно" },
  { value: 4, label: "Надзвичайно" },
];

const pclItem = (text) => ({ text, options: PCL_OPTIONS, scored: true });

export const PCL5 = {
  id: "pcl5",
  title: "PCL-5",
  subtitle: "посттравматичний стрес",
  command: "/pcl5",
  prompt: "Нижче проблеми, які іноді виникають після дуже стресового досвіду. " +
    "Наскільки кожна з них турбувала Вас протягом останнього місяця?",
  maxScore: 80,
  cutoff: 33,
  paid: true,
  items: [
    pclItem("Повторювані, тривожні й небажані спогади про стресовий досвід"),
    pclItem("Повторювані тривожні сни про стресовий досвід"),
    pclItem("Раптові відчуття або дії, ніби стресова подія відбувається знову, ніби Ви знову там"),
    pclItem("Сильне засмучення, коли щось нагадувало про стресовий досвід"),
    pclItem("Сильні тілесні реакції, коли щось нагадувало про стресовий досвід: серцебиття, " +
      "важко дихати, пітливість"),
    pclItem("Уникання спогадів, думок або почуттів, пов'язаних зі стресовим досвідом"),
    pclItem("Уникання зовнішніх нагадувань про стресовий досвід: людей, місць, розмов, занять, " +
      "речей або ситуацій"),
    pclItem("Труднощі з пригадуванням важливих частин стресового досвіду"),
    pclItem("Сильні негативні переконання про себе, інших людей або світ, наприклад: " +
      "«зі мною щось серйозно не так», «нікому не можна довіряти», «світ цілком небезпечний»"),
    pclItem("Звинувачення себе або когось іншого у стресовій події чи в тому, що сталося після неї"),
    pclItem("Сильні негативні почуття: страх, жах, гнів, провина або сором"),
    pclItem("Втрата інтересу до занять, які раніше подобалися"),
    pclItem("Відчуття віддаленості або відірваності від інших людей"),
    pclItem("Труднощі з позитивними почуттями, наприклад з радістю або любов'ю до близьких"),
    pclItem("Дратівливість, спалахи гніву або агресивна поведінка"),
    pclItem("Надмірний ризик або дії, які можуть Вам зашкодити"),
    pclItem("Постійна настороженість або надмірна пильність"),
    pclItem("Схильність легко лякатися або здригатися"),
    pclItem("Труднощі з концентрацією"),
    pclItem("Труднощі із засинанням або уривчастий сон"),
  ],
  bands: [
    {
      max: 32,
      label: "прояви нижче порогу",
      description: "Реакції на пережитий стрес, якщо й є, не досягають рівня, за якого зазвичай " +
        "радять звернутися до фахівця.",
    },
    {
      max: 80,
      label: "виражені прояви посттравматичного стресу",
      description: "Спогади, напруження, уникання або постійна пильність після пережитого помітно " +
        "впливають на життя.",
    },
  ],
};

// Written for this bot in place of WHO-5: WHO publishes WHO-5 under CC BY-NC-SA,
// which rules out a paid product, and copying its items without the name would
// breach the same licence. None of these items restates a WHO-5 item. Higher
// is better here, the reverse of every other scale, so the threshold is
// crossed from above: a total at or below the cutoff is the worrying side.
const WELLBEING_OPTIONS = [
  { value: 0, label: "Ніколи" },
  { value: 1, label: "Рідко" },
  { value: 2, label: "Іноді" },
  { value: 3, label: "Часто" },
  { value: 4, label: "Майже завжди" },
];

const wellbeingItem = (text) => ({ text, options: WELLBEING_OPTIONS, scored: true });

export const WELLBEING = {
  id: "wellbeing",
  title: "Самопочуття",
  subtitle: "ресурс і опора",
  command: "/wellbeing",
  prompt: "Як часто протягом останніх 2 тижнів це було про Вас?",
  maxScore: 24,
  cutoff: 8,
  higherIsBetter: true,
  paid: true,
  caveat: OWN_SCALE_CAVEAT,
  items: [
    wellbeingItem("Вдавалося радіти дрібницям"),
    wellbeingItem("Відчували підтримку або зв'язок із близькими людьми"),
    wellbeingItem("Мали сили на справи, які для Вас важливі"),
    wellbeingItem("Знаходили час на те, що Вам подобається"),
    wellbeingItem("Відчували, що можете впливати на своє життя"),
    wellbeingItem("Бачили сенс у тому, що робите"),
  ],
  bands: [
    {
      max: 8,
      label: "низьке самопочуття",
      description: "Зараз мало ресурсу: радості, сил і відчуття опори бракує більшу частину часу.",
    },
    {
      max: 16,
      label: "помірне самопочуття",
      description: "Ресурс є, але нестійкий: добрі дні чергуються з виснажливими.",
    },
    {
      max: 24,
      label: "добре самопочуття",
      description: "Здебільшого вистачає сил, радості й відчуття, що життя у Ваших руках.",
    },
  ],
};

export const INSTRUMENTS = {
  [GAD7.id]: GAD7, [PHQ9.id]: PHQ9, [SLEEP.id]: SLEEP, [STRESS.id]: STRESS,
  [PCL5.id]: PCL5, [WELLBEING.id]: WELLBEING,
};
export const INSTRUMENT_LIST = [GAD7, PHQ9, SLEEP, STRESS, PCL5, WELLBEING];
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

// A score above the top band, which only a hand-edited snapshot can hold,
// falls into the top band rather than into none.
export function bandOf(instrument, score) {
  const band = instrument.bands.find((candidate) => score <= candidate.max);
  return band || instrument.bands[instrument.bands.length - 1];
}

export function severityOf(instrument, score) {
  return bandOf(instrument, score).label;
}

const SUPPORT_LOW = "Стан змінюється від тижня до тижня, і це нормально. Регулярні проходження " +
  "допоможуть вчасно помітити, якщо навантаження почне накопичуватися і знадобиться підтримка.";

const SUPPORT_HIGH = "Не лякайтеся цього результату: він не означає, що з Вами щось не так. " +
  "Найчастіше так проявляються сильний стрес, перевантаження або важкі обставини, і зараз через це " +
  "проходить багато людей. Ці шкали для того і потрібні: вони допомагають зрозуміти, чи варто " +
  "звернутися по підтримку, а не ставлять діагноз.";

// Acknowledge the disclosure, keep hope, point towards people. Never frame the
// thoughts as harmless or as something to wait out.
const SUPPORT_RISK = "Про думки щодо смерті чи самоушкодження непросто сказати навіть собі, і добре, " +
  "що Ви відповіли чесно. Такі думки бувають у людей, яким дуже важко, і не роблять Вас слабкими. " +
  "З цим можна впоратися, і не самотужки.";

// What a result means, a line of support, and what to do next, worded once for
// the chat and the app. A marked risk item outranks a low total: the
// reassuring words of the lower bands would contradict the crisis block shown
// beside them.
export function interpretResult(instrument, result) {
  const risk = Boolean(result.risk);
  const riskBelowCutoff = risk && !result.aboveCutoff;
  const worrying = instrument.higherIsBetter ? "не вище порогу " : "вище порогу ";
  const settled = instrument.higherIsBetter ? "вище порогу " : "нижче порогу ";
  let advice = "Бал " + settled + instrument.cutoff + ". Продовжуйте спостерігати за динамікою.";
  if (result.aboveCutoff) {
    advice = "Бал " + worrying + instrument.cutoff + ". Це підстава обговорити стан із лікарем або психотерапевтом.";
  } else if (riskBelowCutoff) {
    advice = "Бал нижче порогу " + instrument.cutoff + ", але цю відповідь варто обговорити з фахівцем, " +
      "не чекаючи наступного тесту.";
  }
  let support = SUPPORT_LOW;
  if (risk) support = SUPPORT_RISK;
  else if (result.aboveCutoff) support = SUPPORT_HIGH;
  return {
    description: riskBelowCutoff
      ? "Сума балів невисока, але одна з відповідей важливіша за суму."
      : bandOf(instrument, result.score).description,
    support,
    advice,
  };
}

export function riskFlagged(instrument, answers) {
  const risk = instrument.riskItem;
  if (!risk || !Array.isArray(answers)) return false;
  return Number(answers[risk.index]) >= risk.threshold;
}

// True when a score sits on the worrying side of the scale's threshold. The
// stored field keeps its historical name `aboveCutoff`; for a scale where
// higher is better, the worrying side is at or below the cutoff.
export function crossesCutoff(instrument, score) {
  return instrument.higherIsBetter ? score <= instrument.cutoff : score >= instrument.cutoff;
}

export function buildResult(instrument, answers, completedAtMs) {
  const score = scoreAnswers(instrument, answers);
  const impairmentIndex = instrument.items.findIndex((item) => !item.scored);
  return {
    instrument: instrument.id,
    score,
    maxScore: instrument.maxScore,
    severity: severityOf(instrument, score),
    aboveCutoff: crossesCutoff(instrument, score),
    risk: riskFlagged(instrument, answers),
    answers: answers.slice(),
    impairment: impairmentIndex === -1 ? null : answers[impairmentIndex],
    completedAt: new Date(completedAtMs).toISOString(),
  };
}
