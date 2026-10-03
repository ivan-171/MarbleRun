export const GAME_VERSION = '0.1.2';
export const STORAGE_KEY = 'marbleforge-save-v1';

export const FORMATS = {
  classic: { id: 'classic', name: 'Classic', modules: 12, danger: 1.0, points: [25,20,16,13,11,10,9,8,7,6,5,4,3,2,1,0] },
  sprint: { id: 'sprint', name: 'Sprint', modules: 8, danger: 0.8, points: [18,15,12,10,8,7,6,5,4,3,2,1,0,0,0,0] },
  chaos: { id: 'chaos', name: 'Chaos', modules: 13, danger: 1.65, points: [25,20,16,13,11,10,9,8,7,6,5,4,3,2,1,0] },
  endurance: { id: 'endurance', name: 'Endurance', modules: 18, danger: 1.15, points: [30,24,20,17,15,13,11,9,8,7,6,5,4,3,2,1] },
  elimination: { id: 'elimination', name: 'Elimination', modules: 10, danger: 1.25, points: [30,24,20,17,15,13,11,9,8,7,6,5,4,3,2,1] },
};

export const MODULE_TYPES = [
  'straight','slalom','pinball','spinner','split','squeeze','wave','gates','bumpers','stairs',
  'zigzag','double-spinner','gauntlet','tunnel','crossfire','switchback','spiral','clover','punchers','dropzone','finale'
];

const DEFAULT_COLORS = [
  '#ff4d6d','#3a86ff','#ffbe0b','#8338ec','#06d6a0','#fb5607','#00b4d8','#ef476f',
  '#8ac926','#ff70a6','#577590','#f72585','#4cc9f0','#f9844a','#90be6d','#b5179e'
];

export function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = h << 13 | h >>> 19;
  }
  return function() {
    h = Math.imul(h ^ h >>> 16, 2246822507);
    h = Math.imul(h ^ h >>> 13, 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

export function mulberry32(a) {
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function rngFromSeed(seed) {
  const seedFn = xmur3(String(seed));
  return mulberry32(seedFn());
}

export function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

export function shuffle(rng, input) {
  const arr = [...input];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function createDefaultMarbles(count = 16) {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i + 1}`,
    name: `Marble ${i + 1}`,
    color: DEFAULT_COLORS[i % DEFAULT_COLORS.length],
    logo: '',
    number: i + 1,
    stats: {
      races: 0, wins: 0, podiums: 0, points: 0, bestFinish: null, dnf: 0,
      streakTop5: 0, bestStreakTop5: 0, biggestGain: 0, recent: [],
    },
    career: { races: 0, wins: 0, podiums: 0, bestFinish: null, dnf: 0, biggestGain: 0 }
  }));
}

export function createSchedule(seed, rounds = 16) {
  const rng = rngFromSeed(`schedule:${seed}`);
  const base = ['classic','sprint','classic','chaos','classic','endurance','sprint','elimination'];
  const schedule = [];
  for (let i = 0; i < rounds; i++) {
    let format = base[i % base.length];
    if (i > 5 && rng() < 0.26) format = pick(rng, ['chaos','sprint','endurance']);
    schedule.push({
      round: i + 1,
      format,
      seed: `${seed}-${i + 1}-${Math.floor(rng() * 1e9)}`,
      completed: false,
      results: null,
      title: null,
    });
  }
  return schedule;
}

export function createNewSave(seed = `MF-${Date.now()}`) {
  const marbles = createDefaultMarbles();
  return {
    version: GAME_VERSION,
    createdAt: Date.now(),
    season: 1,
    seasonSeed: seed,
    currentRound: 0,
    marbles,
    schedule: createSchedule(seed),
    history: [],
    settings: {
      camera: 'auto',
      speed: 1,
      quality: 'auto',
    }
  };
}

function weightedModulePool(formatId) {
  const safe = ['straight','slalom','split','squeeze','wave','tunnel','switchback'];
  const medium = ['pinball','spinner','gates','bumpers','zigzag','clover','stairs','tunnel'];
  const wild = ['double-spinner','gauntlet','crossfire','punchers','dropzone','switchback','spiral'];
  if (formatId === 'sprint') return [...safe, ...safe, ...medium];
  if (formatId === 'chaos') return [...medium, ...medium, ...wild, ...wild, ...safe];
  if (formatId === 'endurance') return [...safe, ...medium, ...medium, ...wild];
  if (formatId === 'elimination') return [...medium, ...medium, ...wild, ...safe];
  return [...safe, ...safe, ...medium, ...medium, ...wild];
}

export function generateTrackPlan(seed, formatId = 'classic') {
  const format = FORMATS[formatId] ?? FORMATS.classic;
  const rng = rngFromSeed(`track:${seed}:${formatId}`);
  const pool = weightedModulePool(formatId);
  const modules = [];
  for (let i = 0; i < format.modules; i++) {
    let type;
    if (i === 0) type = 'straight';
    else if (i === format.modules - 1) type = 'finale';
    else {
      type = pick(rng, pool);
      if (modules.at(-1)?.type === type) type = pick(rng, pool.filter(x => x !== type));
    }
    const length = type === 'stairs' || type === 'dropzone' ? 12 : 13 + Math.floor(rng() * 5);
    modules.push({
      index: i,
      type,
      length,
      variant: Math.floor(rng() * 9999),
      intensity: +(0.7 + rng() * 0.7 * format.danger).toFixed(2),
      spin: rng() < 0.5 ? -1 : 1,
      offset: +(rng() * 2 - 1).toFixed(3),
      curve: +(rng() * 2 - 1).toFixed(3),
    });
  }
  const namesA = ['Neon','Crystal','Turbo','Velvet','Midnight','Solar','Lucky','Electric','Royal','Plastic','Meteor','Candy'];
  const namesB = ['Run','Spiral','Drop','Circuit','Gauntlet','Rush','Chute','Mile','Maze','Dash','Cascade','Rally'];
  return {
    seed: String(seed),
    format: formatId,
    name: `${pick(rng, namesA)} ${pick(rng, namesB)}`,
    modules,
    totalLength: modules.reduce((n, m) => n + m.length, 0),
    danger: Math.min(5, Math.max(1, Math.round(1.5 + format.danger * 1.7 + rng() * 1.3))),
  };
}



/**
 * Build a deterministic, always-descending 3D centreline for a track plan.
 * Z is deliberately monotonic so race progress and rescues remain robust,
 * while X bends from module to module and Y only ever moves downhill.
 */
export function generateTrackPath(plan, options = {}) {
  const startY = Number.isFinite(options.startY) ? options.startY : 4.1;
  const slope = Number.isFinite(options.slope) ? options.slope : 0.135;
  const maxX = Number.isFinite(options.maxX) ? options.maxX : 13.5;
  const samples = [
    { x: 0, y: startY + slope * 5, z: 5, moduleIndex: -1 },
    { x: 0, y: startY, z: 0, moduleIndex: -1 },
  ];
  let cursor = 0;
  let currentX = 0;
  let currentY = startY;

  const smooth = t => t * t * (3 - 2 * t);
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  for (const module of plan.modules) {
    const len = module.length;
    const startZ = -cursor;
    const startX = currentX;
    const startModuleY = currentY;
    const rawCurve = Number.isFinite(module.curve) ? module.curve : (module.offset ?? 0);
    let strength = 3.1;
    if (module.type === 'straight' || module.type === 'finale') strength = 0.85;
    if (module.type === 'tunnel') strength = 2.4;
    if (module.type === 'switchback') strength = 5.4;
    if (module.type === 'spiral') strength = 1.8;

    let delta = rawCurve * strength;
    // Tracks should roam, not keep walking off in the same direction forever.
    if (Math.abs(startX) > maxX * 0.72 && Math.sign(delta) === Math.sign(startX)) {
      delta *= -1;
    }
    let targetX = clamp(startX + delta, -maxX, maxX);
    const baseDrop = slope * len;
    const extraDrop = module.type === 'dropzone' ? 1.7 : module.type === 'spiral' ? 0.55 : 0;
    const stepSize = module.type === 'spiral' ? 1.55 : module.type === 'switchback' ? 1.8 : 2.75;
    const steps = Math.max(5, Math.ceil(len / stepSize));

    for (let j = 1; j <= steps; j++) {
      const t = j / steps;
      const e = smooth(t);
      let x = startX + (targetX - startX) * e;

      // Broad S bends make switchbacks visible without ever reversing Z.
      if (module.type === 'switchback') {
        x += module.spin * 3.4 * Math.sin(Math.PI * t);
      }
      // A descending corkscrew/chute: two lateral sweeps while continuing downhill.
      if (module.type === 'spiral') {
        x += module.spin * 3.6 * Math.sin(Math.PI * 2 * t) * Math.sin(Math.PI * t);
      }

      x = clamp(x, -maxX - 1.5, maxX + 1.5);
      const z = startZ - len * t;
      const y = startModuleY - baseDrop * t - extraDrop * e;
      samples.push({ x, y, z, moduleIndex: module.index });
    }

    currentX = targetX;
    currentY = startModuleY - baseDrop - extraDrop;
    cursor += len;
  }

  return samples;
}

export function getStandings(save) {
  return [...save.marbles].sort((a, b) => {
    if (b.stats.points !== a.stats.points) return b.stats.points - a.stats.points;
    if (b.stats.wins !== a.stats.wins) return b.stats.wins - a.stats.wins;
    if (b.stats.podiums !== a.stats.podiums) return b.stats.podiums - a.stats.podiums;
    return (a.stats.bestFinish ?? 999) - (b.stats.bestFinish ?? 999);
  });
}

export function applyRaceResults(save, event, orderedResults) {
  const format = FORMATS[event.format] ?? FORMATS.classic;
  const byId = new Map(save.marbles.map(m => [m.id, m]));
  orderedResults.forEach((r, idx) => {
    const m = byId.get(r.id);
    if (!m) return;
    const finish = idx + 1;
    const pts = format.points[idx] ?? 0;
    m.stats.races += 1;
    m.stats.points += pts;
    if (finish === 1) m.stats.wins += 1;
    if (finish <= 3) m.stats.podiums += 1;
    if (!m.stats.bestFinish || finish < m.stats.bestFinish) m.stats.bestFinish = finish;
    if (r.dnf) m.stats.dnf += 1;
    if (finish <= 5) {
      m.stats.streakTop5 += 1;
      m.stats.bestStreakTop5 = Math.max(m.stats.bestStreakTop5, m.stats.streakTop5);
    } else {
      m.stats.streakTop5 = 0;
    }
    if (Number.isFinite(r.gain)) m.stats.biggestGain = Math.max(m.stats.biggestGain, r.gain);
    m.stats.recent = [finish, ...m.stats.recent].slice(0, 5);
    m.career ??= { races: 0, wins: 0, podiums: 0, bestFinish: null, dnf: 0, biggestGain: 0 };
    m.career.races += 1;
    if (finish === 1) m.career.wins += 1;
    if (finish <= 3) m.career.podiums += 1;
    if (!m.career.bestFinish || finish < m.career.bestFinish) m.career.bestFinish = finish;
    if (r.dnf) m.career.dnf += 1;
    if (Number.isFinite(r.gain)) m.career.biggestGain = Math.max(m.career.biggestGain, r.gain);
  });

  event.completed = true;
  event.results = orderedResults.map((r, idx) => ({ ...r, position: idx + 1 }));
  event.title = buildHeadline(save, event, orderedResults);
  const standingsSnapshot = getStandings(save).map((m, idx) => ({
    id: m.id,
    position: idx + 1,
    points: m.stats.points,
    wins: m.stats.wins,
    podiums: m.stats.podiums,
    bestFinish: m.stats.bestFinish,
  }));
  save.history.unshift({
    season: save.season,
    round: event.round,
    format: event.format,
    seed: event.seed,
    title: event.title,
    podium: event.results.slice(0, 3),
    results: event.results.map(r => ({ ...r })),
    standings: standingsSnapshot,
    timestamp: Date.now(),
  });
  save.history = save.history.slice(0, 60);
  save.currentRound = Math.min(save.currentRound + 1, save.schedule.length);
  return save;
}

export function buildHeadline(save, event, results) {
  const winner = save.marbles.find(m => m.id === results[0]?.id);
  if (!winner) return 'Race complete';
  if ((winner.career?.wins ?? winner.stats.wins) === 1) return `${winner.name} breaks through`;
  if (results[0]?.gain >= 8) return `${winner.name} storms from the back`;
  if (event.format === 'chaos') return `${winner.name} survives the chaos`;
  if (event.format === 'elimination') return `${winner.name} owns the knockout`; 
  return `${winner.name} takes the win`;
}


export function startNewSeason(save, seed = `MF-S${save.season + 1}-${Date.now()}`) {
  save.season += 1;
  save.seasonSeed = seed;
  save.currentRound = 0;
  save.schedule = createSchedule(seed);
  for (const m of save.marbles) {
    m.stats = {
      races: 0, wins: 0, podiums: 0, points: 0, bestFinish: null, dnf: 0,
      streakTop5: 0, bestStreakTop5: 0, biggestGain: 0, recent: [],
    };
  }
  return save;
}

export function exportSave(save) {
  return JSON.stringify(save, null, 2);
}

export function importSave(json) {
  const parsed = JSON.parse(json);
  if (!parsed || !Array.isArray(parsed.marbles) || !Array.isArray(parsed.schedule)) throw new Error('Invalid MarbleForge save');
  return parsed;
}
