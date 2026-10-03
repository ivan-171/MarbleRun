import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rngFromSeed, generateTrackPlan, generateTrackPath, createNewSave, applyRaceResults, getStandings, MODULE_TYPES
} from '../src/logic.js';

test('seeded RNG is deterministic', () => {
  const a = rngFromSeed('abc');
  const b = rngFromSeed('abc');
  assert.deepEqual([a(),a(),a()], [b(),b(),b()]);
});

test('track generation is deterministic and valid', () => {
  const a = generateTrackPlan('same', 'classic');
  const b = generateTrackPlan('same', 'classic');
  assert.deepEqual(a, b);
  assert.equal(a.modules.length, 12);
  assert.equal(a.modules[0].type, 'straight');
  assert.equal(a.modules.at(-1).type, 'finale');
  assert.ok(a.modules.every(m => MODULE_TYPES.includes(m.type)));
  assert.ok(a.totalLength > 100);
});

test('different seeds make different tracks', () => {
  const a = generateTrackPlan('A', 'chaos');
  const b = generateTrackPlan('B', 'chaos');
  assert.notDeepEqual(a.modules, b.modules);
});

test('race results update standings', () => {
  const save = createNewSave('TEST');
  const event = save.schedule[0];
  const results = save.marbles.map((m, i) => ({ id: m.id, time: 10 + i, gain: 0, dnf: false }));
  applyRaceResults(save, event, results);
  assert.equal(save.currentRound, 1);
  assert.equal(save.marbles[0].stats.wins, 1);
  assert.equal(save.marbles[0].stats.points, 25);
  assert.equal(getStandings(save)[0].id, save.marbles[0].id);
});

import { FORMATS, startNewSeason, importSave } from '../src/logic.js';

test('500 generated tracks per format obey structural invariants', () => {
  for (const formatId of Object.keys(FORMATS)) {
    for (let i = 0; i < 500; i++) {
      const p = generateTrackPlan(`${formatId}-${i}`, formatId);
      assert.equal(p.modules.length, FORMATS[formatId].modules);
      assert.equal(p.modules[0].type, 'straight');
      assert.equal(p.modules.at(-1).type, 'finale');
      assert.ok(p.modules.every(m => m.length >= 12 && m.length <= 17));
      assert.ok(p.modules.every(m => Number.isFinite(m.intensity) && m.intensity > 0));
      for (let j = 2; j < p.modules.length - 1; j++) {
        assert.notEqual(p.modules[j].type, p.modules[j - 1].type);
      }
    }
  }
});

test('new season resets season standings but keeps career', () => {
  const save = createNewSave('SEASON-TEST');
  const event = save.schedule[0];
  const results = save.marbles.map((m, i) => ({ id: m.id, time: 10 + i, gain: 0, dnf: false }));
  applyRaceResults(save, event, results);
  assert.equal(save.marbles[0].career.wins, 1);
  startNewSeason(save, 'NEXT');
  assert.equal(save.season, 2);
  assert.equal(save.currentRound, 0);
  assert.equal(save.marbles[0].stats.points, 0);
  assert.equal(save.marbles[0].career.wins, 1);
});

test('invalid imported save is rejected', () => {
  assert.throws(() => importSave('{"hello":"world"}'));
});

test('history stores complete race classification and season-table snapshot', () => {
  const save = createNewSave('HISTORY-TEST');
  const event = save.schedule[0];
  const results = save.marbles.map((m, i) => ({ id: m.id, time: 10 + i, gain: 0, dnf: false, rescues: 0 }));
  applyRaceResults(save, event, results);
  assert.equal(save.history.length, 1);
  assert.equal(save.history[0].results.length, save.marbles.length);
  assert.equal(save.history[0].standings.length, save.marbles.length);
  assert.equal(save.history[0].standings[0].id, save.marbles[0].id);
  assert.equal(save.history[0].standings[0].points, 25);
});


test('procedural 3D paths always descend while producing real lateral curves', () => {
  let curvedTracks = 0;
  for (let i = 0; i < 300; i++) {
    const plan = generateTrackPlan(`3d-path-${i}`, i % 2 ? 'classic' : 'chaos');
    const path = generateTrackPath(plan);
    assert.ok(path.length > plan.modules.length * 4);
    let lateralTravel = 0;
    for (let j = 1; j < path.length; j++) {
      assert.ok(path[j].z < path[j - 1].z, 'z progress must never reverse');
      assert.ok(path[j].y <= path[j - 1].y + 1e-9, 'track must never climb uphill');
      const dx = Math.abs(path[j].x - path[j - 1].x);
      lateralTravel += dx;
      assert.ok(dx < 3.25, `adjacent track slices must remain smooth: ${dx}`);
    }
    if (lateralTravel > 4) curvedTracks++;
  }
  assert.ok(curvedTracks > 250, 'most generated tracks should visibly curve');
});

test('spiral and switchback modules preserve descending progress', () => {
  const plan = generateTrackPlan('forced-curves', 'classic');
  plan.modules[2] = { ...plan.modules[2], type: 'switchback', spin: 1, curve: 0.7 };
  plan.modules[3] = { ...plan.modules[3], type: 'spiral', spin: -1, curve: -0.4 };
  const path = generateTrackPath(plan);
  for (let i = 1; i < path.length; i++) {
    assert.ok(path[i].z < path[i - 1].z);
    assert.ok(path[i].y <= path[i - 1].y + 1e-9);
  }
  assert.ok(Math.max(...path.map(p => p.x)) - Math.min(...path.map(p => p.x)) > 5);
});
