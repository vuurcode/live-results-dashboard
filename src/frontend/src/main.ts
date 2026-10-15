import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { followColorScheme } from './app/color-scheme';
import { colorSchemeSetting } from './app/settings/settings.service';

// before the first render, so a dark system never flashes light
followColorScheme(window, document.documentElement, colorSchemeSetting.changes$);

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
