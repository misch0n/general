'use strict';
// App init — runs last, after every feature module has defined its globals.
  loadSettings();   // restore censor + owner name/toggle before the first muster
  paintCamo($('setup'));
  addSetupPlayer(false); addSetupPlayer(false);
  // a scanned invite (?join=CODE) jumps straight into the join flow; else offer a recent net rejoin / local resume
  if (!maybeJoinFromURL() && !maybeOfferNetRejoin()) maybeOfferResume();
  syncWebrtcUI();       // hide the WebRTC entry unless the experimental toggle is on
  syncStartRuleSel(); syncStartWhereSel();   // start-screen ruleset + local/network selectors
