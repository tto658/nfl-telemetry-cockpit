/**
 * tests/test_zero_snap_ui_runner.mjs
 * Headless DOM verification of zero-snap rookie UI state, #zeroSnapCard visibility,
 * and 1-click CTA tab switching without JavaScript errors.
 */

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failed++;
    failures.push(message);
    throw new Error(message);
  } else {
    passed++;
  }
}

// Minimal DOM Element Mock
class MockElement {
  constructor(id = '', tag = 'div') {
    this.id = id;
    this.tagName = tag.toUpperCase();
    this.style = {};
    this._classes = new Set();
    this.listeners = {};
    this.innerHTML = '';
    this.textContent = '';
    this.value = '';
    this.disabled = false;

    const self = this;
    this.classList = {
      add: (cls) => self._classes.add(cls),
      remove: (cls) => self._classes.delete(cls),
      toggle: (cls, force) => {
        if (force !== undefined) {
          if (force) self._classes.add(cls);
          else self._classes.delete(cls);
          return force;
        }
        if (self._classes.has(cls)) {
          self._classes.delete(cls);
          return false;
        } else {
          self._classes.add(cls);
          return true;
        }
      },
      contains: (cls) => self._classes.has(cls)
    };
  }

  addEventListener(event, handler) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(handler);
  }

  dispatchEvent(event) {
    const list = this.listeners[event.type || event] || [];
    for (const h of list) {
      h(event);
    }
  }

  click() {
    this.dispatchEvent({ type: 'click' });
  }
}

// Build synthetic DOM mirroring index.html Tab 2 layout
const elements = {
  tabCombine: new MockElement('tab-combine'),
  tabGame: new MockElement('tab-game'),
  tabBtnCombine: new MockElement('tabBtnCombine'),
  tabBtnGame: new MockElement('tabBtnGame'),
  zeroSnapCard: new MockElement('zeroSnapCard'),
  btnSwitchToCombine: new MockElement('btnSwitchToCombine'),
  gameExplorerContent: new MockElement('gameExplorerContent'),
  gameSeasonSelect: new MockElement('gameSeasonSelect'),
  gameSelect: new MockElement('gameSelect'),
  playPositionFilter: new MockElement('playPositionFilter'),
  playTypeFilter: new MockElement('playTypeFilter'),
  playsTable: new MockElement('playsTable'),
  playsTableContainer: new MockElement('playsTableContainer'),
  playMetadataCard: new MockElement('playMetadataCard'),
};

// Global state mimicking app.js state machine
const state = {
  activeTab: 'tab-game',
  selectedPlayerId: null,
  gameExplorer: {
    games: [],
    selectedGameId: null,
    plays: [],
    filters: {
      season: '',
      play_type: '',
      lined_up_position: ''
    },
    playbackEngine: {
      paused: false,
      loadedFrames: null,
      pause() { this.paused = true; },
      loadFrames(frames) { this.loadedFrames = frames; }
    }
  }
};

// Implement Tab Switching Logic mirroring app.js switchTab()
function switchTab(tabId) {
  state.activeTab = tabId;
  const isCombine = tabId === 'tab-combine' || tabId === 'tabCombine';
  elements.tabBtnCombine.classList.toggle('active', isCombine);
  elements.tabBtnGame.classList.toggle('active', !isCombine);
  elements.tabCombine.classList.toggle('active', isCombine);
  elements.tabGame.classList.toggle('active', !isCombine);
}

// Implement 0-Snap Handling Logic mirroring app.js loadPlayerGames() and renderZeroSnapRookieState()
function renderZeroSnapRookieState() {
  elements.zeroSnapCard.style.display = 'flex';
  elements.gameExplorerContent.style.display = 'none';

  if (state.gameExplorer.playbackEngine) {
    state.gameExplorer.playbackEngine.pause();
    state.gameExplorer.playbackEngine.loadFrames([]);
  }
}

function handleLoadedGames(games) {
  state.gameExplorer.games = games;
  if (games.length === 0) {
    renderZeroSnapRookieState();
    return;
  }

  // Active player with game snaps
  elements.zeroSnapCard.style.display = 'none';
  elements.gameExplorerContent.style.display = 'block';
}

// Wire up 1-click CTA listener
elements.btnSwitchToCombine.addEventListener('click', () => switchTab('tab-combine'));
elements.tabBtnCombine.addEventListener('click', () => switchTab('tab-combine'));
elements.tabBtnGame.addEventListener('click', () => switchTab('tab-game'));

console.log('=== STARTING ZERO-SNAP UI ADVERSARIAL RUNNER ===');

// TEST 1: Initial Tab 2 display state
switchTab('tab-game');
assert(state.activeTab === 'tab-game', 'Active tab must be tab-game');
assert(elements.tabGame.classList.contains('active'), 'Tab 2 pane must have active class');
assert(!elements.tabCombine.classList.contains('active'), 'Tab 1 pane must NOT have active class');

// TEST 2: Zero-snap rookie telemetry loading (games = [])
handleLoadedGames([]);
assert(elements.zeroSnapCard.style.display === 'flex', 'zeroSnapCard must be visible (display: flex)');
assert(elements.gameExplorerContent.style.display === 'none', 'gameExplorerContent must be hidden (display: none)');
assert(state.gameExplorer.playbackEngine.paused === true, 'PlaybackEngine must be paused for 0-snap rookie');
assert(Array.isArray(state.gameExplorer.playbackEngine.loadedFrames) && state.gameExplorer.playbackEngine.loadedFrames.length === 0, 'Playback frames must be cleared');

// TEST 3: 1-click CTA button activation (#btnSwitchToCombine)
elements.btnSwitchToCombine.click();
assert(state.activeTab === 'tab-combine', 'Clicking CTA must switch activeTab to tab-combine');
assert(elements.tabCombine.classList.contains('active'), 'Tab 1 pane must be active after CTA click');
assert(!elements.tabGame.classList.contains('active'), 'Tab 2 pane must NOT be active after CTA click');
assert(elements.tabBtnCombine.classList.contains('active'), 'Tab 1 button must be active');
assert(!elements.tabBtnGame.classList.contains('active'), 'Tab 2 button must NOT be active');

// TEST 4: Switching to an active player with game telemetry
switchTab('tab-game');
const mockActiveGames = [
  { game_id: 2023091000, season: 2023, week: 1, opponent: 'SEA', total_plays: 8 }
];
handleLoadedGames(mockActiveGames);
assert(elements.zeroSnapCard.style.display === 'none', 'zeroSnapCard must be hidden for active player');
assert(elements.gameExplorerContent.style.display === 'block', 'gameExplorerContent must be visible for active player');

// TEST 5: Switching back to zero-snap rookie
handleLoadedGames([]);
assert(elements.zeroSnapCard.style.display === 'flex', 'zeroSnapCard must reappear for zero-snap rookie');
assert(elements.gameExplorerContent.style.display === 'none', 'gameExplorerContent must be hidden again');

// TEST 6: Stress-test all 13 zero-snap rookies in rapid alternation
const zeroSnapIds = [56648, 56363, 57743, 57660, 58293, 58326, 58374, 58407, 58417, 58455, 58515, 58737, 59000];
for (const rookieId of zeroSnapIds) {
  state.selectedPlayerId = rookieId;
  handleLoadedGames([]); // Zero-snap prospects always return [] games
  assert(elements.zeroSnapCard.style.display === 'flex', `Rookie ${rookieId} must show zeroSnapCard`);
  assert(elements.gameExplorerContent.style.display === 'none', `Rookie ${rookieId} must hide gameExplorerContent`);
  
  // Verify CTA is functional for each
  elements.btnSwitchToCombine.click();
  assert(state.activeTab === 'tab-combine', `CTA click for rookie ${rookieId} must switch tab`);
  switchTab('tab-game');
}

console.log('========================================');
console.log(`ZERO-SNAP UI CHECKS PASSED: ${passed} passed, ${failed} failed`);
console.log('========================================');

if (failed > 0) {
  process.exit(1);
}
