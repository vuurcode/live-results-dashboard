# Frontend structure

`src/frontend/src/app` is split by responsibility, so a change has one obvious place:

| Folder | Holds | Tested by |
| --- | --- | --- |
| `logic/` | Pure functions: times, heats, standings, race codes, the live heat, scrolling. No Angular. | unit specs next to them |
| `services/` | `DataService` (the socket, the message queue, the processed distances), `SettingsService` (the viewer's persisted settings), `TranslateService` | unit specs next to them |
| `components/` | Dashboard page, timed heat card, mass start row | `src/frontend/e2e/*.e2e.ts` |
| `models/` | Wire and view types | |
| `i18n/` | One file per language; `languages.spec.ts` checks they all carry the same keys | |

- A new viewer setting is one `Setting` in `settings.service.ts` plus its control in the dashboard template.
- A new race code goes in `logic/race-codes.ts`, with the rule that uses it in `logic/`.
- A new language is one file in `i18n/`, registered in `languages.ts` (the keys are typed by `translations.ts`).
- Behaviour that is data (what is computed) is specified in `src/frontend/SPECS.md` under *Data* and covered by unit specs; behaviour that is on screen is under *UI* and covered by Playwright specs.
