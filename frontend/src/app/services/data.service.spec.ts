import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { BackendMessage, CompetitorUpdate, DistanceMeta } from '../models/data.models';
import { DataService } from './data.service';

interface Applier { _applyMessage(msg: BackendMessage): boolean }

const meta = (over: Partial<DistanceMeta> = {}): DistanceMeta => ({
  id: 'd1', name: '500 m', event_number: 1, is_live: true, is_mass_start: false, distance_meters: 500, total_laps: 1,
  any_finished: false, heat_groups: [{ heat: 1, race_ids: ['a', 'b'] }], ...over,
});

const competitor = (id: string, over: Partial<CompetitorUpdate> = {}): CompetitorUpdate => ({
  id, distance_id: 'd1', start_number: id, name: id, heat: 1, lane: id === 'a' ? 'white' : 'red', laps_count: 0, total_time: '',
  formatted_total_time: '', lap_times: [], laps_remaining: 1, finished_rank: null, is_final_lap: false, position: 0,
  position_change: null, personal_record: null, category: null, invalid_reason: null, remark: null, ...over,
}) as CompetitorUpdate;

describe('DataService message handling', () => {
  let service: DataService;
  let apply: (msg: BackendMessage) => boolean;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(DataService);
    apply = (msg) => (service as unknown as Applier)._applyMessage(msg);
  });

  const publish = () => (service as unknown as { _publishState(): void })._publishState();
  const distances = () => firstValueFrom(service.processedData$);

  it('follows nothing without a competition in the URL', async () => {
    expect((await firstValueFrom(service.status$)).status).toBe('No competition');
  });

  it('takes the event name and reports the connection from status messages', async () => {
    expect(apply({ type: 'event_name', data: { name: 'Cup' } })).toBe(false);
    expect(await firstValueFrom(service.eventName$)).toBe('Cup');
    apply({ type: 'status', data: { data_source_url: 'http://x', data_source_interval: 2 } });
    expect(await firstValueFrom(service.status$)).toMatchObject({ status: 'Connected', url: 'http://x', interval: 2 });
  });

  it('remembers how far the stream got, to resume from after a reconnect', () => {
    const track = (msg: BackendMessage) => (service as unknown as { _track(m: BackendMessage): void })._track(msg);
    const point = () => (service as unknown as { resumePoint: unknown }).resumePoint;
    expect(point()).toBeNull();
    track({ type: 'status', data: { data_source_url: 'http://x', data_source_interval: 2, seq: 5, epoch: 'e1' } });
    track({ type: 'event_name', data: { name: 'Cup' } }); // replay messages carry no number
    expect(point()).toEqual({ epoch: 'e1', seq: 5 });
    track({ seq: 6, type: 'event_name', data: { name: 'Cup' } });
    track({ seq: 7, type: 'event_name', data: { name: 'Cup' } });
    expect(point()).toEqual({ epoch: 'e1', seq: 7 });
    track({ type: 'status', data: { data_source_url: 'http://x', data_source_interval: 2, seq: 2, epoch: 'e2' } }); // a room opened anew
    expect(point()).toEqual({ epoch: 'e2', seq: 2 });
  });

  it('shows a backend error in the status', async () => {
    apply({ type: 'error', data: 'boom' });
    expect(await firstValueFrom(service.status$)).toMatchObject({ status: 'Error', errorMessage: 'boom' });
  });

  it('builds a distance with its heats from distance_meta and lists distances by event number, latest first', async () => {
    expect(apply({ type: 'distance_meta', data: meta() })).toBe(true);
    apply({ type: 'distance_meta', data: meta({ id: 'd2', event_number: 2, heat_groups: [] }) });
    publish();
    const list = await distances();
    expect(list.map(d => d.id)).toEqual(['d2', 'd1']);
    expect(list[1].heatGroups[0]).toMatchObject({ heat: 1, raceIds: ['a', 'b'] });
  });

  it('puts competitors in their heat lanes and sorts the distance by laps and time', async () => {
    apply({ type: 'distance_meta', data: meta() });
    apply({ type: 'competitor_update', data: competitor('a', { laps_count: 1, total_time: '00:00:40.0000000', laps_remaining: 0 }) });
    apply({ type: 'competitor_update', data: competitor('b', { laps_count: 1, total_time: '00:00:38.0000000', laps_remaining: 0 }) });
    publish();
    const d = (await distances())[0];
    expect(d.processedRaces.map(r => r.id)).toEqual(['b', 'a']);
    expect(d.processedRaces.map(r => r.position)).toEqual([1, 2]);
    expect(d.heatGroups[0].races.slice(0, 2).map(r => r?.id)).toEqual(['a', 'b']);
    expect(d.finishingLineAfter).toBe('b');
  });

  it('stamps lapsUpdatedAt only when the lap times change, and keeps it across other updates', async () => {
    apply({ type: 'distance_meta', data: meta() });
    apply({ type: 'competitor_update', data: competitor('a') });
    publish();
    expect((await distances())[0].processedRaces[0].lapsUpdatedAt).toBeUndefined();
    apply({ type: 'competitor_update', data: competitor('a', { lap_times: ['00:00:10.0000000'] }) });
    publish();
    const stamped = (await distances())[0].processedRaces[0].lapsUpdatedAt;
    expect(stamped).toBeDefined();
    apply({ type: 'competitor_update', data: competitor('a', { lap_times: ['00:00:10.0000000'], remark: 'PR' }) });
    publish();
    expect((await distances())[0].processedRaces[0].lapsUpdatedAt).toBe(stamped);
  });

  it('keeps competitors that arrive before their distance and shows them once it is known', async () => {
    apply({ type: 'competitor_update', data: competitor('a') });
    publish();
    expect(await distances()).toEqual([]);
    apply({ type: 'distance_meta', data: meta() });
    apply({ type: 'competitor_update', data: competitor('b') });
    publish();
    expect((await distances())[0].heatGroups[0].races.slice(0, 2).map(r => r?.id)).toEqual(['a', 'b']);
  });

  it('marks the final lap from laps_remaining', async () => {
    apply({ type: 'distance_meta', data: meta() });
    apply({ type: 'competitor_update', data: competitor('a', { laps_remaining: 1 }) });
    apply({ type: 'competitor_update', data: competitor('b', { laps_remaining: 2 }) });
    publish();
    expect((await distances())[0].processedRaces.map(r => r.is_final_lap).sort()).toEqual([false, true]);
  });

  it('clears everything on reset', async () => {
    apply({ type: 'event_name', data: { name: 'Cup' } });
    apply({ type: 'distance_meta', data: meta() });
    publish();
    apply({ type: 'reset' });
    expect(await distances()).toEqual([]);
    expect(await firstValueFrom(service.eventName$)).toBe('');
  });

  it('passes the feed status on', async () => {
    apply({ type: 'feed_status', data: { state: 'not_live', message: 'later' } });
    expect(await firstValueFrom(service.feed$)).toEqual({ state: 'not_live', message: 'later' });
  });
});
