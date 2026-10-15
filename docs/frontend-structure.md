# Frontend structure

`src/frontend/src/app` is split by feature, so a change has one obvious place:

| Folder | Holds | Tested by |
| --- | --- | --- |
| `results/` | Everything about the data: `DataService` (the socket, the message queue, the processed distances), wire and view types (`data.models.ts`), and the pure functions for times, heats, standings, race codes, lap colours, the live heat and reconnect backoff. The functions have no Angular. | unit specs next to them |
| `dashboard/` | The dashboard page, with its timed heat card, mass start row and group strip card in subfolders; following the live heat (`auto-follow.ts`, `scroll.util.ts`); the styles they share (`_shared.scss`, `_tokens.scss`) | unit specs for the logic, `src/frontend/e2e/*.e2e.ts` for the screen |
| `settings/` | `SettingsService`: the viewer's persisted settings | unit specs next to it |
| `i18n/` | One file per language, and the `TranslateService`; `languages.spec.ts` checks they all carry the same keys | |

Next to these, in `app/`: `wake-lock.ts` (keeps the screen on) and `color-scheme.ts` (follows the system's light or dark setting).

- A new viewer setting is one `Setting` in `settings.service.ts` plus its control in the dashboard template.
- A new race code goes in `results/race-codes.ts`, with the rule that uses it next to it.
- A new language is one file in `i18n/`, registered in `languages.ts` (the keys are typed by `translations.ts`).
- Colours that differ between the light and the dark theme are custom properties (`--lr-*`) in `src/styles.scss`; components use those, never a literal colour that would be wrong in the other theme.
- Behaviour that is data (what is computed) is specified in `src/frontend/SPECS.md` under *Data* and covered by unit specs; behaviour that is on screen is under *UI* and covered by Playwright specs.
