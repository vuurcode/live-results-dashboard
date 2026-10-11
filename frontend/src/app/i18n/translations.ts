
export interface Translations {
  // Page
  pageTitle: string;
  // Topbar buttons
  displaySettings: string;
  massStartSettings: string;
  // Follow setting
  todayMatchesLabel: string;
  thousandthsLabel: string;
  hundredthsLabel: string;
  thousandthsPopoverTitle: string;
  thousandthsPopoverBody: string;
  compactColorsLabel: string;
  compactColorsPopoverTitle: string;
  compactColorsPopoverBody: string;
  feedNotLiveTitle: string;
  feedNotLiveBody: string;
  feedSourceMessage: string;
  disclaimer: string;
  disclaimerLabel: string;
  disclaimerOwnership: string;
  feedUnavailableTitle: string;
  feedUnavailableBody: string;
  feedEmptyTitle: string;
  feedEmptyBody: string;
  feedDisconnectedTitle: string;
  feedDisconnectedBody: string;
  feedSlowTitle: string;
  feedSlowBody: string;
  tooltipDistance: string;
  tooltipLapTime: string;
  tooltipTotalTime: string;
  followLabel: string;
  followPopoverTitle: string;
  followPopoverBody: string;
  // Max gap setting
  maxGapLabel: string;
  maxGapPopoverTitle: string;
  maxGapPopoverBody: string;
  // Max groups setting
  maxGroupsLabel: string;
  maxGroupsPopoverTitle: string;
  maxGroupsPopoverBody: string;
  // Lap variance setting
  lapDeltaLabel: string;
  lapVariancePopoverTitle: string;
  lapVariancePopoverBody: string;
  lapVariancePopoverExample: string;
  // Lap times setting
  lapTimesLabel: string;
  showLapTimesPopoverTitle: string;
  showLapTimesPopoverBody: string;
  // Badges
  badgeLive: string;
  badgeDone: string;
  badgeLeader: string;
  badgeFinalLap: string;
  // Distance header
  lapUnit: string;
  lapsUnit: string;
  // Groups / heats
  headOfRace: string;
  tailOfRace: string;
  groupLabel: string;  // contains {n}
  heatLabel: string;   // contains {n}
  heatMergedLabel: string; // contains {a} and {b}
  // Race events
  lapCompleted: string;
  finished: string;
  finishLabel: string;
  // Timed personal best label and remarks
  pbCurrentLabel: string;
  pbPreviousLabel: string;
  remarkNewPb: string;
  remarkShortPb: string;
  pbImprovedTitle: string;
  remarkFall: string;
  remarkDisqualified: string;
  remarkDidNotStart: string;
  remarkDidNotFinish: string;
  remarkWithdrawn: string;
  remarkNewTrackRecord: string;
  remarkTrackRecordCourse: string;
  // Mass start lap counter (HTML, contains underline span)
  moreLapAfterRound: string;   // singular
  moreLapsAfterRound: string;  // plural
}

export const en: Translations = {
  pageTitle: 'Live Results Dashboard',
  displaySettings: 'Display/visualization settings',
  massStartSettings: 'Mass Start',
  todayMatchesLabel: 'Matches today',
  thousandthsLabel: 'Thousandths precision',
  hundredthsLabel: 'Hundredths precision',
  thousandthsPopoverTitle: 'Hundreds or thousandths precision',
  thousandthsPopoverBody: 'Long track: show times in hundredths, as is usual in skating. Thousandths appear automatically when they are needed to settle a personal best, i.e. when the new time and the previous best have the same hundredths. Switch on to always show thousandths.',
  compactColorsLabel: 'Lap time diff colours',
  compactColorsPopoverTitle: 'Lap time diff colours',
  compactColorsPopoverBody: 'Colour the compact lap badges by how each lap compares to the previous one, like mass start, using the <i>Lap time diff threshold</i>. <br><br><span class="popover-badge popover-badge-green">green</span> \u2192 Within threshold <br><span class="popover-badge popover-badge-orange">orange</span> \u2192 Slower <br><span class="popover-badge popover-badge-purple">purple</span> \u2192 Faster',
  feedNotLiveTitle: 'This match is not live yet',
  feedNotLiveBody: 'Results show up here as soon as the timing starts. This page updates by itself.',
  feedSourceMessage: 'Message from the results source:',
  disclaimerLabel: 'Notice',
  disclaimer: 'Unofficial results: these times are not final and may change or be corrected.',
  disclaimerOwnership: 'All data shown belongs to the respective ice rink or competition organiser, which owns the timing data measured.',
  feedUnavailableTitle: 'The results source cannot be reached',
  feedUnavailableBody: 'We keep trying. This page updates by itself when it is back.',
  feedEmptyTitle: 'No results yet',
  feedEmptyBody: 'The match is live, but no results have been published yet.',
  feedDisconnectedTitle: 'Connection lost',
  feedDisconnectedBody: 'Reconnecting to the server. This page updates by itself.',
  feedSlowTitle: 'Still waiting for data\u2026',
  feedSlowBody: 'This takes longer than usual. This page updates by itself when data arrives.',
  tooltipDistance: 'Distance',
  tooltipLapTime: 'Lap time',
  tooltipTotalTime: 'Total time',
  followLabel: 'Auto-follow on updates',
  followPopoverTitle: 'Auto-follow on updates',
  followPopoverBody: 'Automatically scroll to keep the live distance in view as results come in.',
  maxGapLabel: 'Max seconds gap between groups',
  maxGapPopoverTitle: 'Max seconds gap between groups',
  maxGapPopoverBody:
    'Minimum time difference (in seconds) between two competitors <strong>on the same lap</strong> for them to be placed in <strong>separate</strong> standings groups. <br><br>Lower values create more groups; 0 puts every competitor in their own group.<br><br>For comparison: Marathon races maintain a <strong>two second gap</strong> to indicate when a group is formed and which competitors are part of it.',
  maxGroupsLabel: 'Max groups',
  maxGroupsPopoverTitle: 'Max groups',
  maxGroupsPopoverBody:
    'Maximum number of standings groups to display in the group strip. Groups are based on the <i>Max seconds gap between groups</i> set to the left. <br><br>Competitors beyond the last group are collected into a \u201cTail of the race\u201d group. <br><br>Set to 0 to disable grouping entirely.',
  lapDeltaLabel: 'Lap time diff threshold',
  lapVariancePopoverTitle: 'Lap variance threshold',
  lapVariancePopoverBody:
    'Percentage difference between <strong>consecutive lap times</strong> used to colour lap badges. <br><br><span class="popover-badge popover-badge-green">Within threshold</span> <span class="popover-badge popover-badge-orange">Slower than threshold</span> <span class="popover-badge popover-badge-purple">Faster than threshold</span>',
  lapVariancePopoverExample:
    'E.g. at <span class="popover-badge popover-badge-grey">{pct}%</span>, after a lap of <span class="popover-badge popover-badge-green">40.0\u202fs</span>: slower than <span class="popover-badge popover-badge-orange">{slow}\u202fs</span> turns orange, faster than <span class="popover-badge popover-badge-purple">{fast}\u202fs</span> turns purple.',
  lapTimesLabel: 'Lap times',
  showLapTimesPopoverTitle: 'Show lap times',
  showLapTimesPopoverBody:
    'Show or hide the lap time badge strip on each mass-start competitor row. Hiding lap times gives a cleaner view during busy races.',
  badgeLive: 'Live',
  badgeDone: 'Done',
  badgeLeader: 'Leader',
  badgeFinalLap: 'Final lap',
  lapUnit: 'lap',
  lapsUnit: 'laps',
  headOfRace: 'Head of the race',
  tailOfRace: 'Tail of the race',
  groupLabel: 'Group {n}',
  heatLabel: 'Heat {n}',
  heatMergedLabel: 'Heat {a} & {b}',
  lapCompleted: 'Lap completed',
  finished: 'Finished',
  finishLabel: 'Finish',
  pbCurrentLabel: 'Current PB',
  pbPreviousLabel: 'Previous PB',
  remarkNewPb: 'New personal best',
  remarkShortPb: 'PB',
  pbImprovedTitle: 'Previous personal best, improved',
  remarkFall: 'Fall',
  remarkDisqualified: 'Disqualified',
  remarkDidNotStart: 'Did not start',
  remarkDidNotFinish: 'Did not finish',
  remarkWithdrawn: 'Withdrawn',
  remarkNewTrackRecord: 'Track Record',
  remarkTrackRecordCourse: 'Track Record Course',
  moreLapAfterRound: '{n} more lap <span style="text-decoration:underline">after</span> this round',
  moreLapsAfterRound: '{n} more laps <span style="text-decoration:underline">after</span> this round',
};

export const nl: Translations = {
  pageTitle: 'Live Resultaten Dashboard',
  displaySettings: 'Weergave-/visualisatie-instellingen',
  massStartSettings: 'Massastart',
  todayMatchesLabel: 'Wedstrijden vandaag',
  thousandthsLabel: 'Precisie duizendsten',
  hundredthsLabel: 'Precisie honderdsten',
  thousandthsPopoverTitle: 'Precisie honderdsten of duizendsten',
  thousandthsPopoverBody: 'Langebaan: toon tijden in honderdsten, zoals gebruikelijk bij schaatsen. Duizendsten verschijnen vanzelf als ze nodig zijn om een persoonlijk record te beslissen, dus als de nieuwe tijd en het vorige record dezelfde honderdsten hebben. Zet aan om altijd duizendsten te tonen.',
  compactColorsLabel: 'Kleur rondetijdverschil',
  compactColorsPopoverTitle: 'Kleur rondetijdverschil',
  compactColorsPopoverBody: 'Kleur de compacte rondebadges naar het verschil met de vorige ronde, zoals bij massastart, met de drempel <i>rondetijdverschil</i>. <br><br><span class="popover-badge popover-badge-green">groen</span> \u2192 Binnen drempel <br><span class="popover-badge popover-badge-orange">oranje</span> \u2192 Langzamer <br><span class="popover-badge popover-badge-purple">paars</span> \u2192 Sneller',
  feedNotLiveTitle: 'Deze wedstrijd is nog niet live',
  feedNotLiveBody: 'Resultaten verschijnen hier zodra de tijdwaarneming start. Deze pagina ververst vanzelf.',
  feedSourceMessage: 'Bericht van de resultatenbron:',
  disclaimerLabel: 'Mededeling',
  disclaimer: 'Onofficiële uitslagen: deze tijden zijn niet definitief en kunnen nog wijzigen of gecorrigeerd worden.',
  disclaimerOwnership: 'Alle getoonde gegevens zijn eigendom van de betreffende ijsbaan of wedstrijdorganisator, die eigenaar is van de gemeten tijdsdata.',
  feedUnavailableTitle: 'De resultatenbron is niet bereikbaar',
  feedUnavailableBody: 'We blijven het proberen. Deze pagina ververst vanzelf zodra de bron terug is.',
  feedEmptyTitle: 'Nog geen resultaten',
  feedEmptyBody: 'De wedstrijd is live, maar er zijn nog geen resultaten gepubliceerd.',
  feedDisconnectedTitle: 'Verbinding verbroken',
  feedDisconnectedBody: 'Opnieuw verbinden met de server. Deze pagina ververst vanzelf.',
  feedSlowTitle: 'Nog even wachten op gegevens\u2026',
  feedSlowBody: 'Dit duurt langer dan normaal. Deze pagina ververst vanzelf zodra er gegevens zijn.',
  tooltipDistance: 'Afstand',
  tooltipLapTime: 'Rondetijd',
  tooltipTotalTime: 'Totaaltijd',
  followLabel: 'Volg automatisch bij updates',
  followPopoverTitle: 'Volg automatisch bij updates',
  followPopoverBody: 'Scroll automatisch mee om de live afstand in beeld te houden terwijl resultaten binnenkomen.',
  maxGapLabel: 'Max. seconden verschil tussen groepen',
  maxGapPopoverTitle: 'Max. seconden verschil tussen groepen',
  maxGapPopoverBody:
    'Minimaal tijdsverschil (in seconden) tussen twee deelnemers <strong>op dezelfde ronde</strong> om ze in <strong>aparte</strong> groepen te plaatsen. <br><br>Lagere waarden geven meer groepen; 0 plaatst elke deelnemer in een eigen groep.<br><br>Ter vergelijking: bij marathons hanteert men een <strong>twee seconden verschil</strong> om aan te geven wanneer een groep wordt gevormd.',
  maxGroupsLabel: 'Max. groepen',
  maxGroupsPopoverTitle: 'Max. groepen',
  maxGroupsPopoverBody:
    'Maximaal aantal rangschikkingsgroepen in de groepsstrip. Groepen zijn gebaseerd op het <i>Max. seconden verschil tussen groepen</i>. <br><br>Deelnemers buiten de laatste groep worden samengebracht in een \u201cStaart van de race\u201d-groep. <br><br>Stel in op 0 om groepering volledig uit te schakelen.',
  lapDeltaLabel: 'Drempel rondetijdverschil',
  lapVariancePopoverTitle: 'Rondetijd variatie drempel',
  lapVariancePopoverBody:
    'Procentueel verschil tussen <strong>opeenvolgende rondetijden</strong> voor de kleur van rondetijd-badges. <br><br><span class="popover-badge popover-badge-green">Binnen drempel</span> <span class="popover-badge popover-badge-orange">Trager dan drempel</span> <span class="popover-badge popover-badge-purple">Sneller dan drempel</span>',
  lapVariancePopoverExample:
    'Bijv. bij <span class="popover-badge popover-badge-grey">{pct}%</span>, na een ronde van <span class="popover-badge popover-badge-green">40,0\u202fs</span>: trager dan <span class="popover-badge popover-badge-orange">{slow}\u202fs</span> wordt oranje, sneller dan <span class="popover-badge popover-badge-purple">{fast}\u202fs</span> wordt paars.',
  lapTimesLabel: 'Rondetijden',
  showLapTimesPopoverTitle: 'Rondetijden tonen',
  showLapTimesPopoverBody:
    'Toon of verberg de rondetijd-badge-strip op elke massastart-deelnemer. Verbergen geeft een overzichtelijker beeld tijdens drukke wedstrijden.',
  badgeLive: 'Live',
  badgeDone: 'Klaar',
  badgeLeader: 'Leider',
  badgeFinalLap: 'Laatste ronde',
  lapUnit: 'ronde',
  lapsUnit: 'ronden',
  headOfRace: 'Kop van de race',
  tailOfRace: 'Staart van de race',
  groupLabel: 'Groep {n}',
  heatLabel: 'Serie {n}',
  heatMergedLabel: 'Serie {a} & {b}',
  lapCompleted: 'Ronde voltooid',
  finished: 'Gefinisht',
  finishLabel: 'Finish',
  pbCurrentLabel: 'Huidig PR',
  pbPreviousLabel: 'Vorig PR',
  remarkNewPb: 'Nieuw persoonlijk record',
  remarkShortPb: 'PR',
  pbImprovedTitle: 'Vorig persoonlijk record, verbeterd',
  remarkFall: 'Val',
  remarkDisqualified: 'Gediskwalificeerd',
  remarkDidNotStart: 'Niet gestart',
  remarkDidNotFinish: 'Niet gefinisht',
  remarkWithdrawn: 'Teruggetrokken',
  remarkNewTrackRecord: 'Baanrecord',
  remarkTrackRecordCourse: 'Baanrecord parcours',
  moreLapAfterRound: 'nog {n} ronde <span style="text-decoration:underline">na</span> deze ronde',
  moreLapsAfterRound: 'nog {n} ronden <span style="text-decoration:underline">na</span> deze ronde',
};
