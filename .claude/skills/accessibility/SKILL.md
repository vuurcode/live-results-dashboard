---
name: accessibility
description: Audit, fix and prevent accessibility problems (WCAG 2.2 AA) in the live results dashboard (Angular + CoreUI). Use this skill whenever the user mentions accessibility, a11y, WCAG, screen readers, keyboard navigation, focus, ARIA, colour contrast, colour-blindness, reduced motion, axe, or asks whether the UI is "usable for everyone" — and also whenever you add or change interactive UI, badges, colours, animations or live-updating content in frontend/, even if they never say "accessibility".
---

# Accessibility for the live results dashboard

The dashboard is a dense, colourful, constantly-updating display. That combination is where
accessibility goes wrong: meaning carried only by colour, tiny text, things that move or
announce themselves every second, and mouse-only interaction. Fixing these is mostly small
template and CSS changes, so prefer fixing at the source over adding workarounds.

## Workflow

1. **Measure first.** Run the scan (below) and `npm run lint`. Work from findings, not guesses —
   axe finds what machines can find (roughly a third of WCAG issues); the manual checks in step 3
   cover the rest.
2. **Fix by root cause.** One shared class or component usually causes many findings
   (e.g. `.bg-success` badges account for most contrast failures). Fix it once.
3. **Check what tools can't see:** keyboard-only pass, zoom to 200%, and the checklist in
   `references/checklist.md` for the items that apply to what you changed.
4. **Lock it in.** Add or extend a Playwright check in `src/frontend/e2e/` for the behaviour you fixed
   (e.g. a row is reachable with Tab and activates with Enter/Space), so it can't silently regress.
5. Re-run the scan, lint, unit and e2e tests before reporting. Say what is still open — don't
   claim "accessible", claim what was checked.

## Running the checks

```bash
cd frontend
npm run lint                      # angular-eslint template accessibility rules
npm run e2e                       # starts the stack on the e2e ports, runs the tests, stops it
node ../.claude/skills/accessibility/scripts/axe-scan.mjs   # axe-core against the fixture competitions
```

`axe-scan.mjs` needs the e2e stack running (mockserver 18080, backend 15000, `ng serve` on
14200 with `--proxy-config e2e/proxy.conf.json`; see `playwright.config.ts`). It lets the replay play,
opens every accordion, then prints violations grouped by rule and exits 1 on serious/critical ones.
Pass other URLs as arguments, `--wait <ms>` to scan later in the replay. Restart a replay with
`POST http://localhost:18080/api/reset?competitionId=<id>`.

## What matters most in this app

**Keyboard and focus.** Anything with a `(click)` must be a real `<button>`/`<a>`, or carry
`role="button"`, `tabindex="0"` and Enter/Space handlers (see `mass-start-race-row` and
`group-strip-card` for the pattern, including `aria-pressed` for the selected state). Keep a
visible `:focus-visible` outline — never `outline: none` without a replacement. The settings
popovers are CSS hover popovers: they must also appear on keyboard focus.

**Colour is never the only signal.** Lane colours (white/red/yellow/blue), lap-time badges
(green/orange/purple = within/slower/faster) and PR/DQ/DNF card borders all need a text or icon
equivalent too — a visible label, or visually-hidden text (`visually-hidden` class from
Bootstrap/CoreUI). Contrast: 4.5:1 for normal text, 3:1 for large text and for UI component
boundaries. Many badges here are ~9pt bold, which counts as normal text.

**Live updates.** Results change every second or so. Do not put `aria-live` on the whole list —
a screen reader would read every lap time. Prefer: a single polite live region that announces
meaningful, throttled events (e.g. "Competitor E finished, 1st"), and leave routine lap-time
updates silent. Connection errors (shown as alerts) are a good candidate for `role="alert"`/`role="status"`;
there is no always-on connection badge.

**Motion.** Flash highlights, row swap animations, the pulsing placeholders and smooth
auto-scroll should respect `@media (prefers-reduced-motion: reduce)` (disable or shorten them).
Nothing may flash more than 3 times per second. Auto-scroll ("Follow") must stay opt-in
and must never fight the user's own scrolling.

**Structure.** One `<h1>` (the event name in the top bar is the natural one), a `main` landmark,
accordion headers that are real buttons with a correct `aria-expanded`, a `lang` attribute that
follows the selected UI language (EN/NL), and `title` updated with the event name (already done).

**Zoom and small screens.** Text must reflow at 200% zoom and 320px width without horizontal
scrolling of the page. Lap-time strips scroll inside their own container — that is fine, but the
container must be keyboard reachable.

## Known baseline

The e2e fixtures and the captured real competitions scan clean (zero axe violations) and `e2e/accessibility.e2e.ts`
keeps it that way. Things that were fixed and are easy to reintroduce:

- Badge colours: success `#177d3c`, danger `#c93434`, muted text `#565e64` (on the dark header `#b4bcc4`),
  small grey text `#454c52`, dark text on orange/yellow badges. Do not stack `opacity` on cards: it lowers contrast.
- CoreUI's accordion item sets an invalid `aria-expanded` on the collapse element; `dashboard.component.ts`
  strips it after each render.
- The event name is the single `<h1>`.

Not covered by axe (still open): reduced-motion handling, a throttled live region for finishes, and the
manual checks in `references/checklist.md`.

## Writing accessible changes — habits that avoid rework

- Reach for native elements and CoreUI components first; add ARIA only to fill a gap, and keep
  `aria-*` values bound to real state (`[attr.aria-pressed]`, `[attr.aria-expanded]`).
- Give icon-only or number-only controls an accessible name (`aria-label`, or visible text).
- Mark decorative elements `aria-hidden="true"` (the lane colour backgrounds already are).
- Translate every new string through the existing `translate` pipe/service (`i18n/translations.ts`,
  EN and NL) — accessible names and announcements are user-visible text too.
- When in doubt about a contrast ratio, compute it; don't eyeball it. axe reports the exact
  foreground, background and ratio.
