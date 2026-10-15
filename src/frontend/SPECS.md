# Specifications
Dashboard app with three components: frontend, backend, mockserver.
Mark a new or changed spec `[ ]` (TODO); once it is built and verified, mark it `[x]`.
Each spec is verified by a test: **data** specs by unit tests (`*.spec.ts`, `*_test.go`), **UI** specs by Playwright e2e specs (`src/frontend/e2e`). Specs without a test are checked by hand.

All components:
- [x] Run in a container via `compose.yml` and `Containerfile`; no host package installs; formatting tools; no HTTPS between containers

## Frontend

### Features
- [x] Node 26, Angular, CoreUI; dev server on `4200`, prod server (nginx, inside the combined image of `prod/Containerfile`) on `8080`; the backend URL is a runtime environment variable, never hardcoded
- [x] The competition to follow is read from the page URL (`?competitionId=<id>`, same charset as the backend) and passed on `/ws`; without it nothing is followed and the competition picker is offered
- [x] Competition picker lists today's competitions as `<start> - <end> · <name> (<venue>)`; each is prefixed with a red circle when it is live and a grey one when not; choosing one reloads the page on that competition; the list is asked again every 5 minutes and when the backend hints that it changed; with no competitions the page says so
- [x] Auto-connect on load; reconnect on a lost connection (waiting 1s, doubling to 30s, with jitter; not while the page is hidden) and show it; a refused competition is not retried; a silent connection and a competition that is not live (with the data source's own message) are reported instead of loading forever
- [x] A page hidden for 2 minutes closes its connection and stops asking for the competition list; when it is visible again it reconnects (a switch of under 10 seconds keeps the connection), because the backend's bandwidth is limited
- [x] Settings, persisted in `localStorage` and folded away by default: **Display** (follow the live heat, animations (off shows every change at once), dark mode (browser default, on or off), thousandths (off by default), lap time diff colours with their threshold) and **Mass Start** (group threshold, max groups, lap times; hidden without a mass start); each has a help text below it
- [x] The screen stays on while the page is visible (Screen Wake Lock, asked again when the page comes back; browsers without it, or that refuse it, let the screen sleep). It needs a secure context: https, or localhost
- [x] Follow: the page lands once on the live distance after a load; with follow on it keeps scrolling to the heat marked live, forward only
- [x] Languages: en, nl, de, fr, es, it, nb, sv, chosen by the browser language, with the term for a personal best per language
- [x] Light and dark theme, following the system preference unless the setting says On or Off; no axe violations in either, keyboard selection of mass-start rows, controls of at least 24px

### Data (unit specs: `src/app/results/*.spec.ts`, `src/app/dashboard/auto-follow.spec.ts`)
- [x] `distance_meta` and `competitor_update` messages are applied to local state; `raceIds` per heat group restores the cards on reconnect; the backend replays everything on connect, nothing else is stored apart from the settings
- [x] Updates are queued; a render cycle completes before the next (`RENDER_INTERVAL_MS`, default 250 ms)
- [x] Mass start positions: laps descending, then total time ascending, no time last; `position_change` (`up`, `down`, `null`) comes from the previous position; `is_final_lap` is `laps_remaining === 1`
- [x] Standings groups use the group threshold (default 2.0 s); the first group is "Head of the race" until anyone finishes, then "Group 1"; the rest "Group X", overflow "Tail of the race"; gaps are against the leader (time on the same lap, laps otherwise)
- [x] Individual race heats: consecutive heats merge into one row ("Heat X & Y") when the first uses only white/red and the next only yellow/blue lanes; lanes order white, red, yellow, blue
- [x] Every lap of a running individual race has a ring; a snake draws it once when the lap arrives. When the race is finished the rings fade out, and a card rendered finished or unfolded later (also from a folded distance) never shows a snake
- [x] Race codes: PR, TRC and the other records are purple, DQ red, DNF, FL and unknown orange; names are shown in full; DNS, DQ and WDR hide their placeholders; DNS and WDR are never live
- [x] Times: lap times truncated (not rounded) to 1 decimal, totals to 2 (or 3 with thousandths on); leading zeros stripped; a result within the same hundredths as a personal best is told apart by the thousandths
- [x] The live heat is the one whose lap times changed last (the later heat on a tie); the page follows by the same rule and never moves back to an earlier heat or distance
- [x] The scroll target keeps the followed element a fixed fraction down the viewport, clamped to the page

### UI (e2e specs: `src/frontend/e2e`)
- [x] Page title `<event name> | Live Results Experiment - Proof of Concept`; the event name is the page heading, replaced visually by the competition picker; top bar dark, pinned with the open distance title below it
- [x] Distances in a full-width accordion by `event_number` descending; the live one opens on load; done ones are slightly dimmed; badges before the name: Live (animated), Done, X/Y progress, PR N / TRC N after it
- [x] Mass start: a timeline pinned below the title (the unfinished racers as one-line badges along one axis, going down the rows like stairs and starting at the top again where that fits, an empty row added below the previous badge where they would touch (the rows move with an animation), at the left edge one per row until the start: the leader at the right, the others to the left by their gap, the width fixed at 15 seconds (both ends labelled, with room on both sides), racers further behind the leader than that sitting at the left edge; each badge marked on its right side as its place on the axis, fading in when it appears (the marking fades in over a second, holds two and fades out in the last); a chequered finish line that travels along the axis at the pace of the scale from the moment the leader crosses it, slowing down towards the far side until all times of the lap are in, then sprinting off and fading out, and starting over with the leader's next lap; a racer whose time is not in yet stays at their previous place and fades out when the finish line reaches it, or moves when their time comes in, a subtle grid line every second with a "+x s" scale on top, labelled only as often as the labels fit; lap updates are not highlighted), and competitor cards (the leader and every finisher tinted green, the others slightly off the page background) on top of each other (up to twice a grid card wide) that pulse their border on hover as a hint to select (start number, full name, gap or total time, the latest lap times that fit one row as badges with "lap N" above in the layout of the individual cards, coloured by the lap diff rules, and below them the position badge and the laps still to go) with the group and finishing lines spanning the grid; several cards can be selected at once to follow them
- [x] Individual race distance: one plain row per heat with cards in lane columns: four per row from 1280px, two from 768px, one below; lane sets without a competitor are hidden on narrow screens; the cards of a row, and their titles, are equally tall
- [x] Card title: name with category / club small below it; remark and invalid badges and the personal best on a line below, merged to the right of the name while racing; a card without codes keeps its title height
- [x] Card body: lap badges with their distance above, total time at the right (on its own line when it does not fit), grey placeholders for laps to come (hidden but keeping their room for DNS, DQ, WDR)
- [x] Watermarks, centred in the title: NEW PERSONAL BEST with its difference, `+ diff` in orange when slower than the personal best, the record or code name (not for a manual time, which shows its time and PR status as usual); a card without a time centres it on the whole card at four lanes
- [x] In the live heat every competitor still racing has a thick red border and a Live badge, until the result is in or the card has a border of its own (personal best, record, fall); the page never scrolls sideways; long and unbreakable names stay inside their cards; large screens scale the root font size
- [x] Narrow screens: competition picker and a cogwheel button share one row; wide screens: a wider picker and the label on the settings button
- [x] The settings panel is one column on narrow screens and two on wide ones, cards side by side equally tall, the help text always shown under its setting; while it is open the page below is slightly blurred
