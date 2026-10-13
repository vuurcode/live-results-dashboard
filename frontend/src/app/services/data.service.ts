import { Injectable, NgZone, inject } from '@angular/core';
import { TranslateService } from './translate.service';
import { randomJitter, reconnectDelay } from '../logic/backoff';
import { HIDDEN_PAUSE_MS, needsReconnect } from '../logic/hidden';
import { SettingsService } from './settings.service';
import { webSocket, WebSocketSubject } from 'rxjs/webSocket';
import { BehaviorSubject, Subject, Subscription, merge } from 'rxjs';
import { skip } from 'rxjs/operators';
import {
  BackendMessage,
  BackendWindow,
  DistanceMeta,
  CompetitorUpdate,
  ProcessedDistance,
  StandingsGroup,
} from '../models/data.models';
import { recomputePositions, recomputeGroups, resolveRaces } from '../logic/standings.util';
import { FeedStatus, TodayCompetition } from '../models/data.models';
import { competitionIdFromSearch, withCompetitionId, withResume } from '../logic/competition.util';

export interface BackendStatus {
  status: 'Disconnected' | 'Connecting...' | 'Connected' | 'Error' | 'No competition';
  url: string;
  interval: number | null;
  errorMessage?: string | null;
}

/** How long a lost connection stays unreported, so a quick reconnect shows no error. */
const LOST_ERROR_GRACE_MS = 3000;
/** Close code the backend uses to refuse a connection that names no valid competition. */
const CLOSE_NO_COMPETITION = 1008;
const RENDER_INTERVAL_MS = 250;

@Injectable({ providedIn: 'root' })
export class DataService {
  private socket$: WebSocketSubject<BackendMessage> | null = null;
  /** Competition to follow, from the page URL (`?competitionId=...`); without one nothing is followed. */
  public readonly competitionId = competitionIdFromSearch(window.location.search);
  private readonly BACKEND_URL = withCompetitionId((() => {
    const raw = (window as BackendWindow).BACKEND_URL;
    // Ignore unsubstituted template placeholder (env-inject.js not processed by envsubst)
    const base = raw && !raw.startsWith('${') ? raw : null;
    if (base) {
      const wsUrl = base.replace(/^http/, 'ws') + '/ws';
      // Mixed content: page is HTTPS but WS target is ws:// — use nginx proxy on current host
      if (window.location.protocol === 'https:' && wsUrl.startsWith('ws://')) {
        return `wss://${window.location.host}/ws`;
      }
      return wsUrl;
    }
    // Fall back to /ws on the current host — works with nginx proxy (prod) and ng proxy (dev)
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${window.location.host}/ws`;
  })(), this.competitionId);
  private readonly BACKEND_HTTP_URL: string = (() => {
    const raw = (window as BackendWindow).BACKEND_URL;
    return raw && !raw.startsWith('${') ? raw : `${window.location.protocol}//${window.location.host}`;
  })();

  /** Competitions happening today, from the backend; an empty list when it cannot be loaded. */
  async todayCompetitions(): Promise<TodayCompetition[]> {
    try {
      const res = await fetch(`${this.BACKEND_HTTP_URL}/api/competitions/today`);
      if (!res.ok) return [];
      const list: unknown = await res.json();
      return Array.isArray(list) ? (list as TodayCompetition[]) : [];
    } catch {
      return [];
    }
  }

  private _status = new BehaviorSubject<BackendStatus>({ status: 'Disconnected', url: '', interval: null });
  public status$ = this._status.asObservable();
  private _reset = new Subject<void>();
  public reset$ = this._reset.asObservable();
  /** The page came back from suspension and the connection was renewed. */
  private resumed = new Subject<void>();
  public resumed$ = this.resumed.asObservable();
  private _processedData = new BehaviorSubject<ProcessedDistance[]>([]);
  public processedData$ = this._processedData.asObservable();
  private _eventName = new BehaviorSubject<string>('');
  public eventName$ = this._eventName.asObservable();
  private _feed = new BehaviorSubject<FeedStatus | null>(null);
  /** The data source's state as reported by the backend; null until it has answered. */
  public feed$ = this._feed.asObservable();

  private _errors = new BehaviorSubject<string[]>([]);
  public errors$ = this._errors.asObservable();
  private _displayedGroups = new BehaviorSubject<Map<string, StandingsGroup[]>>(new Map());
  public displayedGroups$ = this._displayedGroups.asObservable();
  private _groupDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private distanceMap = new Map<string, ProcessedDistance>();
  private competitorMap = new Map<string, Map<string, CompetitorUpdate>>();
  private queue: BackendMessage[] = [];
  private renderLoopRunning = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Reconnect attempts since the last working connection; the wait between them grows with it. */
  private reconnectAttempts = 0;
  private socketSub: Subscription | null = null;
  private hiddenSince = 0;
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  private lostErrorTimer: ReturnType<typeof setTimeout> | null = null;

  /** Where this page stands in the room's stream (the status message's epoch, the last seq received), to resume from after a reconnect. */
  private resumePoint: { epoch: string; seq: number } | null = null;

  private noCompetition = false;
  private ngZone = inject(NgZone);
  private ts = inject(TranslateService);
  private settings = inject(SettingsService);

  constructor() {
    // A page restored from the back/forward cache comes back with a dead socket and stale results; load it afresh.
    window.addEventListener('pageshow', (e) => { if (e.persisted) window.location.reload(); });
    document.addEventListener('visibilitychange', () => this._onVisibilityChange());
    window.addEventListener('online', () => this.resume());
    // changing how mass starts group shows at once
    merge(this.settings.groupThreshold.changes$.pipe(skip(1)), this.settings.maxGroups.changes$.pipe(skip(1)))
      .subscribe(() => this._regroup());
    this.connect();
  }

  private _regroup() {
    for (const dist of this.distanceMap.values()) {
      if (dist.isMassStart) this._recomputeGroups(dist);
    }
    for (const timer of this._groupDebounceTimers.values()) clearTimeout(timer);
    this._groupDebounceTimers.clear();
    this._flushDisplayedGroups();
    this.ngZone.run(() => this._publishState());
  }

  connect() {
    if (this.socket$ && !this.socket$.closed) return;
    if (!this.competitionId) {
      this._status.next({ status: 'No competition', url: '', interval: null });
      return;
    }
    this._errors.next([]);
    this._feed.next(null);
    this._status.next({ status: 'Connecting...', url: '', interval: null });
    this.noCompetition = false;
    this.socket$ = webSocket<BackendMessage>({
      url: withResume(this.BACKEND_URL, this.resumePoint),
      closeObserver: { next: (e: CloseEvent) => { this.noCompetition = e.code === CLOSE_NO_COMPETITION; } },
    });
    this.socketSub = this.socket$.subscribe({
      next: (msg) => this._enqueue(msg),
      error: (err: unknown) => this._handleError(err),
      complete: () => this._handleDisconnect(),
    });
  }

  /**
   * A hidden page stops listening after a while (the backend's bandwidth is limited) and comes back with a fresh replay;
   * a brief switch to another tab changes nothing, unless the connection broke meanwhile.
   */
  private _onVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      this.hiddenSince = Date.now();
      if (!this.pauseTimer) this.pauseTimer = setTimeout(() => this._pause(), HIDDEN_PAUSE_MS);
      return;
    }
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
    if (!this.socket$ || needsReconnect(Date.now() - this.hiddenSince)) this.resume();
  }

  /** Closes the connection without the reconnect and banner that a lost connection brings. */
  private _pause() {
    this.pauseTimer = null;
    this._cancelReconnect();
    this._cancelLostError();
    this.socketSub?.unsubscribe(); // the last subscriber leaving closes the socket
    this.socketSub = null;
    this.socket$ = null;
  }

  /** A suspended phone leaves a socket that looks open but is dead; drop it and fetch the current results. */
  resume() {
    if (!this.competitionId || this.noCompetition) return;
    this._cancelReconnect();
    this.reconnectAttempts = 0;
    this.socket$?.complete();
    this.socket$ = null;
    this.connect();
    this.resumed.next();
  }

  disconnect() {
    this._cancelReconnect();
    this._cancelLostError();
    this.socket$?.complete();
    this.socket$ = null;
    this._status.next({ status: 'Disconnected', url: '', interval: null });
  }

  resetDashboard() {
    localStorage.clear();
    window.location.reload();
  }

  private _enqueue(msg: BackendMessage) {
    this._cancelLostError();
    this._track(msg);
    this.queue.push(msg);
    if (!this.renderLoopRunning) {
      this.renderLoopRunning = true;
      this.ngZone.runOutsideAngular(() => this._scheduleNextCycle());
    }
  }

  private _track(msg: BackendMessage) {
    if (msg.type === 'status') {
      const { epoch, seq } = msg.data;
      this.resumePoint = epoch !== undefined && seq !== undefined ? { epoch, seq } : null;
    } else if (this.resumePoint && msg.seq !== undefined && msg.seq > this.resumePoint.seq) {
      this.resumePoint.seq = msg.seq;
    }
  }

  private _scheduleNextCycle() {
    setTimeout(() => this._runCycle(), 0);
  }

  private _runCycle() {
    if (this.queue.length === 0) { this.renderLoopRunning = false; return; }
    const deadline = Date.now() + RENDER_INTERVAL_MS;
    let changed = false;
    while (this.queue.length > 0 && Date.now() < deadline) {
      const msg = this.queue.shift();
      if (msg) changed = this._applyMessage(msg) || changed;
    }
    if (changed) {
      // Flush groups immediately so the strip renders on initial load
      // (debounce will still update it again after the threshold delay)
      this._flushDisplayedGroups();
      this.ngZone.run(() => this._publishState());
    }
    if (this.queue.length > 0) this._scheduleNextCycle();
    else this.renderLoopRunning = false;
  }

  private _applyMessage(msg: BackendMessage): boolean {
    switch (msg.type) {
      case 'status':
        this._cancelReconnect();
        this.reconnectAttempts = 0;
        this.clearErrors();
        this.ngZone.run(() => this._status.next({
          status: 'Connected',
          url: msg.data.data_source_url,
          interval: msg.data.data_source_interval,
          errorMessage: null,
        }));
        return false;
      case 'feed_status':
        this.ngZone.run(() => this._feed.next(msg.data));
        return false;
      case 'event_name':
        this.ngZone.run(() => this._eventName.next(msg.data.name));
        return false;
      case 'error':
        this.ngZone.run(() => this._status.next({
          ...this._status.value,
          status: 'Error',
          errorMessage: msg.data,
        }));
        return false;
      case 'reset':
        this._applyReset();
        return false;
      case 'distance_meta':
        return this._applyDistanceMeta(msg.data);
      case 'competitor_update':
        return this._applyCompetitorUpdate(msg.data);
      default:
        return false;
    }
  }

  private _applyReset(): void {
    this.distanceMap.clear();
    this.competitorMap.clear();
    for (const timer of this._groupDebounceTimers.values()) clearTimeout(timer);
    this._groupDebounceTimers.clear();
    this.ngZone.run(() => {
      this._eventName.next('');
      this._processedData.next([]);
      this._displayedGroups.next(new Map());
      this._reset.next();
    });
  }

  private _applyDistanceMeta(meta: DistanceMeta): boolean {
    let dist = this.distanceMap.get(meta.id);
    if (!dist) {
      dist = {
        id: meta.id, name: meta.name, eventNumber: meta.event_number,
        isLive: meta.is_live, isMassStart: meta.is_mass_start,
        distanceMeters: meta.distance_meters, totalLaps: meta.total_laps,
        anyFinished: meta.any_finished, finishingLineAfter: null,
        processedRaces: [], standingsGroups: [], heatGroups: [],
      };
      this.distanceMap.set(meta.id, dist);
    } else {
      dist.name = meta.name; dist.eventNumber = meta.event_number;
      dist.isLive = meta.is_live; dist.isMassStart = meta.is_mass_start;
      dist.distanceMeters = meta.distance_meters; dist.totalLaps = meta.total_laps;
      dist.anyFinished = meta.any_finished;
      // finishingLineAfter is intentionally NOT updated from the backend here;
      // it is computed instantly by _recomputeFinishingLine on every competitor update.
    }
    dist.heatGroups = meta.heat_groups.map(hg => ({
      heat: hg.heat,
      raceIds: hg.race_ids,
      races: this._resolveRaces(meta.id, hg.race_ids, !meta.is_mass_start),
    }));
    return true;
  }

  private _applyCompetitorUpdate(comp: CompetitorUpdate): boolean {
    comp.lastUpdated = Date.now();
    let distComps = this.competitorMap.get(comp.distance_id);
    if (!distComps) { distComps = new Map(); this.competitorMap.set(comp.distance_id, distComps); }

    const dist = this.distanceMap.get(comp.distance_id);
    if (dist) {
      const existing = distComps.get(comp.id);
      const lapsChanged = existing != null && existing.lap_times.join() !== comp.lap_times.join();
      comp.lapsUpdatedAt = lapsChanged ? comp.lastUpdated : existing?.lapsUpdatedAt;

      // Ensure frontend-only fields are preserved / initialised
      comp.position = existing?.position ?? 0;
      comp.position_change = null;
      comp.is_final_lap = false;
      comp.group_number = existing?.group_number ?? null;
      comp.gap_to_above = existing?.gap_to_above ?? null;
      // Replace the competitor with a new object (never mutate it): OnPush row components only
      // re-render when their input reference changes. Rows are tracked by id, so the DOM item
      // is kept and the flash animation still plays at the competitor's CURRENT row position.
      if (existing) {
        distComps.set(comp.id, { ...existing, ...comp });
      } else {
        distComps.set(comp.id, comp);
        dist.processedRaces = [...dist.processedRaces, comp];
      }

      // Derive is_final_lap in the frontend
      const target = distComps.get(comp.id)!;
      target.is_final_lap = target.laps_remaining === 1;

      // Recompute positions and resort immediately — before highlight and finishing line
      recomputePositions(Array.from(distComps.values()));
      dist.processedRaces = Array.from(distComps.values()).sort((a, b) => a.position - b.position);

      // Set finishing line to this competitor; persists until the next update moves it
      dist.finishingLineAfter = comp.id;

      if (dist.isMassStart) {
        this._recomputeGroups(dist);
        this._scheduleGroupDebounce(comp.distance_id);
      } else {
        dist.heatGroups.forEach(hg => {
          hg.races = this._resolveRaces(comp.distance_id, hg.raceIds, true);
        });
      }
    } else {
      comp.position = 0;
      comp.position_change = null;
      comp.is_final_lap = false;
      distComps.set(comp.id, comp);
    }

    return true;
  }

  private _recomputeGroups(dist: ProcessedDistance) {
    dist.standingsGroups = recomputeGroups(
      dist.processedRaces,
      this.settings.groupThreshold.value,
      this.settings.maxGroups.value,
      (n) => this.ts.t(n === 1 ? 'lapUnit' : 'lapsUnit'),
    ) as StandingsGroup[];
  }

  private _scheduleGroupDebounce(distId: string) {
    const existing = this._groupDebounceTimers.get(distId);
    if (existing) clearTimeout(existing);
    const thresholdMs = this.settings.groupThreshold.value * 1000;
    const timer = setTimeout(() => {
      this._groupDebounceTimers.delete(distId);
      this._flushDisplayedGroups();
    }, thresholdMs);
    this._groupDebounceTimers.set(distId, timer);
  }

  private _flushDisplayedGroups() {
    const map = new Map<string, StandingsGroup[]>();
    for (const [id, dist] of this.distanceMap) {
      if (dist.isMassStart) map.set(id, dist.standingsGroups);
    }
    this.ngZone.run(() => this._displayedGroups.next(map));
  }

  private _resolveRaces(distId: string, ids: string[], pinnedByLane = false): (CompetitorUpdate | null)[] {
    return resolveRaces(ids, this.competitorMap.get(distId), pinnedByLane);
  }

  private _publishState() {
    const distances = Array.from(this.distanceMap.values())
      .sort((a, b) => b.eventNumber - a.eventNumber);
    this._processedData.next(distances);
  }


  addError(msg: string) {
    this._errors.next([...this._errors.value, msg]);
  }

  dismissError(index: number) {
    const current = [...this._errors.value];
    current.splice(index, 1);
    this._errors.next(current);
  }

  clearErrors() {
    this._errors.next([]);
  }

  private _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // a hidden page does not keep trying; it reconnects as soon as it is visible again
      if (document.visibilityState === 'hidden') return;
      this.connect();
    }, reconnectDelay(this.reconnectAttempts++, randomJitter()));
  }

  /** A dropped connection is usually back within moments, so the banner only appears if it stays down. */
  private _scheduleLostError() {
    if (this.lostErrorTimer) return;
    this.lostErrorTimer = setTimeout(() => {
      this.lostErrorTimer = null;
      this.addError('Connection to backend lost. Reconnecting…');
    }, LOST_ERROR_GRACE_MS);
  }

  private _cancelLostError() {
    if (this.lostErrorTimer) {
      clearTimeout(this.lostErrorTimer);
      this.lostErrorTimer = null;
    }
  }

  private _cancelReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** Reconnecting cannot help when no competition was chosen; the viewer has to pick a competition. */
  private _stopForNoCompetition(): boolean {
    if (!this.noCompetition) return false;
    this.socket$ = null;
    this._status.next({ status: 'No competition', url: '', interval: null });
    return true;
  }

  private _handleError(err: unknown) {
    if (this._stopForNoCompetition()) return;
    console.error('WebSocket error:', err);
    this._scheduleLostError();
    this.socket$ = null;
    this._status.next({ status: 'Error', url: '', interval: null });
    this._scheduleReconnect();
  }

  private _handleDisconnect() {
    if (this._stopForNoCompetition()) return;
    if (
      this._status.value.status === 'Connected' ||
      this._status.value.status === 'Connecting...'
    ) {
      this._scheduleLostError();
    }
    this.socket$ = null;
    this._status.next({ status: 'Disconnected', url: '', interval: null });
    this._scheduleReconnect();
  }
}
