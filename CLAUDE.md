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
| All user-facing copy | `telegram-bot/src/texts.mjs`, plus inline strings in `telegram-bot/src/router.mjs` |
| Crisis contacts | `DEFAULT_CRISIS_CONTACT` in `telegram-bot/src/config.mjs`, overridable with `CRISIS_CONTACT` |
| Default reminder time zone | `REMINDER_UTC_OFFSET` in `telegram-bot/src/config.mjs`, per-user override with `/tz` |

Scheduling uses fixed UTC offsets, so the Kyiv default needs changing at the
March and October transitions until it is made time-zone aware.

## Repository conventions

- Zero runtime dependencies, Node 16 compatible, ESM `.mjs`.
- No em dash or en dash in prose. Use a hyphen, a colon, or a sentence break.
- `npm test` must stay green, including `node telegram-bot/tests/run-tests.mjs`.
