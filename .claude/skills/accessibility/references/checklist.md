# Manual accessibility checklist

axe-core and angular-eslint catch the mechanical issues. Go through the items below that match
what you changed; each takes a minute and finds things the tools cannot.

## Keyboard (no mouse)
- Tab through the whole page: every control is reachable, in a logical order, and the focus
  indicator is always visible (also on the dark top bar and on the dark accordion header).
- Enter/Space activate buttons and rows; Escape closes popovers; nothing traps focus.
- Selecting a competitor row, toggling an accordion, changing the group threshold and the
  Follow/Lap times checkboxes all work from the keyboard alone.
- Settings groups (Display / Mass Start) open and close with the keyboard, and the hover popovers
  with their descriptions also show on focus.

## Screen reader (VoiceOver / NVDA, or inspect the accessibility tree)
- In Playwright: `await expect(page.getByRole('button', { name: 'Competitor F' })).toBeVisible()`
  checks role and name together, and `expect(locator).toMatchAriaSnapshot()` shows what is exposed.
- Each interactive element has a meaningful name and role; state is exposed (expanded, pressed, selected).
- Lap times read sensibly ("1:12.3", not "1 colon 12 dot 3 small text"): decimals rendered in a
  separate smaller element should not break the reading — check the combined text.
- Routine updates are silent; only deliberate announcements use a live region.

## Visual
- Zoom to 200% and 400% (320px wide): no clipped text, no page-level horizontal scroll.
- Windows High Contrast / forced-colors: badges and borders that carry meaning stay visible
  (use borders, not only background colours).
- Simulate colour-blindness (DevTools → Rendering → Emulate vision deficiencies): lane colours,
  green/orange/purple lap badges and PR/DQ/DNF states are still distinguishable from their text.
- Text spacing: line-height 1.5, letter-spacing 0.12em, word-spacing 0.16em causes no overlap.

## Motion and timing
- With `prefers-reduced-motion: reduce` (DevTools → Rendering) flashes, swaps and pulses are off or
  gentle; the page is fully usable without any animation.
- Nothing flashes more than three times in one second.
- Auto-scroll can be turned off and stops when the user scrolls manually.

## Content
- Page `title` and `<html lang>` are correct for the selected language.
- Errors (connection lost) are announced and say what to do ("Reconnecting in 5s…").
- Headings describe the structure: h1 event name, distances as sections.
