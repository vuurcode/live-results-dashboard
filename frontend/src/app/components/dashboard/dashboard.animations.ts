import { trigger, transition, style, animate, query, stagger, state } from '@angular/animations';

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

/**
 * Group card leave animations:
 *  'last'   — the tail group merged into the group ahead: slide right (toward head) + fade
 *  'normal' — a group was disbanded (members finished): fade out in place
 */
export const groupCardAnimation = trigger('groupCard', [
  state('last',   style({ opacity: 1, transform: 'translateX(0)' })),
  state('normal', style({ opacity: 1, transform: 'translateX(0)' })),
  // last group: slide toward head (right in the row-reversed strip) + fade
  transition('last => void', [
    animate('420ms cubic-bezier(0.4, 0, 0.2, 1)',
      style({ opacity: 0, transform: 'translateX(60px)' })),
  ]),
  // disbanded group: fade out in place
  transition('normal => void', [
    animate('350ms ease-in', style({ opacity: 0 })),
  ]),
]);
