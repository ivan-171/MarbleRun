import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rngFromSeed, generateTrackPlan, createNewSave, applyRaceResults, getStandings, MODULE_TYPES
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
