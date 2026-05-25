"use strict";

// M1 stubs. Every gate returns allowed:true so legal transitions all succeed.
// Real gate logic lands in M2 (e.g., COMPOSE→PREVIEW requires a storyboard
// artifact, RENDER→PACKAGE requires a finished render, etc.).
function allow() {
  return { allowed: true, blockers: [] };
}

const GATES = Object.freeze({
  "INGEST->INTENT":      allow,
  "INTENT->BRIEF":       allow,
  "BRIEF->STORYBOARD":   allow,
  "BRIEF->INTENT":       allow,
  "STORYBOARD->COMPOSE": allow,
  "STORYBOARD->BRIEF":   allow,
  "COMPOSE->PREVIEW":    allow,
  "COMPOSE->STORYBOARD": allow,
  "PREVIEW->RENDER":     allow,
  "PREVIEW->COMPOSE":    allow,
  "PREVIEW->STORYBOARD": allow,
  "RENDER->PACKAGE":     allow,
  "PACKAGE->ITERATE":    allow,
  "ITERATE->COMPOSE":    allow,
  "ITERATE->STORYBOARD": allow,
});

function getGate(from, to) {
  return GATES[`${from}->${to}`] || null;
}

module.exports = { GATES, getGate };
