# Project context

Repository-wide context for any branch. Keep it short and factual.

## Owner and locale

- The owner lives in **Ukraine**.
- Locale defaults for anything user-facing: **Ukrainian language**, Kyiv time
  (`Europe/Kyiv`, UTC+2 in winter and UTC+3 in summer), Ukrainian emergency and
  support services.
- Write user-facing product text in Ukrainian. Code, comments, commit messages,
  and the unlazy skill's own documentation stay in English.
- Never fall back to Russian defaults (Moscow time, Russian hotlines) for this
  owner.

## telegram-bot/

GAD-7 and PHQ-9 screening bot. Zero dependencies, Node 16 floor, long polling.
See `telegram-bot/README.md`. Locale-bearing values:

| Value | Where |
| --- | --- |
| Questionnaire items, options, severity bands | `telegram-bot/src/instruments.mjs` |
| Practices, SOS steps, mood tags, booking options | `telegram-bot/src/selfhelp.mjs` |
| What full access opens, what stays free, price wording | `telegram-bot/src/offer.mjs`, shared with the Mini App |
| All user-facing copy | `telegram-bot/src/texts.mjs`, specialist mode and consent in `telegram-bot/src/psytexts.mjs`, plus inline strings in `telegram-bot/src/router.mjs` |
| Crisis contacts | `DEFAULT_CRISIS_CONTACT` in `telegram-bot/src/config.mjs`, overridable with `CRISIS_CONTACT` |
| Price, trial, entitlement | `telegram-bot/src/billing.mjs`, `PRICE_STARS` and `TRIAL_DAYS` |
| Default reminder zone and slot | `REMINDER_ZONE`, `REMINDER_WEEKDAY`, `REMINDER_TIME` in `telegram-bot/src/config.mjs`, per-user override with `/tz` |

Scheduling resolves the zone offset per instant from the platform time-zone
database, so the March and October transitions need no intervention. The
default slot is Monday 19:00 Europe/Kyiv. A user who runs `/tz <offset>` pins a
fixed offset and opts out of seasonal changes until `/tz auto`.

## Repository conventions

- Zero runtime dependencies, Node 16 compatible, ESM `.mjs`.
- No em dash or en dash in prose. Use a hyphen, a colon, or a sentence break.
- `npm test` must stay green, including `node telegram-bot/tests/run-tests.mjs`.

## Paid model

One-time purchase in Telegram Stars (`XTR`), 150 by default (`PRICE_STARS`), after a
7-day trial. The developer receives $0.013 a Star whatever the buyer paid, so a
price in Stars is not a price in hryvnias.

Free forever, and it must stay that way: taking GAD-7 and PHQ-9, the result
with its crisis block, the weekly note, `/export` and `/delete`, the self-help
practices, "Мені зараз погано" (`/sos`), the specialist report (`/report`) and
the consultation request (`/book`). A questionnaire that asks about self-harm
never ends in a payment prompt, and access to one's own health data is not a
feature to sell.

Paid: the sleep, stress, PCL-5, wellbeing and self-esteem scales, the daily
mood check-in (`/mood`), history (`/results`, `/last`), statistics, the weekly reminder and
its settings (`/remind`, `/tz`), and every week of "Мій персонаж" after the
first.

"Мій персонаж" (`telegram-bot/webapp/character.js`, Mini App only) is daily
challenges in three tiers, four weekly programs in turn (self-esteem, anxiety,
energy and mood, self-support), an aura that never burns, and a character who
changes place per level. Its copy uses «ти» and a chosen he/she form. A PHQ-9
with item 9 marked in the last 14 days switches it to care mode: crisis
contacts first, challenges paused. Locations, four characters in six poses,
pets, props and stickers are painted with `gemini-3.1-flash-lite-image` as
sprite sheets and keyed out. Images are welcome only from a model that follows
the prompt (keyless Pollinations returned an unrelated, sexualized picture and
is not used).

Crisis typed as text (`src/crisis.mjs`, `detectCrisis`): Ukrainian and
Russian phrases on a normalized text get the same block as "Мені зараз
погано", before a note, booking or application takes the text, which still
lands. For 30 days after such a phrase or a marked PHQ-9 item 9 (`atRisk` in
the router) the bot shows no unasked-for price, pay button or trial notice;
`/buy` and "⭐ Повний доступ" still answer. The Mini App gets `r=1` in its
URL and hides its offers too. Free text otherwise gets simple intents or the
menu, never "Не зрозумів команду". A crisis phrase also signals each
consented specialist: the fact and the time, never the words, once an hour,
only under consent `2026-10-v2` or later (`allowsCrisisSignal`); an older
consent is updated by the client in `/privacy`, never silently.

The privacy policy is `telegram-bot/webapp/privacy.html`, linked from
`/privacy`, `/about` and the app. Change it with any change to what is stored,
who sees it or how long it is kept. The owner's PC pulls a daily copy of the
snapshot (`deploy/pull-backup.ps1`, Task Scheduler "ModdTracker backup",
`%USERPROFILE%\ModdTrackerBackups`, 60 days); the policy states these terms.

Unasked messages besides the weekly reminder come from `habitActions` in the
router: the one-time daily mood offer, the 20:00 daily mood question, the
trial notice the day before it ends. Two unanswered daily questions silence
all of them, the weekly reminder included, until the person writes. The
owner's funnel is day counters in `store.meta.funnel`, never per person.
`npm run swarm` (`telegram-bot/tests/swarm.mjs`) must end with "no
violations".

The Mini App opened from the menu button cannot call `sendData`. It then opens
`t.me/<bot>?start=<code>` instead, and `parseStartCode` in `webapp.mjs` turns
the code back into the same payload, validated the same way.

The reply keyboard is the bot's menu: a main screen and five sections, every
function a button, each section leading back and on to the next, and "Мені
зараз погано" alone on the last row of every screen. Labels start with an emoji,
so typed text never matches one. The offer lives behind "⭐ Повний доступ": a
main-screen button for anyone who has not bought (gone after purchase), a Mini
App card, and `/buy`. It is a one-time purchase, so it is never labelled a
subscription.

Homework (`/homework`, the client card): a specialist with access and the
client's consent writes a task, the client is notified with a done button, and
the specialist hears back when it is done. Free for the client.

Specialist mode is a separate monthly Stars subscription, `PSY_PRICE_STARS` 300,
sold through `createInvoiceLink` with `subscription_period`. Who pays: a client
pays for the paid features they use; a specialist pays for the cabinet (client
list, cards, reports, alerts). The subscription unlocks nothing for clients.
The owner approves every specialist (`ADMIN_USERNAME`, bound to a chat id on
first contact, or `ADMIN_CHAT_ID`) and uses the cabinet free. `/stats` shows the
owner counts only, never a name, a score or a note. A specialist reads
a client only while approved, subscribed and holding that client's consent.
The consent form is versioned by `CONSENT_VERSION` in `psy.mjs`: change the
substance of the text, bump the version. Revoking stays one tap in `/privacy`.

PCL-5 is in the public domain and ships as published. WHO-5 was asked for but
is CC BY-NC-SA: no commercial use, and copying its items without the name is
the same breach. The wellbeing scale is written for this bot instead, like
sleep and stress, and it is the one scale where higher is better, so its
threshold is crossed from above (`higherIsBetter`, `crossesCutoff`).

The sleep, stress, wellbeing and self-esteem scales are written for this bot,
not taken from a published instrument (the self-esteem items restate no
Rosenberg item): ISI and PSS-10 are copyrighted and commercial use needs
the rightsholder's permission. Every result of the bot's own scales states that
it is self-observation and not a validated screening tool. Keep it that way, or
license a real instrument.

Every result also shows a short state description for its band and a support
line. The owner calls the support line "валідизація", meaning validation in the
therapeutic sense: normalizing the state and saying the scales exist to tell
whether help is worth seeking. It is not psychometric validation. A marked PHQ-9
risk item gets its own support line, which acknowledges the disclosure and never
calls the thoughts normal. Below the cutoff it also replaces the reassuring
low-band text.

Above a cutoff, or when the PHQ-9 risk item is marked, the bot offers a
prefilled `t.me/<CONTACT_USERNAME>?text=` draft naming the person's scores.
`CONTACT_USERNAME` defaults to the owner's account, `justajsi`, with
`CONTACT_NAME` "Олексій" and `CONTACT_ROLE` "психолог"; an explicitly empty
username switches the offer off, and an empty name or role just drops that part
of the wording. The role is a credential shown to someone who has just scored
above a cutoff, so it has to stay accurate.
Telegram never sends it; the person does. Emergency services always appear
before the personal contact, and `/contact` stays free.

Chart colours are per scale: anxiety red, depression dark blue, sleep light
blue, stress burgundy, PCL-5 green, wellbeing violet, self-esteem pink, mood
amber. The self-esteem pink has not been through the validator yet; for the
rest, light mode clears every check in the dataviz validator;
dark mode has one pair below the separation floor, which is why every chart
carries its name plus a swatch and no plot ever holds two scales.

## Helper LLM

The owner wants `justcallmejesi/freellmapi` used as a helper worker for bounded
tasks, with every result checked before use. Paused on 2026-09-28, resumed on
2026-10-14 at the owner's request. On the owner's PC it is cloned to
`C:\Users\1\freellmapi` with dependencies installed; it still has no provider
keys. Found so far:

- This environment's egress proxy blocks the provider hosts (Groq, OpenRouter,
  Cerebras, Mistral, keyless Kilo, OVH, AI Horde, LLM7). Only
  `generativelanguage.googleapis.com` (Gemini) answered. The owner has to widen
  Network access or allow those hosts, and add at least one free key as an
  environment variable (`GEMINI_API_KEY`, optionally `GROQ_API_KEY`,
  `OPENROUTER_API_KEY`), never pasted into chat.
- `npm ci` in the clone works. The server runs from `server/`
  (`npm run dev -w server`, port 3001), takes keys headless through
  `FREEAPI_CONFIG_JSON`, and follows `HTTPS_PROXY`. Still open: getting the
  unified `/v1` key without the dashboard.
- Never send client or health data, tokens, keys or personal data to it: free
  providers may log prompts, Kilo says it trains on them.
