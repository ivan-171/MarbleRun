import { MarbleEngine } from './engine.js';
import {
  STORAGE_KEY, FORMATS, createNewSave, generateTrackPlan, getStandings,
  applyRaceResults, exportSave, importSave, startNewSeason
} from './logic.js';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const delay = (ms) => new Promise(r => setTimeout(r, ms));

let save = loadGame();
let currentView = 'race';
let previewPlan = null;
let raceSession = null;
let editingId = null;
let raceBusy = false;

const viewport = $('#viewport3d');
const engine = new MarbleEngine(viewport, {
  onUpdate: updateRaceHud,
  onFinish: handleRaceFinish,
});
engine.setSpeed(save.settings?.speed ?? 1);
engine.setCamera(save.settings?.camera ?? 'auto');

function loadGame() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createNewSave();
    const parsed = JSON.parse(raw);
    // Lightweight migration for older v0.1 saves.
    for (const m of parsed.marbles ?? []) {
      m.career ??= {
        races: m.stats?.races ?? 0, wins: m.stats?.wins ?? 0, podiums: m.stats?.podiums ?? 0,
        bestFinish: m.stats?.bestFinish ?? null, dnf: m.stats?.dnf ?? 0, biggestGain: m.stats?.biggestGain ?? 0,
      };
    }
    parsed.settings ??= { camera: 'auto', speed: 1, quality: 'auto' };
    // v0.1.1 stores complete race tables and championship snapshots in
    // history. Recover both for already-completed races in the current season.
    migrateCurrentSeasonHistory(parsed);
    return parsed;
  } catch (err) {
    console.warn('Could not load save; creating a new one.', err);
    return createNewSave();
  }
}


function migrateCurrentSeasonHistory(parsed) {
  const historyByRound = new Map((parsed.history ?? [])
    .filter(h => h.season === parsed.season)
    .map(h => [h.round, h]));
  const acc = new Map((parsed.marbles ?? []).map(m => [m.id, {
    id: m.id, points: 0, wins: 0, podiums: 0, bestFinish: null,
  }]));

  const completed = [...(parsed.schedule ?? [])]
    .filter(e => e.completed && Array.isArray(e.results))
    .sort((a, b) => a.round - b.round);

  for (const event of completed) {
    const h = historyByRound.get(event.round);
    if (h && !h.results) h.results = event.results.map(r => ({ ...r }));
    const format = FORMATS[event.format] ?? FORMATS.classic;
    event.results.forEach((r, idx) => {
      const row = acc.get(r.id);
      if (!row) return;
      const finish = idx + 1;
      row.points += format.points[idx] ?? 0;
      if (finish === 1) row.wins += 1;
      if (finish <= 3) row.podiums += 1;
      if (!row.bestFinish || finish < row.bestFinish) row.bestFinish = finish;
    });
    if (h && !h.standings) {
      const ordered = [...acc.values()].sort((a, b) => {
        if (b.points !== a.points) return b.points - a.points;
        if (b.wins !== a.wins) return b.wins - a.wins;
        if (b.podiums !== a.podiums) return b.podiums - a.podiums;
        return (a.bestFinish ?? 999) - (b.bestFinish ?? 999);
      });
      h.standings = ordered.map((r, idx) => ({ ...r, position: idx + 1 }));
    }
  }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(save));
    $('#saveState').textContent = 'Saved';
  } catch (err) {
    console.error(err);
    toast('Could not save. A logo may be too large.');
  }
}

function currentEvent() {
  return save.schedule[save.currentRound] ?? null;
}

function marbleById(id) {
  return save.marbles.find(m => m.id === id);
}

function ordinal(n) {
  const s = ['th','st','nd','rd'], v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

function formatTime(r, winnerTime = 0) {
  if (r.dnf) return 'DNF';
  if (!winnerTime || r.time === winnerTime) return `${r.time.toFixed(2)}s`;
  return `+${Math.max(0, r.time - winnerTime).toFixed(2)}`;
}

function formatLabel(id) {
  return FORMATS[id]?.name ?? id;
}

function renderChrome() {
  $('#seasonLabel').textContent = `SEASON ${save.season}`;
  $('#roundLabel').textContent = `${Math.min(save.currentRound + 1, save.schedule.length)}/${save.schedule.length}`;
  $$('.nav-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.view === currentView));
  $$('.content-panel').forEach(panel => panel.classList.toggle('active', panel.id === `panel-${currentView}`));
  $('#raceOverlay').classList.toggle('hidden-by-view', currentView !== 'race');
}

async function preparePreview(force = false) {
  const event = currentEvent();
  if (!event || raceBusy) return;
  if (!force && previewPlan?.seed === event.seed && engine.marbles.length) {
    renderRaceHome();
    return;
  }
  previewPlan = generateTrackPlan(event.seed, event.format);
  $('#loadingBadge').classList.add('show');
  engine.buildTrack(previewPlan);
  await engine.setParticipants(save.marbles);
  $('#loadingBadge').classList.remove('show');
  renderRaceHome();
}

function renderRaceHome() {
  const event = currentEvent();
  const home = $('#raceHome');
  $('#raceHud').classList.add('hidden');
  $('#raceControls').classList.add('hidden');
  $('#countdown').classList.remove('show');
  if (!event) {
    const standings = getStandings(save);
    home.innerHTML = `
      <div class="hero-card season-complete">
        <div class="eyebrow">SEASON ${save.season} COMPLETE</div>
        <h1>${esc(standings[0]?.name ?? 'Champion')} is champion</h1>
        <p>${standings[0]?.stats.points ?? 0} pts · ${standings[0]?.stats.wins ?? 0} wins · ${standings[0]?.stats.podiums ?? 0} podiums</p>
        <button class="primary big" id="newSeasonHome">START SEASON ${save.season + 1}</button>
      </div>`;
    home.classList.remove('hidden');
    $('#newSeasonHome')?.addEventListener('click', async () => {
      startNewSeason(save); persist(); renderAll(); await preparePreview(true);
    });
    return;
  }

  const standings = getStandings(save);
  const leader = standings[0];
  const plan = previewPlan ?? generateTrackPlan(event.seed, event.format);
  const moduleChips = plan.modules.slice(0, 8).map(m => `<span>${esc(m.type)}</span>`).join('') + (plan.modules.length > 8 ? `<span>+${plan.modules.length - 8}</span>` : '');
  home.innerHTML = `
    <div class="hero-card">
      <div class="race-kicker"><span>ROUND ${event.round}</span><span class="format-pill">${esc(formatLabel(event.format))}</span></div>
      <h1>${esc(plan.name)}</h1>
      <div class="track-stats">
        <span><b>${plan.modules.length}</b> modules</span>
        <span><b>${plan.totalLength}m</b> run</span>
        <span><b>${'★'.repeat(plan.danger)}${'☆'.repeat(5-plan.danger)}</b> chaos</span>
      </div>
      <div class="module-strip">${moduleChips}</div>
      <button class="primary big" id="startRace">START RACE</button>
      <div class="leader-note"><i style="background:${leader?.color ?? '#fff'}"></i>${leader ? `${esc(leader.name)} leads with ${leader.stats.points} pts` : 'New season'}</div>
    </div>`;
  home.classList.remove('hidden');
  $('#startRace')?.addEventListener('click', beginEvent);
}

async function beginEvent() {
  if (raceBusy) return;
  const event = currentEvent();
  if (!event) return;
  raceBusy = true;
  raceSession = {
    event,
    plan: previewPlan ?? generateTrackPlan(event.seed, event.format),
    activeIds: save.marbles.map(m => m.id),
    eliminatedBatches: [],
    heat: 1,
  };
  await engine.setParticipants(save.marbles);
  await runCountdown();
}

async function runCountdown() {
  $('#raceHome').classList.add('hidden');
  $('#resultsSheet').classList.remove('open');
  $('#raceHud').classList.remove('hidden');
  $('#raceControls').classList.remove('hidden');
  const cd = $('#countdown');
  cd.classList.add('show');
  for (const n of ['3','2','1','GO!']) {
    cd.textContent = n;
    cd.classList.remove('pop');
    void cd.offsetWidth;
    cd.classList.add('pop');
    await delay(n === 'GO!' ? 420 : 620);
  }
  cd.classList.remove('show');
  engine.startRace();
}

function updateRaceHud(data) {
  $('#raceTime').textContent = `${data.time.toFixed(1)}s`;
  $('#progressFill').style.width = `${(data.progress * 100).toFixed(1)}%`;
  const list = data.order.slice(0, 6).map(r => {
    const m = marbleById(r.id);
    return `<button class="live-row" data-follow="${esc(r.id)}"><b>${r.position}</b><i style="background:${m.color}"></i><span>${esc(m.name)}</span>${r.finished ? '<em>✓</em>' : ''}</button>`;
  }).join('');
  $('#liveBoard').innerHTML = list;
  $$('[data-follow]', $('#liveBoard')).forEach(btn => btn.addEventListener('click', () => {
    engine.follow(btn.dataset.follow);
    save.settings.camera = 'follow';
    updateControlState();
  }));
  if (raceSession) {
    const fmt = formatLabel(raceSession.event.format);
    $('#hudRaceTitle').textContent = raceSession.event.format === 'elimination' ? `${fmt} · Heat ${raceSession.heat}` : fmt;
  }
}

async function handleRaceFinish(results) {
  if (!raceSession) return;
  const isElim = raceSession.event.format === 'elimination';
  if (isElim && raceSession.activeIds.length > 4) {
    const nextCount = Math.max(4, raceSession.activeIds.length - 4);
    const eliminated = results.slice(nextCount);
    raceSession.eliminatedBatches.push(eliminated);
    raceSession.activeIds = results.slice(0, nextCount).map(r => r.id);
    showResults(results, { heat: true, advancing: nextCount });
    return;
  }

  let finalResults = results;
  if (isElim) {
    finalResults = [...results, ...[...raceSession.eliminatedBatches].reverse().flat()];
  }
  applyRaceResults(save, raceSession.event, finalResults);
  persist();
  showResults(finalResults, { heat: false, advancing: 0 });
  raceBusy = false;
}

function showResults(results, opts) {
  const sheet = $('#resultsSheet');
  const winner = marbleById(results[0]?.id);
  const winnerTime = results[0]?.time ?? 0;
  const rows = results.map((r, i) => {
    const m = marbleById(r.id);
    const survives = opts.heat && i < opts.advancing;
    return `<div class="result-row ${opts.heat && !survives ? 'cut' : ''}">
      <b>${i + 1}</b><i style="background:${m.color}"></i><span>${esc(m.name)}</span>
      ${opts.heat ? `<em>${survives ? 'ADVANCES' : 'OUT'}</em>` : `<em>${formatTime(r, winnerTime)}</em>`}
    </div>`;
  }).join('');

  const title = opts.heat
    ? `Heat ${raceSession.heat} complete`
    : (raceSession.event.title ?? `${winner?.name ?? 'Winner'} wins`);
  const subtitle = opts.heat
    ? `${opts.advancing} marbles move on to the next heat.`
    : `${winner?.name ?? ''} wins Round ${raceSession.event.round} · ${formatLabel(raceSession.event.format)}`;

  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <div class="sheet-head"><div><div class="eyebrow">${opts.heat ? 'KNOCKOUT' : 'RESULTS'}</div><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div></div>
    <div class="result-list">${rows}</div>
    <button class="primary big" id="resultsAction">${opts.heat ? 'NEXT HEAT' : (currentEvent() ? 'CONTINUE' : 'VIEW CHAMPION')}</button>`;
  sheet.classList.add('open');
  $('#resultsAction').addEventListener('click', async () => {
    sheet.classList.remove('open');
    if (opts.heat) {
      raceSession.heat += 1;
      const active = raceSession.activeIds.map(marbleById);
      engine.buildTrack(raceSession.plan);
      await engine.setParticipants(active);
      await runCountdown();
    } else {
      raceSession = null;
      renderAll();
      await preparePreview(true);
    }
  });
}

function renderStandings() {
  const standings = getStandings(save);
  const maxPts = Math.max(1, standings[0]?.stats.points ?? 1);
  $('#standingsList').innerHTML = standings.map((m, i) => `
    <div class="standing-row">
      <div class="rank ${i < 3 ? 'podium' : ''}">${i + 1}</div>
      <div class="marble-avatar" style="--c:${m.color}">${m.logo ? `<img src="${m.logo}" alt="">` : `<span>${m.number}</span>`}</div>
      <div class="standing-main"><b>${esc(m.name)}</b><small>${m.stats.wins} W · ${m.stats.podiums} podiums · ${m.stats.recent.length ? m.stats.recent.map(ordinal).join(' / ') : 'no form yet'}</small><div class="points-bar"><i style="width:${m.stats.points / maxPts * 100}%"></i></div></div>
      <strong>${m.stats.points}<small> pts</small></strong>
    </div>`).join('');
}

function renderMarbles() {
  $('#marbleGrid').innerHTML = save.marbles.map(m => `
    <button class="marble-card" data-edit="${m.id}">
      <div class="marble-big" style="--c:${m.color}">${m.logo ? `<img src="${m.logo}" alt="">` : `<b>${m.number}</b>`}</div>
      <span>${esc(m.name)}</span>
      <small>Career: ${m.career?.wins ?? 0} wins · ${m.career?.podiums ?? 0} podiums</small>
    </button>`).join('');
  $$('[data-edit]', $('#marbleGrid')).forEach(btn => btn.addEventListener('click', () => openEditor(btn.dataset.edit)));
}

function renderHistory() {
  const list = save.history;
  $('#historyList').innerHTML = list.length ? list.map((h, index) => {
    const podium = (h.podium ?? h.results?.slice(0, 3) ?? []).map((r, i) => `${i + 1}. ${esc(marbleById(r.id)?.name ?? r.id)}`).join(' · ');
    return `<button class="history-card" data-history-index="${index}"><div><span>S${h.season} · R${h.round} · ${esc(formatLabel(h.format))}</span><b>${esc(h.title)}</b><small>${podium || 'Race complete'}</small><em>VIEW FULL TABLE →</em></div><code>${esc(h.seed)}</code></button>`;
  }).join('') : '<div class="empty">Your race history will appear here.</div>';
  $$('[data-history-index]', $('#historyList')).forEach(btn => btn.addEventListener('click', () => openHistory(Number(btn.dataset.historyIndex))));
}

function historyRaceRows(h) {
  const results = h.results ?? h.podium ?? [];
  const winnerTime = results[0]?.time ?? 0;
  return results.map((r, i) => {
    const m = marbleById(r.id);
    return `<div class="result-row"><b>${r.position ?? i + 1}</b><i style="background:${m?.color ?? '#fff'}"></i><span>${esc(m?.name ?? r.id)}</span><em>${Number.isFinite(r.time) ? formatTime(r, winnerTime) : (r.dnf ? 'DNF' : '—')}</em></div>`;
  }).join('');
}

function historyStandingRows(h) {
  if (!h.standings?.length) return '<div class="history-unavailable">Championship snapshot is available for races completed from v0.1.1 onward.</div>';
  return h.standings.map((r, i) => {
    const m = marbleById(r.id);
    return `<div class="history-standing"><b>${r.position ?? i + 1}</b><i style="background:${m?.color ?? '#fff'}"></i><span>${esc(m?.name ?? r.id)}<small>${r.wins ?? 0} W · ${r.podiums ?? 0} podiums</small></span><strong>${r.points ?? 0}<small> pts</small></strong></div>`;
  }).join('');
}

function openHistory(index) {
  const h = save.history[index];
  if (!h) return;
  const results = h.results ?? h.podium ?? [];
  const fullAvailable = (h.results?.length ?? 0) > (h.podium?.length ?? 0);
  const sheet = $('#resultsSheet');
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <div class="sheet-head"><div><div class="eyebrow">S${h.season} · ROUND ${h.round} · ${esc(formatLabel(h.format))}</div><h2>${esc(h.title)}</h2><p>Seed ${esc(h.seed)}</p></div></div>
    <div class="history-section-title"><span>RACE CLASSIFICATION</span><b>${results.length} MARBLES</b></div>
    <div class="result-list">${historyRaceRows(h)}</div>
    ${fullAvailable ? '' : '<div class="history-unavailable">Older saved races only kept the podium. New races now store the complete classification.</div>'}
    <div class="history-section-title"><span>CHAMPIONSHIP AFTER ROUND ${h.round}</span><b>SEASON ${h.season}</b></div>
    <div class="history-table">${historyStandingRows(h)}</div>
    <button class="primary big" id="closeHistory">CLOSE</button>`;
  sheet.classList.add('open');
  $('#closeHistory').addEventListener('click', () => sheet.classList.remove('open'));
}

function renderSettings() {
  $('#settingsBody').innerHTML = `
    <div class="settings-card"><h3>Save</h3><p>Your season auto-saves to this browser after every completed race and every marble edit.</p><div class="button-row"><button class="secondary" id="exportSave">EXPORT JSON</button><button class="secondary" id="importSaveBtn">IMPORT JSON</button><input id="importSaveInput" type="file" accept="application/json" hidden></div></div>
    <div class="settings-card"><h3>Season</h3><p>Start a fresh championship while keeping career records and race history.</p><button class="secondary danger" id="newSeasonSettings">START NEW SEASON</button></div>
    <div class="settings-card"><h3>Factory reset</h3><p>Deletes the local MarbleForge save on this device.</p><button class="secondary danger" id="resetGame">RESET EVERYTHING</button></div>`;

  $('#exportSave').addEventListener('click', downloadSave);
  $('#importSaveBtn').addEventListener('click', () => $('#importSaveInput').click());
  $('#importSaveInput').addEventListener('change', importSaveFile);
  $('#newSeasonSettings').addEventListener('click', async () => {
    if (raceBusy) return toast('Finish the current race first.');
    if (!confirm('Start a new season? Current season standings will reset, career records will stay.')) return;
    startNewSeason(save); persist(); renderAll(); switchView('race'); await preparePreview(true);
  });
  $('#resetGame').addEventListener('click', async () => {
    if (!confirm('Delete the whole local MarbleForge save?')) return;
    save = createNewSave(); persist(); renderAll(); switchView('race'); await preparePreview(true);
  });
}

function renderAll() {
  renderChrome();
  renderStandings();
  renderMarbles();
  renderHistory();
  renderSettings();
  renderRaceHome();
  updateControlState();
}

function switchView(view) {
  currentView = view;
  renderChrome();
}

function openEditor(id) {
  if (raceBusy) return toast('Edit marbles between races.');
  editingId = id;
  const m = marbleById(id);
  $('#editName').value = m.name;
  $('#editColor').value = m.color;
  $('#editNumber').value = m.number;
  $('#editLogo').value = '';
  $('#editorPreview').style.setProperty('--c', m.color);
  $('#editorPreview').innerHTML = m.logo ? `<img src="${m.logo}" alt="">` : `<b>${m.number}</b>`;
  $('#editorModal').classList.add('open');
}

async function saveEditor() {
  const m = marbleById(editingId);
  if (!m) return;
  m.name = $('#editName').value.trim().slice(0, 22) || m.name;
  m.color = $('#editColor').value;
  m.number = Math.max(0, Math.min(999, Number($('#editNumber').value) || m.number));
  const file = $('#editLogo').files?.[0];
  if (file) m.logo = await resizeLogo(file);
  persist();
  $('#editorModal').classList.remove('open');
  renderAll();
  await preparePreview(true);
}

function resizeLogo(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const size = 160;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, size, size);
      const s = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/png', 0.9));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read image')); };
    img.src = url;
  });
}

function downloadSave() {
  const blob = new Blob([exportSave(save)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `marbleforge-season-${save.season}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importSaveFile(e) {
  try {
    const file = e.target.files?.[0];
    if (!file) return;
    save = importSave(await file.text());
    persist(); renderAll(); switchView('race'); await preparePreview(true);
    toast('Save imported.');
  } catch (err) {
    console.error(err); toast('That save file is not valid.');
  }
}

function updateControlState() {
  $$('[data-speed]').forEach(btn => btn.classList.toggle('selected', Number(btn.dataset.speed) === engine.speed));
  $$('[data-camera]').forEach(btn => btn.classList.toggle('selected', btn.dataset.camera === engine.cameraMode));
}

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 2200);
}

$$('.nav-btn').forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.view)));
$$('[data-speed]').forEach(btn => btn.addEventListener('click', () => {
  const speed = Number(btn.dataset.speed);
  engine.setSpeed(speed); save.settings.speed = speed; persist(); updateControlState();
}));
$$('[data-camera]').forEach(btn => btn.addEventListener('click', () => {
  const mode = btn.dataset.camera;
  engine.setCamera(mode); save.settings.camera = mode; persist(); updateControlState();
}));
$('#closeEditor').addEventListener('click', () => $('#editorModal').classList.remove('open'));
$('#cancelEditor').addEventListener('click', () => $('#editorModal').classList.remove('open'));
$('#saveEditor').addEventListener('click', saveEditor);
$('#editColor').addEventListener('input', e => $('#editorPreview').style.setProperty('--c', e.target.value));
$('#editLogo').addEventListener('change', async e => {
  const file = e.target.files?.[0];
  if (!file) return;
  const data = await resizeLogo(file);
  $('#editorPreview').innerHTML = `<img src="${data}" alt="">`;
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && raceBusy && engine.running) toast('Race paused by iOS; keep MarbleForge open during a race.');
});

renderAll();
preparePreview(true);

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  let swRefreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (swRefreshing) return;
    swRefreshing = true;
    location.reload();
  });
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
      await reg.update();
    } catch (_) {}
  });
}
