import { trigger, transition, style, animate, query, stagger } from '@angular/animations';

// raceListAnimation: tracks list identity changes so Angular re-applies
// per-row CSS classes (pos-up / pos-down) on reorder.
export const raceListAnimation = trigger('raceList', [
  transition('* => *', [
    query(':enter', [
      style({ opacity: 0 }),
      stagger(0, [animate('150ms ease-out', style({ opacity: 1 }))]),
    ], { optional: true }),
  ]),
]);

/** Stable animation state key — changes whenever the sort order of the list changes. */
export function raceListKey(races: { id: string }[]): string {
  return races.map(r => r.id).join(',');
}
