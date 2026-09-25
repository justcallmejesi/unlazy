# Changelog

## Unreleased, target 2.1.0

This section describes the current source tree. It does not claim that `2.1.0` has a Git tag or GitHub Release.

### Telegram screening bot

- Add PCL-5 (20 items, 0 to 80, cutoff 33), in the public domain as a work of the US National Center for PTSD, and a six-item wellbeing scale written for the bot. The wellbeing scale is there because WHO-5 is licensed CC BY-NC-SA: no commercial use, and copying its items without the name would be the same breach. It is the first scale where higher is better, so `crossesCutoff` reads the threshold from above, and the advice wording follows the direction. Both scales are part of full access.
- Add a daily mood check-in, `/mood`, part of full access. One tap from 1 to 10 saves the day's entry, keyed to the person's local date. Optional tags follow, and a second tap the same day replaces the first. The Mini App charts it as a series of its own, and `/export`, `/delete` and the specialist report include it.
- Add self-help practices, free. Every result carries "Що можна зробити зараз" with two short practices matched to its scale, `/selfhelp` lists all six, and a low mood rating offers them too. The texts live in `src/selfhelp.mjs`, which is copied into the Mini App like `instruments.mjs`, and `webapp/build.mjs` now keeps both copies current.
- Add "🆘 Мені зараз погано", free. A reply-keyboard button that is always in reach, plus `/sos`, answered before anything else a message could mean: three steps for right now, the emergency numbers and support lines, then the configured contact. It also closes an open note question, so the button press is never saved as a note. The Mini App has the same screen, with tappable numbers.
- Add a specialist report, free: `/report` and a Mini App button send a self-contained HTML document with a chart and table per scale, mood with its most frequent tags, and weekly notes only when asked for. It opens in any browser and prints to A4 or PDF. Notes are escaped. The API client learned multipart uploads for `sendDocument`.
- Add a consultation request, `/book`, free. It asks for format, convenient time and a short request, and optionally the latest scores, then offers a prefilled draft to the configured contact that the person sends themselves. The help offer gains a booking button. The Mini App has a form for the same.
- Move the chart threshold label into the axis gutter, in both the app and the report, because inside the plot it collided with any run that started near the threshold. Result titles read "<scale>: готово", because "Самопочуття готовий" disagreed in gender. The hidden attribute now always wins over a class that sets display.

- Add three parts to every result, in the chat and in the Mini App alike: a short description of what the band usually means, a line of support, and the advice. The support line is validation in the therapeutic sense. Below the cutoff it says the state shifts from week to week and that regular runs catch a building load. Above it, it says not to be frightened, that high scores usually reflect strong stress, overload or hard circumstances, and that the scales exist to tell whether support is worth seeking. `interpretResult` in `src/instruments.mjs` words all three once for both surfaces. A marked PHQ-9 risk item changes the wording. The support line acknowledges the disclosure and points towards people, and never calls the thoughts normal. A low total then drops the reassuring band text and the "keep watching" advice. The crisis block comes before the fine print, and the Mini App result screen gains the own-scale caveat it was missing.

- Document deploying to a server with no IPv4 address. Everything the bot and the installer need is reachable over IPv6 (`api.telegram.org`, the Ubuntu archives, NodeSource), and the installer never calls git; only GitHub lacks IPv6 entirely, so the code travels by `scp` from a machine that has IPv4. The pre-payment checklist now includes a request to `github.com` as the IPv4 probe, since a failure there is the one symptom that matters.

- Replace ISI and PSS-10 with scales written for this bot: "Сон" (7 items, 0 to 28) and "Стрес" (8 items, 0 to 32, two of them reverse scored so agreeing with everything cannot produce a high score). Both are copyright-free, and every result of theirs says in as many words that it is self-observation rather than a validated screening tool. ISI and PSS-10 are copyrighted and this bot is sold, which made the swap the honest option; GAD-7 and PHQ-9 stay because they carry an explicit no-permission-required notice.
- Default `CONTACT_USERNAME`, `CONTACT_NAME` and `CONTACT_ROLE` to the owner's details so the help offer works with nothing configured: an explicitly empty username still switches it off, and an empty name or role drops just that part of the wording. Phrase the offer with a colon before the name, because Ukrainian would decline it and the bot cannot decline an arbitrary name.
- Offer a route to a person when a score crosses its cutoff or the PHQ-9 risk item is marked: an inline button opening `t.me/<username>?text=` with a draft that names every scale the person has taken, plus the same text as a copy block for clients that ignore the prefill. Telegram fills the box and never sends, so the decision to share health data stays with the person. Emergency services always come first, `/contact` works any time and stays free after the trial, and the whole offer is off unless `CONTACT_USERNAME` is set.

- Give each scale its own colour: anxiety red, depression dark blue, sleep light blue, stress burgundy, stepped separately for the light and the dark surface. The light set clears every check in the validator, including both separation floors. On the dark surface the navy and the light blue must be lifted to stay legible and end up 10.9 apart against a floor of 15, so colour is never the only cue: every chart carries its name with a swatch beside it, every tile its label, and no plot holds two scales.
- Narrow the free tier to the two screening tests. Free forever: taking GAD-7 and PHQ-9, the result with its crisis block, the weekly note, `/export` and `/delete`. Behind the one-time purchase: ISI and PSS-10, `/results` and `/last`, statistics, and the weekly reminder along with `/remind` and `/tz`. A lapsed chat is filtered out of the reminder sweep before any slot is computed, and its slot is left unmarked rather than recorded as sent.

- Add two scales: ISI for sleep (7 items, 0 to 28, its own option labels per item) and PSS-10 for stress (10 items, 0 to 40, asked over a month). PSS-10 needs reverse scoring, so an item can now declare `reverse` and contribute `max - answer`: all zeros scores 16, not 0, because never feeling in control is itself stress. Statistics cover every scale, each in its own small multiple with its own range and its own threshold line.
- Sell one-time full access in Telegram Stars after a 14-day trial, in `src/billing.mjs`. `sendInvoice` with `currency: "XTR"` and no provider token, a pre-checkout answer that verifies the payload belongs to that chat, and access granted only by the `telegram_payment_charge_id` a refund would need, so a hand-edited `"pro": true` grants nothing. The trial is handed out once and cannot be restarted by sending `/start` again. `/buy`, `/paysupport` and a documented `refundStarPayment` call round it out.
- Keep the screening core free forever: GAD-7, PHQ-9, the weekly reminder, the crisis block, `/export` and `/delete`. ISI, PSS-10, history past 8 entries and statistics are the paid part. The Mini App is told the state through `?pro=` in its launch URL as a hint only; the bot refuses to store a locked scale whatever the client claims.
- Use one accent colour for all four charts. Four hues cannot clear the colour-blind separation floors under the all-pairs rule that small multiples require, and colour carries no identity here: every scale has its own titled plot.

- Resolve the reminder time zone per instant instead of pinning a fixed offset, so the local send hour survives the March and October transitions with nothing to edit twice a year. Offsets come from the platform time-zone database through `Intl`; a Node built without full ICU falls back to the EU rule computed arithmetically (01:00 UTC on the last Sunday of March and of October), and a test compares the two across four years of daily samples. `nextDueAfter` shifts by the change in offset between consecutive slots rather than adding seven days of elapsed time, which would land an hour off across a transition.
- Move the default slot to Monday 19:00 Europe/Kyiv and make the day configurable with `REMINDER_WEEKDAY`. Every user-facing string that named a weekday now derives it from the schedule. `REMINDER_ZONE` replaces `REMINDER_UTC_OFFSET` as the default; setting an offset still works and then deliberately follows no seasonal rule.
- Add `/tz auto` and an "automatic" option in the Mini App to undo a per-user fixed offset. Dates in `/results`, `/last` and the delta line are rendered in the offset that was in effect at that instant, so a summer result keeps its summer wall-clock time after the October change.

- Add `telegram-bot/deploy/`: a hardened systemd unit running under an unprivileged `gad7bot` user with the results kept in `StateDirectory` outside the checkout, an idempotent installer for Ubuntu 24.04 LTS and Debian 12 that verifies Telegram reachability and the virtualization type before anything else and installs Node 22 LTS when the system Node predates 18, a daily backup timer that validates each copy parses as JSON and can push the newest off the machine, and a step-by-step guide. A test pins that the unit, installer, backup script and guide agree on every path, and that the hardening switch V8 cannot tolerate stays off.

- Add an optional Telegram Mini App at `telegram-bot/webapp/`: one full-width keyboard button opens a window over the chat carrying the questionnaires, statistics with charts, history, reminder settings and data management, and only the result is posted back to the chat. It needs static https hosting and no API of its own: results travel back through `sendData` and the statistics read Telegram CloudStorage. The bot treats the payload as untrusted, validating every field in `src/webapp.mjs` and recomputing the score from the answers rather than accepting one. Set `WEBAPP_URL` to enable it; unset, the chat flow is unchanged.
- Keep one source of truth for the questionnaires: `webapp/instruments.mjs` is a copy of `src/instruments.mjs` refreshed by `webapp/build.mjs`, and a test fails when it is stale, so wording and bands cannot differ between window and chat.

- Ask one open question after the scored items: describe the week in your own words. The score is stored before the question is asked, so skipping it, ignoring it, or losing the prompt to a restart never costs the result; the note is attached to the already stored entry. A skip button, a 1000 character bound, HTML escaping on display, a snippet in `/results` and the full text in `/last`, inclusion in `/export`, and removal with `/delete`. Reading commands leave the question open while starting a run, `/cancel` and `/delete` close it.

- Localize the bot for Ukraine. All user-facing text is Ukrainian: questionnaire items, answer options, severity bands, every command reply, and the reminder. The support block now lists Ukrainian services (103 and 112, LifeLine Ukraine 7333, the national children's line 116 111, howareu.com) with each number verified against the operator's own page and cited in the bot README. The default reminder offset documents Kyiv time as UTC+2 in winter and UTC+3 in summer.
- Record repository-wide owner context in `CLAUDE.md`, including the Ukrainian locale defaults and the files that carry locale-bearing values.

- Add `telegram-bot/`, a zero-dependency Telegram bot that administers GAD-7 and PHQ-9, keeps every result in memory with an atomic JSON snapshot, and sends a weekly Wednesday reminder. Score both instruments by their published bands, ask the PHQ-9 impairment item without adding it to the total, and open a support block whenever PHQ-9 item 9 is above zero.
- Route updates through a synchronous handler that returns Bot API calls instead of performing input or output, so every conversational branch is covered by tests without a network or a live bot.
- Resolve the weekly slot from fixed UTC offsets with per-user time and time zone, mark the slot rather than the send time so a restart cannot double-send, skip a slot older than the grace window instead of firing it late, and disable reminders for a chat that answers `403`.
- Keep the bot token out of logs and error messages, refuse questionnaires in group chats, store the snapshot with owner-only permissions, and support `/export` and `/delete` for the caller's own data.
- Bound the snapshot with one ceiling in both directions. The writer refused nothing while the reader rejected anything over 32 MB, so a bot with a few thousand users wrote a snapshot it could no longer load on restart. `flush` now checks the same limit before the rename, leaves the previous snapshot and no temporary file behind when it refuses, warns once when the file grows past the point where serialization blocks the event loop, and writes compact rather than indented JSON for slightly under half the bytes and time.

### Gate authoring

- Add `scripts/gate-lint.mjs`, a non-executing advisory audit of ledger quality. Warn on whole fixed-output commands, weak success vocabulary, shared-parser path ambiguity, activity titles, unmeasured manual numbers, and mostly manual ledgers without pretending to shell-parse chains or argv. Default warnings retain a `LINT OK` marker and exit `0`; `--strict` makes them fail. Reject unknown short and long options, bound ledger reads, refuse linked or special-file inputs, escape terminal, line-separator, and bidirectional controls, and cap fields plus reported finding count so escaping cannot amplify output without bound.
- Let lint reports drain pipe-backed stdout before the final exit so large JSON remains complete on every supported Node version.

### Correctness and fail-closed behavior

- Replace positional-argument index arithmetic with a validating CLI parser. An explicitly named ledger is the only ledger targeted, regardless of option order.
- Use one strict ledger parser for the checker and Stop hook. Reject zero-gate ledgers, duplicate ids, partial runnable gates, invalid regular expressions, blank abandonment reasons, unknown abandonment ids, and unindented attributes. Validate CLI options and scope ids separately, and reject invalid `OWNS:` paths when claiming a lease.
- Ignore fenced examples, preserve CRLF or LF during updates, and insert a missing evidence line into an otherwise valid gate.
- Match CommonMark fence length, marker, indentation, and closing-line rules so nested shorter fences cannot expose example gates.
- Add `--reverify` so parent verification executes already checked runnable gates and removes completion when the oracle no longer passes.
- Require both process exit `0` and `EXPECT:` match. Include resolved shell, resolved working directory, exit status, match state, and a SHA-256/byte-count output fingerprint in persisted evidence; keep bounded raw diagnostics terminal-only on failure.
- Apply the 1 MiB ceiling to both raw captured output and the canonical decoded stdout/newline/stderr string used by `EXPECT:` and evidence. This prevents separator or invalid-UTF-8 expansion from producing a reported pass whose oversized evidence immediately becomes stale.
- Bind checker-written evidence to the parsed `CHECK:`, `EXPECT:`, and raw `CWD:` with a versioned, environment-independent full SHA-256 definition digest shared by checker, status, and Stop. Treat legacy, handwritten, malformed, future-version, and mismatched runnable evidence as stale-unmet while preserving ordinary manual evidence.
- Keep runtime approval identity separate from evidence currentness. Status now detects definition drift without shell, `PATH`, timeout, approval-store, execution, or write dependencies; failed stale reruns clear the box and old evidence, and concurrent current-definition results remain serialized last-writer-wins.
- Discard an in-flight result when the gate's bound oracle changes before writeback.
- Diagnose an indented `ABANDON:` instead of ignoring it. Attributes must be indented and `ABANDON:` must not be, so the natural formatting mistake previously left a gate unmet and the honest exit unexplained.
- Warn when a slash-wrapped `EXPECT:` containing an unescaped inner slash is read as a regular expression. A literal path silently became a pattern whose dots matched any character, and the wrapping slashes leave no way to express the literal.
- Treat gate abandonment as terminal handoff rather than successful completion. Checker modes now exit `1` with `HANDOFF REQUIRED`, parent `ALL MET` promotion cannot accept an abandoned child, and Stop allows exit with a bounded qualified-id message.
- Include scoped dispatch state in the primary gate reduction, so open, sealed, or abandoned waves can never coexist with `ALL MET`. Reject fabricated terminal histories, non-string handles/reasons, missing lifecycle timestamps, and impossible timestamp order.
- Sanitize repository-controlled dispatch diagnostics before they reach a host hook message, retain qualified abandonment handoffs in mixed block/release outcomes, and discard malformed per-session hook entries instead of failing open.
- Refuse status-log symlinks and swapped/non-regular targets before appending, including automatic dispatch audit events.
- Strip terminal controls and bidirectional overrides from repository-controlled checker diagnostics.
- Separate regular-expression worker startup from the 250ms match budget and cap concurrent match workers at four, so high `--jobs` values remain fail-closed without startup-induced false failures.
- Read discovered and explicit ledgers, dispatch state, hook state, session bindings, and lease records through bounded nonblocking descriptors. Require an unchanged regular single-link file, reject replacements and outside-root discovery, and keep named invalid ledgers visible so the Stop hook cannot mistake them for an empty pipeline.

### Command trust and portability

- Add explicit `--approve` execution consent for ledger commands. Store approvals under `~/.unlazy/approved` by default, require the canonical owner-private store to remain outside the repository, reject linked/replaced/non-private records, and bind each approval to the absolute ledger and gate, command, expectation, resolved working directory and shell, timeout, output and regex limits, regex worker limits, platform, and inherited `PATH`.
- Add `--shell` with `UNLAZY_SHELL` fallback. Keep the platform shell as the final default and make inherited `PATH` behavior visible.
- Replace POSIX-only gate examples with repository-owned Node scripts and document Windows shell and PATH variance.
- On Windows, retain strict `dev` plus `ino` same-file checks by comparing the original descriptor with a second non-creating descriptor opened from the current name. Continue bracketing that identity acquisition with named-entry symlink, type, link-count, and replacement guards instead of ignoring device identity globally.
- On Windows timeouts, terminate an active `cmd.exe` tree with the drive-root `<drive>:\Windows\System32\taskkill.exe` only when `SystemRoot`, `WINDIR`, and `SystemDrive` agree. Bound the helper itself to one second, inspect every result, and fall back to the direct child without PATH lookup. Skip numeric-PID cleanup when Node has already observed leader exit, and independently settle after cleanup even when descendants retain pipes. The Windows CI path launches and reaps a real shell plus nested Node descendant.
- Keep a detached Node supervisor alive until each shell and inherited output stream closes. POSIX cleanup signals the group only while that exact supervisor still owns its PID/PGID, preventing a reused numeric group from being targeted without regressing descendant cleanup.
- Add [SECURITY.md](SECURITY.md) for command, environment, installer, hook, evidence, scope, and lease boundaries.
- Clarify that approval binds declared oracle text/environment, not called scripts or other transitive files, while `--status` and Stop validate only structural definition currentness until explicit `--reverify` checks artifacts.

### Orchestration and concurrency

- Add scoped pipelines under `.unlazy/<scope>/`, qualified gate ids, session binding, append-only status logging, and explicit scope discovery refusal when the target is ambiguous.
- Add repository-relative `OWNS:` declarations with `--claim` and `--release`. Serialize claim discovery and creation under one lock, reject unsafe paths, and use conservative overlap detection.
- Treat a scope/leaf identity as an exclusive lease owner so duplicate workers cannot both claim and later release the same logical lease.
- Canonicalize the named-path identity used by every file lock, so real-root and symlink-root spellings of one physical repository cannot enter the same lease, dispatch, hook-state, or ledger critical section concurrently.
- Describe scopes and leases as coordination rather than filesystem or process isolation.
- Add opt-in `--jobs <N>` rolling check concurrency while retaining sequential default behavior and deterministic ledger-order reporting.
- Add declared readiness states, real `node-*` branch paths, explicit dependencies, and rolling leaf dispatch to the plan and orchestration guide.
- Add atomic native dispatch waves that require every independent leaf to receive a distinct host start handle before the first return is accepted.
- Add auditable dispatch abandonment for irrecoverable partial launches. Preserve the reason and timestamps in state, make status non-successful, and keep abandoned waves visible without permanently blocking Stop.
- Make scoped `gate-check` the aggregate completion oracle for both ledgers and dispatch waves; per-wave status and the optional Stop hook are no longer required to prevent a false completion certificate.
- Add Codex and Claude Code launch adapters, incomplete-wave Stop-hook enforcement, and a measured worker-overlap regression without adding a model subprocess runner.
- Key Stop-hook progress state to the session and scope, serialize state changes, and retain unlazy's own six-block no-progress release.
- Compare resolved gate state between stops rather than raw ledger bytes. A comment, a reflowed line, or a rewritten evidence line no longer counts as progress, so the six-block release can fire for an agent that is editing without advancing.
- Compare canonical dispatch state and counts in the same guard, so timestamps and metadata do not impersonate launch progress.
- Distinguish an absent pinned scope from an existing unsafe scope entry: stale absent hook configuration may allow Stop, while a linked, special, unreadable, or outside-root named scope blocks without reading through it.
- Make the atomic `dispatch.json` transition authoritative when a later status-log append is refused. Return the committed transition with a bounded warning so a caller cannot blindly retry a state change that already happened.
- State the leaf-versus-branch gate placement rule in `references/gates.md`, so whole-project checks (interface, end-to-end, regression) live in the branch ledger and run once instead of re-running the tree on every per-leaf `--reverify`. Make one PLAN leaf dispatch table authoritative for Needs, Tier, Planned wave, and State; retain Owns as a derived planning mirror, keep the tree topology-only, and keep actual launches in dispatch state and logs. Require normalized set equality with the ledger's command-time `OWNS:` authority before READY and claim, map Tier only through host-specific controls that exist, keep driver and branch duties outside leaf tiers, and distinguish exact-leaf release after parent verification from whole-scope release after all leaves settle and final verification runs.

### Installer, package, and documentation

- Identify installed hooks by an exact stable marker and constrained legacy script path so moved installations are repaired without claiming unrelated marker substrings. Verify an existing settings file through a no-follow descriptor before reading or backing it up.
- Validate settings container shapes, preserve unrelated entries, write atomically, and create `<settings-file>.unlazy.bak` before replacing an existing settings file.
- Repair matching hook commands whose managed type or timeout fields drifted, and return the documented infrastructure exit code when approval storage fails.
- Warn that local settings and `.unlazy/` should remain untracked and that `--shared` embeds a machine-specific absolute path.
- Keep Node 16 compatibility and zero runtime dependencies. Add a package test command and cross-platform CI, plus a dedicated Windows Node 22.14.0/libuv 1.49.2 lane for the affected stat implementation.
- Add valid `agents/openai.yaml` metadata and keep `SKILL.md` focused through linked references.
- Add a revisioned PLAN contract inventory that maps every independently omittable required outcome and acceptance-changing constraint to an owner and observation, plus request rereads before fan-out and root completion.
- Correct research titles, dates, ordering, and metric interpretation. Add a reproducibility protocol and label the historical six-run comparison's missing raw artifacts.
- Sharpen `SKILL.md` prose without touching the format: define `<skill-dir>` and `<scope>` once near the first command, qualify the solo starting ledger and name the orchestrated starting set, name the four verification layers with a pointer, make the trigger description host-neutral, clarify leaf and scope lease release timing, make Tier routing conditional on real host controls, and trim the Stop-hook mechanics to a pointer. Add a structural self-check that validates the shipped PLAN table, topology, dependencies, waves, and negative controls; harden checker and hook input handling without changing valid-ledger behavior.

### Community work integrated

- [#2](https://github.com/Leonxlnx/unlazy/pull/2): re-verification, parser diagnostics, CRLF preservation, evidence insertion, fenced-example handling, and validation ideas
- [#3](https://github.com/Leonxlnx/unlazy/pull/3): the explicit-file positional fix
- [#5](https://github.com/Leonxlnx/unlazy/pull/5): rolling dispatch and bounded `--jobs`
- [#8](https://github.com/Leonxlnx/unlazy/pull/8): stable hook identification and moved-install repair
- [#9](https://github.com/Leonxlnx/unlazy/pull/9): explicit approval for executable checks
- [#10](https://github.com/Leonxlnx/unlazy/pull/10): scoped pipelines, shared parsing, ownership leases, session routing, and the first regression suite
- [#14](https://github.com/Leonxlnx/unlazy/pull/14): the COLM 2026 test-time-scaling source
- [#15](https://github.com/Leonxlnx/unlazy/pull/15): negative controls, supplied-number measurement, and manual-gate review guidance; the single-run risk observation is intentionally not generalized
- [#17](https://github.com/Leonxlnx/unlazy/pull/17): the read-only gate-quality linter, JSON output, strict mode, documentation, and regression harness by Daz Alderson
- [#18](https://github.com/Leonxlnx/unlazy/pull/18): atomic native dispatch waves, launch adapters, durable state, Stop integration, documentation, and tests by hangloose50
- [#20](https://github.com/Leonxlnx/unlazy/pull/20): the Windows process-tree timeout diagnosis and `taskkill /t` direction by Praveen Bishnoi
- [#24](https://github.com/Leonxlnx/unlazy/pull/24): fail-closed diagnosis of an indented `ABANDON:` by Daz Alderson
- [#25](https://github.com/Leonxlnx/unlazy/pull/25): semantic Stop-hook progress hashing by Daz Alderson
- [#26](https://github.com/Leonxlnx/unlazy/pull/26): shared-parser warning for ambiguous path-shaped EXPECT regexes by Daz Alderson
- [#29](https://github.com/Leonxlnx/unlazy/pull/29): leaf-versus-branch gate placement, visible PLAN dispatch metadata, and host-neutral skill wording by mafiaboyhacker
- [#21](https://github.com/Leonxlnx/unlazy/issues/21) and [#23](https://github.com/Leonxlnx/unlazy/issues/23): abandonment-promotion and contract-omission reports and reproducers by theislampill
- [#30](https://github.com/Leonxlnx/unlazy/issues/30): affected-Windows descriptor/path `st_dev` mismatch report and reproduction
- [#31](https://github.com/Leonxlnx/unlazy/issues/31): automatic-evidence definition drift report and false-green reproduction

## 2.0.0 source milestone, 2026-08-10

Moved completion enforcement from prose into gate files, runnable checks, evidence, and an optional Claude Code Stop hook.

- Reframed the Depth Tree as decomposition and integration rather than an arithmetic effort multiplier.
- Added rule zero: write acceptance gates before real work.
- Added the original zero-dependency checker, Stop hook, and installer.
- Added solo and orchestrated workflows, per-leaf and per-branch ledgers, parent verification guidance, and final report remeasurement.
- Split detailed method, gate, orchestration, and token guidance into references for progressive disclosure.

The exploratory six-run comparison that informed this milestone is not reproducible from the repository because its raw artifacts were not retained. See [research/validation-protocol.md](research/validation-protocol.md).

## 1.0.0 source milestone, 2026-08-10

- Added the original instruction-only Depth Tree method.
- Added behavioral rules against premature completion, silent scope reduction, and unmeasured final claims.
- Added installation and related-research documentation.
