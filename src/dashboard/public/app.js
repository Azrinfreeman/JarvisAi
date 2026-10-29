'use strict';
// All icons are local SVGs; the dashboard has no external font or script requests.
const paths = {
  settings: '<path d="m9 3-1 3-3 1-2 3 2 2-1 3 2 3 3-1 2 3h3l1-3 3-1 2-3-2-2 1-3-2-3-3 1-2-3H9Z"/><circle cx="12" cy="12" r="3"/>',
  play: '<path d="m8 5 11 7-11 7V5Z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  rain: '<path d="M7 15a5 5 0 1 1 .7-9.95A6 6 0 0 1 19 7a4 4 0 0 1-1 8M7 19l-1 2m7-2-1 2m7-2-1 2"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  leaf: '<path d="M20 4c-10-2-17 2-16 9 1 8 15 9 16-9Z"/><path d="M4 21 16 9M9 16v-5m0 5h5"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3m6 0h4"/>',
  pulse: '<path d="M2 12h5l3-8 4 16 3-8h5"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v2"/>',
  chevron: '<path d="m10 7 5 5-5 5"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  moon: '<path d="M21 13a9 9 0 0 1-10-10 9 9 0 1 0 10 10Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  sparkles: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Zm7-1v4m-2-2h4"/>',
  headphones: '<path d="M4 14v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="12" width="4" height="8" rx="2"/><rect x="17" y="12" width="4" height="8" rx="2"/>',
  discord: '<path d="M8 5 5 6c-2 3-3 7-3 11l5 2 1-2m8-12 3 1c2 3 3 7 3 11l-5 2-1-2M8 5a12 12 0 0 1 8 0M7 16a12 12 0 0 0 10 0"/><circle cx="8" cy="12" r="1"/><circle cx="16" cy="12" r="1"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/>',
  chat: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a8.5 8.5 0 0 1 19 0Z"/><path d="M7 9h9m-9 5h6"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4"/><rect x="10" y="10" width="4" height="4" rx=".5"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8l10-5ZM2 12l10 5 10-5M2 16l10 5 10-5"/>',
  tree: '<path d="m12 2-7 9h3l-5 7h18l-5-7h3L12 2Zm0 16v4"/>',
  home: '<path d="m3 10 9-7 9 7M5 9v12h14V9M9 21v-8h6v8"/>',
  window: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M12 3v18M4 12h16m1-6-2 3m2 6-2 3"/>',
  thunder: '<path d="M6 14a5 5 0 1 1 1-9 6 6 0 0 1 11 2 4 4 0 0 1 0 8M13 12l-4 6h5l-3 5"/>',
  quiet: '<path d="M9 5 5 9H2v6h3l4 4V5Zm6 4 6 6m0-6-6 6"/>',
};
function icon(name) { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.rain}</svg>`; }
function hydrateIcons(root = document) { root.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); }); }
hydrateIcons();
const $ = id => document.getElementById(id);
document.querySelector('.skip-link').addEventListener('click', event => {
  event.preventDefault();
  $('main').focus();
});
const scenes = [
  { id: 'forest', name: 'Forest rain', sub: 'A quiet woodland retreat', description: 'Steady rainfall beneath a sheltered forest canopy.', icon: 'tree', command: '/sleep rain style scene:forest', art: 'forest' },
  { id: 'soft', name: 'Soft rain', sub: 'Gentle and unhurried', description: 'Light, even rainfall for settling into your evening.', icon: 'rain', command: '/sleep rain style scene:soft', art: 'rain' },
  { id: 'sunny', name: 'Morning birdsong', sub: 'A brighter kind of calm', description: 'Fresh morning birds and gentle outdoor ambience.', icon: 'sun', command: '/sleep sunny on', art: 'sunny' },
  { id: 'indoor', name: 'Inside the house', description: 'The comfort of listening to rain from indoors.', icon: 'home', command: '/sleep rain style scene:indoor', art: 'indoor' },
  { id: 'glass', name: 'Rain on glass', description: 'A familiar rhythm against the window.', icon: 'window', command: '/sleep rain style scene:glass', art: 'glass' },
  { id: 'heavy', name: 'Heavier rain', description: 'A fuller rain texture for deeper concentration.', icon: 'rain', command: '/sleep rain style scene:heavy', art: 'heavy' },
  { id: 'mild-thunder', name: 'Distant thunder', description: 'Gentle rain with soft thunder in the distance.', icon: 'thunder', command: '/sleep rain mild-thunder', art: 'mild-thunder' },
  { id: 'variety', name: 'Changing skies', description: 'A changing selection of rain and distant thunder.', icon: 'sparkles', command: '/sleep rain style scene:variety', art: 'variety' },
  { id: 'silent', name: 'Quiet presence', description: 'Stay connected in voice with the audio turned off.', icon: 'quiet', command: '/sleep rain off', art: 'forest' },
];
const commands = [
  { name: 'Ask a question', description: 'Get a contextual answer. Add an image or choose a private response in Discord.', command: '/ask', group: 'assistant', icon: 'chat' },
  { name: 'Check AI connection', description: 'See the assistant’s current connection status.', command: '/status', group: 'assistant', icon: 'pulse' },
  { name: 'Clear conversation', description: 'Clear your AI context in the current channel.', command: '/reset', group: 'assistant', icon: 'refresh' },
  { name: 'Change a nickname', description: 'Update a server nickname with the required Discord permissions.', command: '/nickname', group: 'assistant', icon: 'discord' },
  { name: 'Start voice listening', description: 'Controller: announce listening using the consent mode chosen in Settings.', command: '/voice-summary start', group: 'assistant', icon: 'headphones' },
  { name: 'Consent to listening', description: 'Opt in to the current announced session in your voice channel.', command: '/voice-summary consent', group: 'assistant', icon: 'shield' },
  { name: 'Summarize recent voice', description: 'Summarize five minutes already captured into the voice channel’s own text chat.', command: '/voice-summary summarize minutes:5', group: 'assistant', icon: 'chat' },
  { name: 'Review voice recognition', description: 'Check 30 seconds of recent captured speech with the selected local or cloud engine.', command: '/voice-summary test seconds:30', group: 'assistant', icon: 'terminal' },
  { name: 'Withdraw listening consent', description: 'Stop voice capture for everyone and discard pending audio/results. Ambience continues.', command: '/voice-summary withdraw', group: 'assistant', icon: 'stop' },
  { name: 'Join with rain', description: 'Join your voice channel and begin a rain session.', command: '/sleep join mode:rain', group: 'ambience', icon: 'headphones' },
  { name: 'Join with birdsong', description: 'Join your voice channel with morning birds and outdoor ambience.', command: '/sleep join mode:sunny', group: 'ambience', icon: 'sun' },
  { name: 'Join silently', description: 'Stay in your voice channel without playing audio.', command: '/sleep join mode:silent', group: 'ambience', icon: 'quiet' },
  { name: 'Resume rain', description: 'Start the current rain soundscape without leaving voice.', command: '/sleep rain on', group: 'ambience', icon: 'rain' },
  { name: 'Pause ambience', description: 'Turn off the audio and remain in your voice channel.', command: '/sleep rain off', group: 'ambience', icon: 'quiet' },
  { name: 'Choose a rain scene', description: 'Select soft, forest, indoor, glass, heavy, variety, or mild-thunder in Discord.', command: '/sleep rain style', group: 'ambience', icon: 'leaf' },
  { name: 'Check voice session', description: 'View the current voice connection and audio status.', command: '/sleep status', group: 'ambience', icon: 'pulse' },
  { name: 'Leave voice', description: 'Disconnect from voice and disable automatic restoration for this session.', command: '/sleep leave', group: 'ambience', icon: 'headphones' },
];
function escapeHTML(value) { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
$('overview-scenes').innerHTML = scenes.slice(0, 3).map(scene => `<button class="action-row" data-copy="${scene.command}" aria-label="Copy command for ${scene.name}"><span><strong>${scene.name}</strong></span>${icon('copy')}</button>`).join('');
$('scene-grid').innerHTML = scenes.map(scene => `<li class="scene-row"><div><h3>${scene.name}</h3><p>${scene.description}</p></div><button class="button secondary" data-copy="${scene.command}" aria-label="Copy command for ${scene.name}">${icon('copy')}Copy command</button></li>`).join('');
const pageInfo = {
  overview: 'Overview',
  ambience: 'Ambience',
  commands: 'Commands',
  system: 'System health',
  settings: 'Settings',
};
function navigate() {
  const requested = location.hash.slice(1) || 'overview';
  const page = Object.hasOwn(pageInfo, requested) ? requested : 'overview';
  document.querySelectorAll('.page').forEach(el => { el.hidden = el.id !== `page-${page}`; });
  document.querySelectorAll('.nav-item').forEach(el => {
    const selected = el.dataset.page === page;
    el.classList.toggle('selected', selected);
    if (selected) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
  });
  $('page-title').textContent = pageInfo[page];
  document.title = window.rainbot ? 'RainBot' : `RainBot — ${pageInfo[page]}`;
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', navigate);
navigate();
let toastTimer;
function toast(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4200); }
async function copyCommand(command) {
  try { await navigator.clipboard.writeText(command); toast('Command copied. Select it in Discord to continue.'); }
  catch { $('copy-fallback').value = command; $('copy-dialog').showModal(); $('copy-fallback').select(); }
}
document.addEventListener('click', event => {
  const copy = event.target.closest('[data-copy]');
  if (copy) void copyCommand(copy.dataset.copy);
  const go = event.target.closest('[data-go]');
  if (go) location.hash = go.dataset.go;
});
$('close-dialog').addEventListener('click', () => $('copy-dialog').close());
let filter = 'all';
function renderCommands() {
  const query = $('command-search').value.trim().toLowerCase();
  const matches = commands.filter(command => (filter === 'all' || command.group === filter) && `${command.name} ${command.description} ${command.command}`.toLowerCase().includes(query));
  $('commands-list').innerHTML = matches.length ? matches.map(command => `<li class="command-row"><div><code>${command.command}</code><h3>${command.name}</h3><p>${command.description}</p></div><button class="icon-button" data-copy="${command.command}" aria-label="Copy ${command.name.toLowerCase()} command" title="Copy command">${icon('copy')}</button></li>`).join('') : `<li class="empty-state"><strong>No matching commands</strong><p>Try another search or select a different category.</p></li>`;
}
$('command-search').addEventListener('input', renderCommands);
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
  filter = button.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach(el => { const active = el === button; el.classList.toggle('active', active); el.setAttribute('aria-pressed', String(active)); });
  renderCommands();
}));
renderCommands();
document.addEventListener('keydown', event => {
  if (event.key === '/' && !event.ctrlKey && !event.metaKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !document.activeElement.isContentEditable && !document.querySelector('dialog[open]')) {
    event.preventDefault(); location.hash = 'commands'; navigate(); $('command-search').focus();
  }
});
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('theme-toggle').innerHTML = icon(theme === 'dark' ? 'sun' : 'moon');
  $('theme-toggle').setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`);
}
let savedTheme;
try { savedTheme = localStorage.getItem('rainbot-theme'); } catch { /* Browser storage may be disabled. */ }
applyTheme(savedTheme === 'dark' ? 'dark' : 'light');
$('theme-toggle').addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(theme);
  try { localStorage.setItem('rainbot-theme', theme); } catch { /* Theme still applies for this visit. */ }
});
const phaseLabels = { ready: 'Available', starting: 'Starting', unavailable: 'Unavailable', restarting: 'Reconnecting', offline: 'Offline' };
function badge(id, text, tone = '') { $(id).textContent = text; $(id).className = `badge ${tone}`; }
function metric(id, value, unit) { $(id).innerHTML = value === null || value === undefined ? '—' : `${escapeHTML(value)}<span class="unit">${unit}</span>`; }
function renderStatus(status) {
  const live = status.state === 'live';
  const count = status.sessions.length;
  const playing = status.sessions.filter(session => session.audio === 'playing').length;
  $('discord-value').textContent = status.discordReady ? 'Connected' : 'Offline';
  $('discord-value').dataset.tone = status.discordReady ? 'good' : '';
  $('ai-value').textContent = phaseLabels[status.aiPhase] || 'Unavailable';
  $('ai-value').dataset.tone = status.aiPhase === 'ready' ? 'good' : live ? 'warning' : '';
  $('session-value').textContent = live ? `${count} ${count === 1 ? 'session' : 'sessions'}` : 'Unavailable';
  $('session-detail').textContent = playing ? `${playing} playing ambience` : live ? 'No audio playing' : 'Live status unavailable';
  $('last-updated').textContent = live ? `Updated ${new Date(status.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : status.state === 'unavailable' ? 'No runtime snapshot available' : 'Runtime snapshot is no longer current';
  $('footer-status').innerHTML = `<span class="local-dot"></span>${live ? 'Live local status' : 'Companion offline'}`;
  metric('cpu-value', status.metrics?.cpuPercent, '%');
  metric('memory-value', status.metrics?.memoryMiB, 'MiB');
  metric('loop-value', status.metrics?.eventLoopMs, 'ms');
  const healthy = live && status.discordReady && status.aiPhase === 'ready';
  $('system-title').textContent = healthy ? 'Your companion is connected' : live ? 'Some services need attention' : 'Companion is offline';
  $('system-description').textContent = live ? 'Status is refreshed automatically from the local runtime.' : 'Start the bot from Overview to see live status.';
  badge('system-badge', healthy ? 'Operational' : live ? 'Attention needed' : 'Offline', healthy ? 'good' : live ? 'warning' : '');
  $('system-discord').textContent = status.discordReady ? 'Connected' : 'Offline';
  $('system-ai').textContent = phaseLabels[status.aiPhase] || 'Unavailable';
  $('system-sessions').textContent = live ? String(count) : '—';
  $('system-time').textContent = status.updatedAt ? new Date(status.updatedAt).toLocaleString() : 'Not available';
  $('sessions').innerHTML = count ? status.sessions.map((session, index) => {
    const name = session.mode === 'rain' ? scenes.find(scene => scene.id === session.rainStyle)?.name || 'Rain' : session.mode === 'sunny' ? 'Morning birdsong' : 'Quiet presence';
    return `<div class="session-row"><div><strong>Session ${index + 1}: ${escapeHTML(name)}</strong><small>Voice: ${escapeHTML(session.voice)}; audio: ${escapeHTML(session.audio)}</small></div><span class="badge ${session.audio === 'playing' ? 'good' : ''}">${session.audio === 'playing' ? 'Playing' : 'Standby'}</span></div>`;
  }).join('') : `<div class="empty-state">${icon('headphones')}<strong>${live ? 'No active voice sessions' : 'No live sessions to display'}</strong><p>${live ? 'Join a voice channel in Discord and use /sleep join to start a session.' : 'Voice sessions appear here when the companion is running.'}</p></div>`;
}
let refreshing = false;
async function refreshStatus(manual = false) {
  if (refreshing) return;
  refreshing = true;
  $('refresh').disabled = true;
  try {
    const response = await window.rainbotRequest('/api/status', { signal: AbortSignal.timeout(6000), cache: 'no-store' });
    if (!response.ok) throw new Error('Unable to read local status');
    renderStatus(await response.json());
    if (manual) toast('Status refreshed.');
  } catch {
    renderStatus({ state: 'unavailable', updatedAt: null, aiPhase: 'offline', discordReady: false, sessions: [], metrics: null });
    $('last-updated').textContent = 'Dashboard connection unavailable';
    $('footer-status').innerHTML = `<span class="local-dot"></span>Dashboard disconnected`;
    $('system-title').textContent = 'Dashboard connection unavailable';
    $('system-description').textContent = 'Check that the local dashboard server is running, then refresh.';
    if (manual) toast('Unable to refresh. Check the dashboard server.');
  } finally { refreshing = false; $('refresh').disabled = false; }
}
$('refresh').addEventListener('click', () => void refreshStatus(true));
void refreshStatus();
setInterval(() => { if (!document.hidden) void refreshStatus(); }, 10000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshStatus(); });

// Administrative state is held only in memory. Credentials never enter browser storage.
let csrf = '';
let settingsData;
let management;
let settingsDirty = false;
let savingSettings = false;
let connectionTest = false;
let operationTimer;
let managementBusy = false;
let managementPromise;
let setupBusy = false;
let chatgptConnected = false;
const removedSecrets = new Set();
const form = $('settings-form');
const secretFields = ['DISCORD_BOT_TOKEN','OPENAI_API_KEY','VOICE_SUMMARY_API_KEY'];
const fieldLabels = { DISCORD_BOT_TOKEN:'Bot token',DISCORD_APPLICATION_ID:'Application ID',DISCORD_GUILD_ID:'Server ID',
  OWNER_DISCORD_ID:'Owner ID',ACCESS_MODE:'Access mode',ALLOWED_CHANNEL_IDS:'Allowed channel IDs',ALLOWED_ROLE_IDS:'Allowed role IDs',
  CONTROLLER_ROLE_IDS:'Sleep controller role IDs',RAIN_VOLUME:'Volume',AI_PROVIDER:'Provider',CHATGPT_MODEL:'ChatGPT model',
  CHATGPT_REASONING_EFFORT:'ChatGPT reasoning',OPENAI_MODEL:'API model',OPENAI_REASONING_EFFORT:'API reasoning',OPENAI_WEB_SEARCH:'Web search',OPENAI_API_KEY:'API key',
  VOICE_SUMMARY_ENABLED:'Voice summaries',VOICE_SUMMARY_CONSENT_MODE:'Voice consent',VOICE_SUMMARY_PROVIDER:'Transcription provider',VOICE_SUMMARY_LOCAL_DEVICE:'Local device',VOICE_SUMMARY_API_KEY:'Speech API key',VOICE_SUMMARY_MODEL:'Transcription model',
  VOICE_SUMMARY_LANGUAGES:'Expected languages',VOICE_SUMMARY_GLOSSARY:'Voice glossary',VOICE_SUMMARY_MINUTES:'Summary window',
  VOICE_SUMMARY_MONTHLY_MINUTES:'Monthly transcription allowance',VOICE_SUMMARY_LANGUAGE:'Summary language' };
function friendly(message) { return String(message).replace(/[A-Z][A-Z_]+/g, key => fieldLabels[key] || key); }
async function adminRequest(path, method = 'GET', body) {
  const response = await window.rainbotRequest(path, { method, cache:'no-store', signal:AbortSignal.timeout(path.endsWith('ai-response') ? 55000 : 40000),
    headers:{ ...(body !== undefined ? {'Content-Type':'application/json'} : {}), ...(csrf ? {'X-CSRF-Token':csrf} : {}) },
    ...(body !== undefined ? {body:JSON.stringify(body)} : {}) });
  const value = await response.json();
  if (!response.ok) {
    if (response.status === 401) setAuthorized('');
    throw new Error(friendly(value.error || 'The request could not be completed.'));
  }
  return value;
}
function setAuthorized(token) {
  csrf = token;
  $('settings-locked').hidden = !!token;
  form.hidden = !token;
  if (!token) {
    settingsData = undefined; management = undefined;
    form.reset(); removedSecrets.clear(); settingsDirty = false;
    renderVoiceSummary();
    localSpeechStatus=undefined; renderLocalSpeech();
    $('management-notice').hidden = true;
    $('bot-control').disabled = false;
    $('bot-control').classList.remove('stop-button');
    $('bot-control').innerHTML = `${icon('lock')}<span>Connect workspace</span>`;
  }
}
function showConnect() { $('connect-error').hidden = true; $('connect-dialog').showModal(); $('access-code').focus(); }
$('settings-connect').addEventListener('click', showConnect);
$('cancel-connect').addEventListener('click', () => { $('access-code').value=''; $('connect-dialog').close(); });
$('connect-dialog').addEventListener('close', () => { $('access-code').value=''; });
$('connect-form').addEventListener('submit', async event => {
  event.preventDefault(); $('submit-connect').disabled = true;
  const code = $('access-code').value.trim(); $('access-code').value='';
  try {
    const session = await adminRequest('/api/session','POST',{code});
    setAuthorized(session.csrf); $('connect-dialog').close();
    await loadSettings(); await refreshManagement(); toast('Workspace connected.');
  } catch(error) { $('connect-error').textContent=error.message; $('connect-error').hidden=false; }
  finally { $('submit-connect').disabled=false; }
});
function displayProvider() {
  const api = $('ai-provider').value === 'openai';
  $('openai-settings').hidden = !api; $('chatgpt-settings').hidden = api;
  displayVoiceProvider();
  $('volume-output').textContent = `${Math.round(Number($('volume').value)*100)}%`;
}
function displayVoiceProvider() {
  const cloud=$('voice-summary-provider').value === 'openai';
  document.querySelectorAll('[data-voice-cloud]').forEach(element=>{element.hidden=!cloud;});
  $('local-speech-settings').hidden=cloud;
  $('voice-summary-model').required=cloud;
  $('voice-summary-monthly').required=cloud;
  $('voice-summary-privacy').textContent=cloud
    ? 'Selected audio goes to OpenAI. Transcripts go to your selected summary provider. A separate speech API key is required.'
    : 'Audio stays on this device. Transcripts go to your selected summary provider. No speech API key needed.';
  $('voice-summary-test-help').textContent=cloud
    ? 'Run after 30 seconds of listening. Sends audio to OpenAI and may use API credit.'
    : 'Run in voice-channel text chat after 30 seconds of listening.';
}
function changes() {
  const values = {}; const secrets = {};
  if (!settingsData) return {values,secrets};
  for (const [key, original] of Object.entries(settingsData.values)) {
    const input = form.elements.namedItem(key);
    if (input && !input.disabled && input.value !== original) values[key] = input.value.trim();
  }
  for (const key of secretFields) {
    const input = form.elements.namedItem(key);
    if (input.disabled) continue;
    if (removedSecrets.has(key)) secrets[key] = {action:'remove'};
    else if (input.value) secrets[key] = {action:'replace',value:input.value.trim()};
  }
  return { values, secrets };
}
function markDirty() {
  displayProvider();
  const changed = changes();
  settingsDirty = !!(Object.keys(changed.values).length || Object.keys(changed.secrets).length);
  $('dirty-badge').hidden = !settingsDirty;
  $('save-settings').disabled = !settingsDirty || savingSettings;
  $('discard-settings').disabled = !settingsDirty || savingSettings;
  document.querySelectorAll('.test-button').forEach(button => { button.disabled = settingsDirty || connectionTest || savingSettings; });
  document.querySelectorAll('.remove-secret').forEach(button => {
    const key = button.dataset.secret;
    button.textContent = removedSecrets.has(key) ? 'Keep' : 'Remove';
    button.disabled = !settingsData || settingsData.overridden.includes(key) || !settingsData.secrets[key] && !form.elements.namedItem(key).value && !removedSecrets.has(key);
  });
  renderLocalSpeech();
  updateDesktopActions();
}
function renderSettings(data) {
  settingsData = data; removedSecrets.clear();
  for (const [key,value] of Object.entries(data.values)) {
    const input = form.elements.namedItem(key);
    if (!input) continue;
    if (key === 'AI_PROVIDER' && value === 'stub' && !input.querySelector('option[value="stub"]')) {
      const option = document.createElement('option'); option.value='stub'; option.textContent='Offline test mode'; input.append(option);
    }
    input.value=value; input.disabled=data.overridden.includes(key);
    input.title=input.disabled ? 'Managed by the deployment environment' : '';
  }
  for (const [key,id] of [['DISCORD_BOT_TOKEN','token-presence'],['OPENAI_API_KEY','api-presence'],['VOICE_SUMMARY_API_KEY','voice-api-presence']]) {
    const input=form.elements.namedItem(key); input.value=''; input.disabled=data.overridden.includes(key);
    input.title=input.disabled ? 'Managed by the deployment environment' : '';
    $(id).textContent=data.secrets[key] ? data.overridden.includes(key) ? 'Configured externally' : 'Configured' : 'Not configured';
  }
  $('settings-summary').textContent=data.missing.length ? `Complete setup: ${data.missing.map(key => fieldLabels[key] || key).join(', ')}.` : 'Saved settings apply on the next start.';
  markDirty();
}
async function loadSettings() {
  if (!csrf) return;
  try { renderSettings(await adminRequest('/api/settings')); void refreshVoiceSummary(); void refreshLocalSpeech(); }
  catch(error) { settingsFeedback(error.message,true); }
}
function settingsFeedback(message, error = false) {
  $('settings-feedback').textContent=message; $('settings-feedback').classList.toggle('error',error); $('settings-feedback').hidden=false;
}
function renderVoiceSummary(status = {}) {
  const labels = {off:'Off',waiting:'Waiting for opt-in',listening:'Listening',paused:'Paused',processing:'Processing'};
  badge('voice-summary-state',labels[status.state] || 'Off',status.state === 'listening' ? 'good' : ['waiting','paused','processing'].includes(status.state) ? 'warning' : '');
  $('voice-summary-coverage').textContent=`${Math.floor(status.coverageSeconds || 0)} seconds`;
  $('voice-summary-participants').textContent=String(status.participants || 0);
  $('voice-summary-channel').textContent=status.channelId || 'None';
  $('voice-summary-active-model').textContent=status.model || 'Not available';
  $('voice-summary-usage').textContent=`${((status.usageSeconds || 0)/60).toFixed(1)} minutes`;
  $('voice-summary-message').textContent=status.message || 'Voice listening is off.';
}
let voiceSummaryRefreshing = false;
async function refreshVoiceSummary() {
  if (!csrf || voiceSummaryRefreshing) return;
  voiceSummaryRefreshing=true;
  try {
    const status=await adminRequest('/api/voice-summary');
    if (csrf) renderVoiceSummary(status);
  } catch { renderVoiceSummary({message:'Live voice status is unavailable.'}); }
  finally { voiceSummaryRefreshing=false; }
}
let localSpeechStatus;
let localSpeechRefreshing=false;
let localSpeechRequest=false;
let localSpeechEpoch=0;
function renderLocalSpeech() {
  const status=localSpeechStatus;
  const downloading=status?.state === 'downloading';
  $('local-speech-setup').disabled=!csrf || localSpeechRequest || downloading || status?.state === 'ready';
  $('local-speech-cancel').hidden=!downloading;
  $('local-speech-cancel').disabled=localSpeechRequest;
  $('local-speech-progress').hidden=!downloading;
  const progress=Number.isFinite(status?.progress) ? Math.max(0,Math.min(100,status.progress)) : 0;
  $('local-speech-progress').value=progress;
  $('local-speech-status').textContent=status
    ? [status.message, downloading ? `${Math.round(progress)}%` : '', status.state === 'ready' ? status.model : ''].filter(Boolean).join(' - ')
    : 'Checking local transcription...';
}
async function refreshLocalSpeech() {
  if (!csrf || localSpeechRefreshing || localSpeechRequest) return;
  const session=csrf, epoch=localSpeechEpoch;
  localSpeechRefreshing=true;
  try {
    const status=await adminRequest('/api/voice-summary/local');
    if (csrf === session && epoch === localSpeechEpoch) { localSpeechStatus=status; renderLocalSpeech(); }
  } catch(error) {
    if (csrf === session && epoch === localSpeechEpoch) $('local-speech-status').textContent=error.message;
  } finally { localSpeechRefreshing=false; }
}
async function localSpeechAction(action) {
  if (!csrf || localSpeechRequest) return;
  const session=csrf;
  localSpeechEpoch++;
  localSpeechRequest=true; renderLocalSpeech();
  try {
    const status=await adminRequest(`/api/voice-summary/local/${action}`,'POST',{});
    if (csrf === session) { localSpeechStatus=status; renderLocalSpeech(); }
  } catch(error) {
    if (csrf === session) $('local-speech-status').textContent=error.message;
  } finally {
    localSpeechRequest=false;
    $('local-speech-setup').disabled=!csrf || localSpeechStatus?.state === 'downloading' || localSpeechStatus?.state === 'ready';
    $('local-speech-cancel').disabled=false;
  }
}
$('local-speech-setup').addEventListener('click',()=>void localSpeechAction('setup'));
$('local-speech-cancel').addEventListener('click',()=>void localSpeechAction('cancel'));
form.addEventListener('input', event => {
  if (secretFields.includes(event.target.name) && event.target.value) removedSecrets.delete(event.target.name);
  markDirty();
});
form.addEventListener('change',markDirty);
document.querySelectorAll('.remove-secret').forEach(button => button.addEventListener('click', () => {
  const key=button.dataset.secret;
  if (removedSecrets.has(key)) removedSecrets.delete(key); else { removedSecrets.add(key); form.elements.namedItem(key).value=''; }
  markDirty();
}));
$('discard-settings').addEventListener('click', () => { if (settingsData) renderSettings(settingsData); $('settings-feedback').hidden=true; });
form.addEventListener('submit', async event => {
  event.preventDefault(); if (!settingsData || !settingsDirty || savingSettings) return;
  const update={revision:settingsData.revision,...changes()};
  savingSettings=true; markDirty(); form.inert=true;
  try {
    const saved=await adminRequest('/api/settings','PUT',update);
    renderSettings(saved); settingsFeedback('Settings saved. They will apply the next time you start the bot.');
    await refreshManagement(true);
  } catch(error) { settingsFeedback(error.message,true); }
  finally {
    // Do not retain new credentials even if validation or the connection fails.
    for (const key of secretFields) form.elements.namedItem(key).value='';
    savingSettings=false; form.inert=false; markDirty();
  }
});
document.querySelectorAll('[data-test]').forEach(button => button.addEventListener('click', async () => {
  if (settingsDirty || connectionTest) return;
  connectionTest=true; markDirty(); settingsFeedback('Checking the saved connection…');
  try {
    const result=await adminRequest(`/api/settings/test-${button.dataset.test}`,'POST',{});
    if (result.models) {
      $('api-models').innerHTML=result.models.map(model => `<option value="${escapeHTML(model)}"></option>`).join('');
    }
    settingsFeedback(result.message);
  } catch(error) { settingsFeedback(error.message,true); }
  finally { connectionTest=false; markDirty(); }
}));
function renderManagement(value) {
  management=value;
  $('clear-stale-locks').hidden=!['blocked','stopped','external'].includes(value.state);
  const control=$('bot-control');
  const busy=value.state === 'starting' || value.state === 'stopping';
  const label=busy ? value.state === 'starting' ? 'Starting…' : 'Stopping…' : value.state === 'running' ? 'Stop bot' : value.state === 'stopped' ? value.missing.length ? 'Complete setup' : 'Start bot' : value.state === 'external' ? 'Externally managed' : 'Controls unavailable';
  control.disabled=busy || ['external','blocked'].includes(value.state);
  control.innerHTML=`${icon(value.state === 'running' ? 'stop' : value.state === 'stopped' ? 'play' : 'info')}<span>${label}</span>`;
  control.classList.toggle('stop-button',value.state === 'running');
  $('management-notice').hidden=false;
  $('management-message').textContent=value.restartRequired ? 'Restart required. Stop and start the bot to apply saved changes.' : value.state === 'running' ? 'Stopping the bot disconnects voice and interrupts active AI requests.' : value.message;
  $('restart-note').textContent=value.restartRequired ? 'Saved. Restart required' : 'Settings are saved locally on this device.';
  updateDesktopActions();
}
async function refreshManagement(fresh = false) {
  if (!csrf) return;
  if (managementBusy) {
    if (fresh) { await managementPromise; return refreshManagement(true); }
    return managementPromise;
  }
  managementBusy=true;
  managementPromise=(async () => {
    try { renderManagement(await adminRequest(`/api/management${fresh ? '?fresh=1' : ''}`)); }
    catch(error) {
      if (csrf) renderManagement({state:'blocked',message:error.message,restartRequired:false,missing:[]});
    } finally { managementBusy=false; }
  })();
  return managementPromise;
}
async function pollOperation(id) {
  clearTimeout(operationTimer);
  try {
    const operation=await adminRequest(`/api/operations/${id}`);
    $('management-message').textContent=operation.message;
    if (operation.status === 'pending') { operationTimer=setTimeout(() => void pollOperation(id),1500); return; }
    toast(operation.message); await refreshManagement(true); void refreshStatus();
  } catch(error) { toast(error.message); await refreshManagement(); }
}
$('bot-control').addEventListener('click', async () => {
  if (!csrf) { showConnect(); return; }
  if (!management || ['blocked','external','starting','stopping'].includes(management.state)) return;
  if (management.state === 'stopped' && management.missing.length) { location.hash='settings'; return; }
  const action=management.state === 'running' ? 'stop' : 'start';
  $('bot-control').disabled=true;
  try {
    const operation=await adminRequest(`/api/bot/${action}`,'POST',{});
    renderManagement({state:operation.action === 'start' ? 'starting' : 'stopping',message:operation.message,restartRequired:false,missing:[]});
    void pollOperation(operation.id);
  } catch(error) { toast(error.message); await refreshManagement(); }
});
$('reload-management').addEventListener('click',() => void refreshManagement());
$('clear-stale-locks').addEventListener('click',async () => {
  const button=$('clear-stale-locks');
  button.disabled=true;
  try {
    const result=await adminRequest('/api/bot/clear-stale-locks','POST',{});
    toast(result.message);
    await refreshManagement(true);
  } catch(error) { toast(error.message); }
  finally { button.disabled=false; }
});
$('refresh').addEventListener('click',() => void refreshManagement());
window.addEventListener('beforeunload',event => { if (settingsDirty) { event.preventDefault(); event.returnValue=''; } });
window.addEventListener('hashchange',() => {
  if (location.hash !== '#settings') {
    let cleared=false;
    for (const key of secretFields) { const input=form.elements.namedItem(key); if (input.value) {input.value='';cleared=true;} }
    if (cleared) { markDirty(); toast('Unsaved credentials cleared. Other edits are preserved.'); }
  }
});
window.addEventListener('pagehide',() => {
  for (const key of secretFields) form.elements.namedItem(key).value='';
});
async function initializeOwner() {
  try {
    // Fragment tokens are consumed before navigation and are never sent as URL parameters.
    const fragment=new URLSearchParams(location.hash.slice(1));
    const code=fragment.get('connect');
    if (code) history.replaceState(null,'',location.pathname);
    const session=code ? await adminRequest('/api/session','POST',{code}) : await adminRequest('/api/session');
    setAuthorized(session.authorized ? session.csrf : '');
    if (csrf) { await loadSettings(); await refreshManagement(); if (settingsData?.missing.length && !location.hash) { location.hash='settings'; } }
  } catch(error) { setAuthorized(''); toast(error.message); }
}
void initializeOwner();
setInterval(() => { if (!document.hidden && csrf) { void refreshManagement(); void refreshVoiceSummary(); void refreshLocalSpeech(); } },10000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && csrf) { void refreshVoiceSummary(); void refreshLocalSpeech(); } });

function updateDesktopActions() {
  if(!window.rainbot)return;
  const api=$('ai-provider').value === 'openai';
  for(const id of ['connect-chatgpt','switch-chatgpt','disconnect-chatgpt','desktop-auth-status','chatgpt-account-help'])$(id).hidden=api;
  $('connect-chatgpt').textContent=chatgptConnected ? 'Reconnect ChatGPT' : 'Connect ChatGPT';
  document.querySelectorAll('.desktop-action').forEach(button=>{button.disabled=setupBusy || settingsDirty || savingSettings;});
  const stopped=management?.state === 'stopped';
  $('connect-chatgpt').disabled ||= !stopped;
  $('switch-chatgpt').disabled ||= !stopped;
  $('disconnect-chatgpt').disabled ||= !stopped || !chatgptConnected;
  $('import-installation').disabled ||= !stopped || !settingsData || settingsData.revision !== 'legacy';
}
async function refreshDesktopAuth() {
  if(!window.rainbot)return;
  try {
    chatgptConnected=(await window.rainbot.authStatus()).connected;
    $('desktop-auth-status').textContent=chatgptConnected ? 'ChatGPT connected' : 'ChatGPT not connected';
  } catch {$('desktop-auth-status').textContent='Connection unavailable';}
  updateDesktopActions();
}
async function desktopAction(work, login = false, switching = false) {
  if(setupBusy || settingsDirty)return;
  setupBusy=true;form.inert=true;updateDesktopActions();$('cancel-chatgpt').hidden=!login;
  const feedback=$('desktop-setup-feedback');feedback.hidden=false;
  feedback.textContent=login ? (switching ? 'Choose the ChatGPT account you want in your browser. If the old account is selected, sign out there first. Your saved connection stays until sign-in succeeds. You can cancel here.' : 'Continue in your browser to connect or reconnect ChatGPT. You can cancel sign-in here.') : 'Working…';
  try {const result=await work();feedback.textContent=result?.message || '';}
  catch(error) {feedback.textContent=error.message;}
  finally {setupBusy=false;form.inert=false;$('cancel-chatgpt').hidden=true;await loadSettings();await refreshManagement(true);await refreshDesktopAuth();}
}
if(window.rainbot) {
  document.title='RainBot';$('desktop-setup').hidden=false;
  document.querySelector('#chatgpt-settings .field-help').textContent='Stop the bot, then connect, reconnect, or choose a different ChatGPT account above. Account eligibility is required.';
  $('register-commands').addEventListener('click',()=>void desktopAction(()=>window.rainbot.registerCommands()));
  $('connect-chatgpt').addEventListener('click',()=>void desktopAction(()=>window.rainbot.authConnect(),true));
  $('switch-chatgpt').addEventListener('click',()=>void desktopAction(()=>window.rainbot.authSwitch(),true,true));
  $('disconnect-chatgpt').addEventListener('click',()=>void desktopAction(()=>window.rainbot.authDisconnect()));
  $('cancel-chatgpt').addEventListener('click',()=>void window.rainbot.authCancel().catch(error=>toast(error.message)));
  const review=document.createElement('dialog');review.className='connect-dialog';
  review.setAttribute('aria-labelledby','import-title');
  review.innerHTML='<h2 id="import-title">Import installation</h2><p class="import-summary"></p><div class="settings-actions"><button type="button" class="button secondary" data-import-cancel>Cancel</button><button type="button" class="button primary" data-import-confirm>Import</button></div>';
  document.body.append(review);
  let ticket;
  review.querySelector('[data-import-cancel]').addEventListener('click',()=>{ticket=undefined;review.close();});
  review.querySelector('[data-import-confirm]').addEventListener('click',()=>{
    const selected=ticket;ticket=undefined;review.close();
    if(selected)void desktopAction(()=>window.rainbot.importCommit(selected));
  });
  $('import-installation').addEventListener('click',()=>void desktopAction(async()=>{
    const preview=await window.rainbot.importSelect();
    if(preview.cancelled)return {message:'Import cancelled.'};
    ticket=preview.ticket;
    review.querySelector('.import-summary').textContent=`${preview.message} ${preview.files} files and ${preview.databases} databases will be imported.`;
    review.showModal();return {message:'Review the import before continuing.'};
  }));
  void refreshDesktopAuth();
}

document.addEventListener('pointerdown', event => {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  button.dataset.pointerPressed = 'true';
  const release = () => {
    delete button.dataset.pointerPressed;
    window.removeEventListener('pointerup', release);
    window.removeEventListener('pointercancel', release);
    window.removeEventListener('blur', release);
  };
  window.addEventListener('pointerup', release, { once: true });
  window.addEventListener('pointercancel', release, { once: true });
  window.addEventListener('blur', release, { once: true });
});
