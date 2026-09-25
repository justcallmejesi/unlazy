// A one-page report for a specialist, built from the bot's own store as a
// self-contained HTML document: it opens in any browser, prints to A4 and
// saves as PDF from the print dialog, with no dependency and no font to embed.
// User-facing text is Ukrainian. Zero dependencies. Node 16+.
//
// Free, like /export: it is the person's own data, arranged for the moment
// they decide to show it to someone who can help.

import { INSTRUMENT_LIST, severityOf } from "./instruments.mjs";
import { MOOD_MAX, MOOD_MIN, MOOD_TAGS } from "./selfhelp.mjs";
import { offsetAt } from "./reminders.mjs";

// The light steps of the Mini App's series colours; a test keeps them equal to
// the app's CSS so a scale wears one colour everywhere. The report is a paper
// document, so only the light set applies.
export const REPORT_COLORS = {
  gad7: "#e14b30",
  phq9: "#2f4fa8",
  sleep: "#2e9bd4",
  stress: "#8f1f3f",
  pcl5: "#008300",
  wellbeing: "#6a45c2",
  mood: "#c98500",
};

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function localDate(schedule, ms) {
  const local = new Date(ms + offsetAt(schedule, ms) * 60 * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return pad(local.getUTCDate()) + "." + pad(local.getUTCMonth() + 1) + "." + local.getUTCFullYear();
}

function isoToDate(date) {
  return date.slice(8, 10) + "." + date.slice(5, 7) + "." + date.slice(0, 4);
}

// One series per chart, one scale per axis: the same small-multiple rule as
// the Mini App. Static, because this is a document; the table under each chart
// carries every value the line shows.
function chartSvg(points, options) {
  const width = 700;
  const height = 190;
  const pad = { top: 14, right: 34, bottom: 26, left: 34 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const { min, max, color, cutoff, label } = options;
  const x = (index) => points.length === 1 ? pad.left + plotW / 2 : pad.left + (index / (points.length - 1)) * plotW;
  const y = (value) => pad.top + plotH - ((value - min) / (max - min)) * plotH;
  const parts = [];
  // The threshold is labelled in the gutter, in the middle tick's place, so
  // its label never lands on a line that starts near it.
  const hasCutoff = cutoff !== null && cutoff !== undefined;
  const ticks = hasCutoff ? [min, max] : [min, Math.round((min + max) / 2), max];
  ticks.forEach((value) => {
    parts.push('<line class="grid" x1="' + pad.left + '" x2="' + (pad.left + plotW) + '" y1="' + y(value) +
      '" y2="' + y(value) + '"/>');
    parts.push('<text class="axis" x="' + (pad.left - 6) + '" y="' + (y(value) + 4) + '" text-anchor="end">' +
      value + "</text>");
  });
  if (hasCutoff) {
    parts.push('<line class="cut" x1="' + pad.left + '" x2="' + (pad.left + plotW) + '" y1="' + y(cutoff) +
      '" y2="' + y(cutoff) + '"/>');
    parts.push('<text class="cut-text" x="' + (pad.left - 6) + '" y="' + (y(cutoff) + 4) + '" text-anchor="end">' +
      cutoff + "</text>");
  }
  if (points.length > 1) {
    parts.push('<path class="line" stroke="' + color + '" d="' +
      points.map((point, index) => (index ? "L" : "M") + x(index).toFixed(1) + " " + y(point.value).toFixed(1)).join(" ") +
      '"/>');
  }
  points.forEach((point, index) => {
    parts.push('<circle class="dot" cx="' + x(index).toFixed(1) + '" cy="' + y(point.value).toFixed(1) +
      '" r="4.5" fill="' + color + '"/>');
  });
  const last = points[points.length - 1];
  parts.push('<text class="end" x="' + Math.min(x(points.length - 1) + 7, width - 2).toFixed(1) + '" y="' +
    (y(last.value) - 9).toFixed(1) + '" text-anchor="' + (points.length === 1 ? "middle" : "end") + '">' +
    last.value + "</text>");
  parts.push('<text class="axis" x="' + pad.left + '" y="' + (height - 7) + '">' + esc(points[0].label) + "</text>");
  if (points.length > 1) {
    parts.push('<text class="axis" x="' + (pad.left + plotW) + '" y="' + (height - 7) + '" text-anchor="end">' +
      esc(last.label) + "</text>");
  }
  return '<svg viewBox="0 0 ' + width + " " + height + '" role="img" aria-label="' + esc(label) + '">' +
    parts.join("") + "</svg>";
}

function scaleSection(instrument, entries, schedule, includeNotes) {
  const color = REPORT_COLORS[instrument.id] || "#52514e";
  const last = entries[entries.length - 1];
  const direction = instrument.higherIsBetter ? ", тут вищий бал означає кращий стан" : "";
  const points = entries.map((entry) => ({
    value: entry.score,
    label: localDate(schedule, Date.parse(entry.completedAt)),
  }));
  const lastSeverity = typeof last.severity === "string" ? last.severity : severityOf(instrument, last.score);
  const rows = entries.slice().reverse().map((entry) => {
    const severity = typeof entry.severity === "string" ? entry.severity : severityOf(instrument, entry.score);
    const note = includeNotes && entry.note ? '<td class="note">' + esc(entry.note) + "</td>" : includeNotes ? "<td></td>" : "";
    return "<tr><td>" + esc(localDate(schedule, Date.parse(entry.completedAt))) + '</td><td class="num">' +
      entry.score + " / " + instrument.maxScore + "</td><td>" + esc(severity) + "</td>" + note + "</tr>";
  });
  return [
    "<section>",
    '<h2><span class="swatch" style="background:' + color + '"></span>' + esc(instrument.title) +
      ': <span class="sub">' + esc(instrument.subtitle) + "</span></h2>",
    '<p class="summary">Останній результат: <b>' + last.score + " з " + instrument.maxScore + "</b>, " +
      esc(lastSeverity) + " (" + esc(localDate(schedule, Date.parse(last.completedAt))) + "). Проходжень: " +
      entries.length + ". Поріг: " + instrument.cutoff + esc(direction) + ".</p>",
    chartSvg(points, {
      min: 0, max: instrument.maxScore, color, cutoff: instrument.cutoff,
      label: instrument.title + ": " + entries.length + " проходжень, останній бал " + last.score + " з " + instrument.maxScore,
    }),
    "<table><tr><th>Дата</th><th>Бал</th><th>Оцінка</th>" + (includeNotes ? "<th>Нотатка про тиждень</th>" : "") +
      "</tr>" + rows.join("") + "</table>",
    instrument.caveat ? '<p class="caveat">' + esc(instrument.caveat) + "</p>" : "",
    "</section>",
  ].join("\n");
}

function moodSection(moods) {
  const points = moods.map((entry) => ({ value: entry.rating, label: isoToDate(entry.date) }));
  const average = (list) => list.reduce((sum, entry) => sum + entry.rating, 0) / list.length;
  const format = (value) => value.toFixed(1).replace(".", ",");
  const recent = moods.slice(-7);
  const counts = MOOD_TAGS.map((tag) => ({
    label: tag.label,
    count: moods.filter((entry) => entry.tags.indexOf(tag.id) !== -1).length,
  })).filter((tag) => tag.count > 0).sort((left, right) => right.count - left.count);
  return [
    "<section>",
    '<h2><span class="swatch" style="background:' + REPORT_COLORS.mood + '"></span>Настрій: <span class="sub">щоденна відмітка від 1 до 10</span></h2>',
    '<p class="summary">Відміток: ' + moods.length + ". Середнє за весь час: <b>" + format(average(moods)) +
      "</b>, за останні " + recent.length + ": <b>" + format(average(recent)) + "</b>.</p>",
    chartSvg(points, {
      min: MOOD_MIN, max: MOOD_MAX, color: REPORT_COLORS.mood, cutoff: null,
      label: "Настрій: " + moods.length + " відміток, остання " + moods[moods.length - 1].rating + " з 10",
    }),
    counts.length
      ? '<p class="summary">Що найчастіше впливало: ' +
        counts.map((tag) => esc(tag.label) + " (" + tag.count + ")").join(", ") + ".</p>"
      : "",
    "</section>",
  ].join("\n");
}

// `user` is the store's user object. Returns null when there is nothing to
// report, so the caller can say so instead of sending an empty page.
export function buildReport(user, options = {}) {
  const schedule = options.schedule;
  const includeNotes = Boolean(options.includeNotes);
  const generatedAt = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const results = Array.isArray(user && user.results) ? user.results : [];
  const moods = Array.isArray(user && user.moods) ? user.moods : [];
  if (!results.length && !moods.length) return null;

  const sections = INSTRUMENT_LIST.map((instrument) => {
    const entries = results.filter((entry) => entry.instrument === instrument.id && Number.isFinite(entry.score) &&
      Number.isFinite(Date.parse(entry.completedAt)));
    return entries.length ? scaleSection(instrument, entries, schedule, includeNotes) : "";
  }).filter(Boolean);
  if (moods.length) sections.push(moodSection(moods));

  const stamps = results.map((entry) => Date.parse(entry.completedAt)).filter(Number.isFinite);
  const moodStamps = moods.map((entry) => Date.parse(entry.date + "T12:00:00Z")).filter(Number.isFinite);
  const all = stamps.concat(moodStamps);
  const period = all.length
    ? "Період: з " + localDate(schedule, Math.min.apply(null, all)) + " по " + localDate(schedule, Math.max.apply(null, all)) + ". "
    : "";
  const published = INSTRUMENT_LIST.filter((instrument) => !instrument.caveat).map((instrument) => instrument.title);
  const own = INSTRUMENT_LIST.filter((instrument) => instrument.caveat).map((instrument) => instrument.title);

  return [
    "<!DOCTYPE html>",
    '<html lang="uk">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>Звіт самоспостереження</title>",
    "<style>",
    ":root { color-scheme: light; --ink: #0b0b0b; --ink-2: #52514e; --muted: #6b6a66; --line: #e1e0d9; --grid: #ebeae4; --surface: #ffffff; }",
    "html { background: var(--surface); }",
    "body { font: 15px/1.5 system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif; color: var(--ink); background: var(--surface); max-width: 760px; margin: 0 auto; padding: 24px 20px 40px; }",
    "h1 { font-size: 22px; margin: 0 0 4px; }",
    ".meta { color: var(--ink-2); font-size: 13px; margin: 0 0 8px; }",
    "section { margin: 26px 0 0; break-inside: avoid; page-break-inside: avoid; }",
    "h2 { font-size: 17px; margin: 0 0 4px; display: flex; align-items: center; gap: 8px; }",
    "h2 .sub { font-weight: 400; color: var(--ink-2); }",
    ".swatch { width: 10px; height: 10px; border-radius: 3px; display: inline-block; flex: none; }",
    ".summary { color: var(--ink-2); font-size: 14px; margin: 0 0 8px; }",
    ".caveat { color: var(--ink-2); font-size: 12px; font-style: italic; margin: 6px 0 0; }",
    "svg { width: 100%; height: auto; display: block; overflow: visible; }",
    ".grid { stroke: var(--grid); stroke-width: 1; }",
    ".axis { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }",
    ".cut { stroke: var(--muted); stroke-width: 1; stroke-dasharray: 3 3; }",
    ".cut-text { fill: var(--ink-2); font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }",
    ".line { fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }",
    ".dot { stroke: var(--surface); stroke-width: 2; }",
    ".end { fill: var(--ink); font-size: 12px; font-weight: 600; }",
    "table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px; }",
    "th, td { text-align: left; padding: 6px; border-bottom: 1px solid var(--line); vertical-align: top; }",
    "th { color: var(--muted); font-weight: 600; font-size: 12px; }",
    "td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }",
    "td.note { color: var(--ink-2); white-space: pre-wrap; }",
    "footer { margin-top: 30px; padding-top: 12px; border-top: 1px solid var(--line); color: var(--ink-2); font-size: 12px; }",
    "@page { size: A4; margin: 16mm; }",
    "@media print { body { padding: 0; max-width: none; } }",
    "</style>",
    "</head>",
    "<body>",
    "<h1>Звіт самоспостереження</h1>",
    '<p class="meta">' + esc(period) + "Сформовано " + esc(localDate(schedule, generatedAt)) + ". " +
      (includeNotes ? "З нотатками про тиждень." : "Без нотаток.") + "</p>",
    sections.join("\n"),
    "<footer>",
    "<p>Звіт сформовано ботом самоспостереження. Бали не є діагнозом: це матеріал для розмови з фахівцем. " +
      "Пунктир на кожному графіку це поріг шкали, його значення підписане на осі.</p>",
    "<p>" + esc(published.join(", ")) + ": опубліковані скринінгові інструменти, формулювання в боті це робочий " +
      "український переклад. " + esc(own.join(", ")) + ": власні шкали самоспостереження бота, а не валідовані " +
      "опитувальники.</p>",
    "</footer>",
    "</body>",
    "</html>",
  ].join("\n");
}
