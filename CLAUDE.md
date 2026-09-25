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

One-time purchase in Telegram Stars (`XTR`) after a 14-day trial.

Free forever, and it must stay that way: taking GAD-7 and PHQ-9, the result
with its crisis block, the weekly note, `/export` and `/delete`, the self-help
practices, "Мені зараз погано" (`/sos`), the specialist report (`/report`) and
the consultation request (`/book`). A questionnaire that asks about self-harm
never ends in a payment prompt, and access to one's own health data is not a
feature to sell.

Paid: the sleep, stress, PCL-5 and wellbeing scales, the daily mood check-in
(`/mood`), history (`/results`, `/last`), statistics, the weekly reminder and
its settings (`/remind`, `/tz`).

Specialist mode is a separate monthly Stars subscription, `PSY_PRICE_STARS` 177,
sold through `createInvoiceLink` with `subscription_period`. Who pays: a client
pays for the paid features they use; a specialist pays for the cabinet (client
list, cards, reports, alerts). The subscription unlocks nothing for clients.
The owner approves every specialist (`ADMIN_USERNAME`, bound to a chat id on
first contact, or `ADMIN_CHAT_ID`) and uses the cabinet free. A specialist reads
a client only while approved, subscribed and holding that client's consent.
The consent form is versioned by `CONSENT_VERSION` in `psy.mjs`: change the
substance of the text, bump the version. Revoking stays one tap in `/privacy`.

PCL-5 is in the public domain and ships as published. WHO-5 was asked for but
is CC BY-NC-SA: no commercial use, and copying its items without the name is
the same breach. The wellbeing scale is written for this bot instead, like
sleep and stress, and it is the one scale where higher is better, so its
threshold is crossed from above (`higherIsBetter`, `crossesCutoff`).

The sleep, stress and wellbeing scales are written for this bot, not taken from a
published instrument: ISI and PSS-10 are copyrighted and commercial use needs
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
blue, stress burgundy, PCL-5 green, wellbeing violet, mood amber. Light mode clears every check in the dataviz validator;
dark mode has one pair below the separation floor, which is why every chart
carries its name plus a swatch and no plot ever holds two scales.
