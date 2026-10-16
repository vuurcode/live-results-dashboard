
export interface Translations {
  // Page
  pageTitle: string;
  // Topbar buttons
  displaySettings: string;
  massStartSettings: string;
  generalSettings: string;
  individualRaceSettings: string;
  // Follow setting
  todayCompetitionsLabel: string;
  noCompetitionOption: string;
  selectCompetitionHint: string;
  noLiveCompetitionsHint: string;
  colorSchemeLabel: string;
  colorSchemeAuto: string;
  colorSchemeOn: string;
  colorSchemeOff: string;
  colorSchemePopoverTitle: string;
  colorSchemePopoverBody: string;
  animationsLabel: string;
  animationsPopoverTitle: string;
  animationsPopoverBody: string;
  thousandthsLabel: string;
  hundredthsLabel: string;
  thousandthsPopoverTitle: string;
  thousandthsOnBody: string;
  thousandthsOffBody: string;
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
  feedNoCompetitionTitle: string;
  feedNoCompetitionBody: string;
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
  timelineLabel: string;
  maxGapPopoverBody: string;
  // Max groups setting
  maxGroupsLabel: string;
  maxGroupsPopoverBody: string;
  // Lap variance setting
  lapDeltaLabel: string;
  lapVariancePopoverTitle: string;
  lapVariancePopoverBody: string;
  lapVariancePopoverExample: string;
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
  // Race events
  lapCompleted: string;
  finished: string;
  finishLabel: string;
  // Individual personal best label and remarks
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
  remarkManualTime: string;
  genderWomen: string;
  genderMen: string;
  categoryPupils: string;
  categoryJuniors: string;
  categoryNeoSeniors: string;
  categorySeniors: string;
  categoryMasters: string;
  remarkWorldRecord: string;
  remarkNationalRecord: string;
  remarkNewTrackRecord: string;
  remarkTrackRecordCourse: string;
  // Mass start lap counter (HTML, contains underline span)
  moreLapAfterRound: string;   // singular
  moreLapsAfterRound: string;  // plural
}
