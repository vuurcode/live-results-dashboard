import { describe, expect, it } from 'vitest';
import { CompetitorUpdate, ProcessedDistance } from '../../models/data.models';
import { AutoFollow, HEADER_ANCHOR, HEAT_ANCHOR } from './auto-follow';

interface Heat { label: string; races: (CompetitorUpdate | null)[] }

const race = (lastUpdated: number, extra: Partial<CompetitorUpdate> = {}) => ({ lastUpdated, ...extra }) as CompetitorUpdate;
const distance = (id: string, eventNumber: number, isLive: boolean, isMassStart = false) =>
  ({ id, eventNumber, isLive, isMassStart }) as ProcessedDistance;

function setup(follow = true) {
  const state = { follow, heats: [] as Heat[], scrolls: [] as [string, number][], opened: [] as string[] };
  const autoFollow = new AutoFollow({
    follow: () => state.follow,
    heatGroups: () => state.heats,
    scrollTo: (selector, anchor) => state.scrolls.push([selector, anchor]),
    liveDistanceChanged: (d) => state.opened.push(d.id),
  });
  return { state, autoFollow };
}

describe('AutoFollow', () => {
  it('scrolls to the header of a live distance and opens it', () => {
    const { state, autoFollow } = setup();
    autoFollow.update([distance('d1', 1, true)]);
    expect(state.opened).toEqual(['d1']);
    expect(state.scrolls).toEqual([['[data-distance-header="d1"]', HEADER_ANCHOR]]);
  });

  it('does nothing without a live distance', () => {
    const { state, autoFollow } = setup();
    autoFollow.update([distance('d1', 1, false)]);
    expect(state.scrolls).toEqual([]);
  });

  it('lands on the live distance once when following is off', () => {
    const { state, autoFollow } = setup(false);
    autoFollow.update([distance('d1', 1, true)]);
    autoFollow.update([distance('d1', 1, true)]);
    expect(state.scrolls).toHaveLength(1);
    expect(state.opened).toEqual([]);
  });

  it('follows the heat with a recent update and only moves forward', () => {
    const { state, autoFollow } = setup();
    const live = distance('d1', 1, true);
    autoFollow.update([live]);
    state.scrolls.length = 0;
    const now = Date.now();
    state.heats = [{ label: 'Heat 1', races: [race(now)] }, { label: 'Heat 2', races: [race(0)] }];
    autoFollow.update([live]);
    expect(state.scrolls).toEqual([['[data-distance-id="d1"][data-heat-label="Heat 1"]', HEAT_ANCHOR]]);
    state.heats = [{ label: 'Heat 1', races: [race(now)] }, { label: 'Heat 2', races: [race(now)] }];
    autoFollow.update([live]);
    expect(state.scrolls).toHaveLength(2);
    state.heats = [{ label: 'Heat 1', races: [race(now)] }, { label: 'Heat 2', races: [race(0)] }]; // a correction in an earlier heat
    autoFollow.update([live]);
    expect(state.scrolls).toHaveLength(2);
  });

  it('ignores withdrawn races', () => {
    const { state, autoFollow } = setup();
    const live = distance('d1', 1, true);
    autoFollow.update([live]);
    state.scrolls.length = 0;
    state.heats = [{ label: 'Heat 5', races: [race(Date.now(), { remark: 'WDR' })] }];
    autoFollow.update([live]);
    expect(state.scrolls).toEqual([]);
  });

  it('does not go back to an earlier live distance', () => {
    const { state, autoFollow } = setup();
    autoFollow.update([distance('d2', 2, true)]);
    autoFollow.update([distance('d1', 1, true)]);
    expect(state.opened).toEqual(['d2']);
  });

  it('follows a mass start by its body', () => {
    const { state, autoFollow } = setup();
    const live = distance('m1', 3, true, true);
    autoFollow.update([live]);
    autoFollow.update([live]);
    expect(state.scrolls[1]).toEqual(['[data-distance-body="m1"]', HEADER_ANCHOR]);
  });

  it('starts over after a reset', () => {
    const { state, autoFollow } = setup();
    autoFollow.update([distance('d2', 2, true)]);
    autoFollow.reset();
    autoFollow.update([distance('d1', 1, true)]);
    expect(state.opened).toEqual(['d2', 'd1']);
  });
});
