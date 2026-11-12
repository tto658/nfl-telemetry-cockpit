/**
 * telemetry_cockpit.js — Telemetry Cockpit & Cross-Tab Mission Control
 * Encapsulates G-G Friction Circle Canvas integration, Biomechanical Archetype Scout Verdict,
 * Cross-Tab Spatial Bridges, and Lane 3 Telemetry Mode Switching.
 */

import { GGDiagramCanvas } from './gg_diagram.js';

/**
 * Scout Verdict & Biomechanical Archetype Manager
 */
export async function updateBioArchetypeBadge(nflId, summary, combine) {
  const badge = document.getElementById('bioArchetypeBadge');
  if (!badge) return;

  // Set loading state
  badge.textContent = 'ANALYZING...';
  badge.className = 'badge badge-archetype loading';

  try {
    const res = await fetch(`/api/player/${nflId}/dynamics`);
    if (res.ok) {
      const data = await res.json();
      const rawVerdict = data.archetype || data.scout_verdict || data.verdict || data.biomechanical_archetype;
      if (rawVerdict) {
        const label = typeof rawVerdict === 'object' ? (rawVerdict.label || rawVerdict.code || 'BALANCED MOVER') : String(rawVerdict);
        const rationale = typeof rawVerdict === 'object' ? (rawVerdict.rationale || label) : label;
        badge.textContent = label.toUpperCase();
        badge.className = 'badge badge-archetype';
        badge.title = `Biomechanical Scout Verdict: ${rationale} (Peak G: ${data.peak_g_comb ?? '--'}g | Overlap: ${data.mean_overlap_pct ?? '--'}%)`;
        return;
      }
    }
  } catch (err) {
    // Graceful fallback to client-side heuristics below
  }

  // Client-side fallback based on physical testing & kinematics metrics
  const archetype = computeFallbackArchetype(summary, combine);
  badge.textContent = archetype.toUpperCase();
  badge.className = 'badge badge-archetype';
  badge.title = `Scout Verdict (Kinematics Benchmark): ${archetype}`;
}

/**
 * Heuristic Biomechanical Archetype Classifier
 */
function computeFallbackArchetype(summary, combine) {
  const pos = (summary?.nfl_position || summary?.bio?.nfl_position || '').toUpperCase();
  const forty = combine?.forty_yard_dash ?? combine?.forty ?? null;
  const threeCone = combine?.three_cone_drill ?? combine?.three_cone ?? null;
  const athleticism = combine?.athleticism_score ?? combine?.ngs_athleticism_score ?? null;
  const weight = summary?.bio?.weight_lbs || summary?.weight || 0;

  if (forty && forty <= 4.38) {
    return 'Hyper-Elastic Sprinter';
  }
  if (threeCone && threeCone <= 6.85) {
    return 'Apex Trail-Cutter';
  }
  if (athleticism && athleticism >= 88) {
    return 'Dynamic Kinetic Driver';
  }
  if (weight >= 290) {
    return 'High-Inertia Trench Anchor';
  }
  if (['CB', 'WR', 'FS', 'SS'].includes(pos)) {
    return 'High-Traction Shift Apex';
  }
  if (['RB', 'LB', 'TE'].includes(pos)) {
    return 'Multi-Axis Torque Engine';
  }
  return 'Curvilinear Kinematic';
}

/**
 * Quick Bridge Bar Updater
 */
export function updateNavBridgeBar(player, summary) {
  const nameEl = document.getElementById('navBridgeProspectName');
  const metaEl = document.getElementById('navBridgeProspectMeta');
  if (!nameEl || !metaEl) return;

  if (!player && !summary) {
    nameEl.textContent = '--';
    metaEl.textContent = '--';
    return;
  }

  const name = player?.display_name || summary?.display_name || '--';
  const pos = player?.nfl_position || summary?.nfl_position || summary?.bio?.nfl_position || 'ATH';
  const pick = summary?.bio?.draft_pick_formatted || summary?.draft_pick_formatted || 'UDFA';

  nameEl.textContent = name;
  metaEl.textContent = `${pos} • ${pick}`;
}

/**
 * G-G Diagram Cockpit Manager
 */
export class CockpitGGController {
  constructor() {
    this.combineGG = null;
    this.gameGG = null;
    this.currentNflId = null;
    this.combinePillsWired = false;
    this.gamePillsWired = false;
  }

  setCurrentPlayerId(nflId) {
    this.currentNflId = nflId;
  }

  async fetchPlayerCloud(nflId, scope = 'season') {
    if (!nflId) return null;
    try {
      const res = await fetch(`/api/player/${nflId}/gg-kde?scope=${scope}`);
      if (!res.ok) {
        console.warn(`Failed to fetch gg-kde for ${nflId}:`, res.status);
        return null;
      }
      return await res.json();
    } catch (err) {
      console.warn(`Network error fetching gg-kde for ${nflId}:`, err);
      return null;
    }
  }

  initCombineGG(canvasEl) {
    if (!canvasEl) return null;
    if (!this.combineGG && typeof GGDiagramCanvas === 'function') {
      try {
        this.combineGG = new GGDiagramCanvas(canvasEl);
      } catch (err) {
        console.warn('GGDiagramCanvas init error for combine:', err);
      }
    }
    this.initCombinePills();
    return this.combineGG;
  }

  initCombinePills() {
    if (this.combinePillsWired || typeof document === 'undefined') return;
    const modePills = document.querySelectorAll('#combineGGModeGroup .gg-pill');
    modePills.forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-mode');
        modePills.forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        if (this.combineGG && typeof this.combineGG.setDisplayMode === 'function') {
          this.combineGG.setDisplayMode(mode);
        }
      });
    });

    const scopePills = document.querySelectorAll('#combineGGScopeGroup .gg-pill');
    scopePills.forEach((btn) => {
      btn.addEventListener('click', async () => {
        const scope = btn.getAttribute('data-scope');
        scopePills.forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        if (!this.combineGG) return;
        if (scope === 'season' && this.currentNflId) {
          const cloud = await this.fetchPlayerCloud(this.currentNflId, 'combine');
          if (cloud && typeof this.combineGG.setBinaryCloud === 'function') {
            this.combineGG.setBinaryCloud(cloud);
            this.updateCombineDiagnostics(this.combineGG.getDiagnostics());
          }
        } else if (typeof this.combineGG.setCloudScope === 'function') {
          this.combineGG.setCloudScope('play');
          this.updateCombineDiagnostics(this.combineGG.getDiagnostics());
        }
      });
    });
    this.combinePillsWired = true;
  }

  updateCombineData(playerFrames, metrics) {
    if (this.combineGG && typeof this.combineGG.setFrames === 'function') {
      this.combineGG.setFrames(playerFrames, metrics);
      this.updateCombineDiagnostics(this.combineGG.getDiagnostics());
    }
    // Update summary stat indicators if available
    const gCombEl = document.getElementById('combineGGGComb');
    const overlapEl = document.getElementById('combineGGOverlap');
    const apexEl = document.getElementById('combineGGApex');

    if (gCombEl) {
      const g = metrics?.max_g_comb ?? metrics?.drillGCombMax ?? metrics?.g_comb_max ?? 0;
      gCombEl.textContent = typeof g === 'number' && g > 0 ? `${g.toFixed(2)} g` : '-- g';
    }
    if (overlapEl) {
      const ov = metrics?.overlap_index ?? metrics?.drillOverlapIndex ?? 0;
      overlapEl.textContent = typeof ov === 'number' && ov > 0 ? `${ov.toFixed(1)}%` : '-- %';
    }
    if (apexEl) {
      const v = metrics?.apex_speed ?? metrics?.drillApexSpeed ?? 0;
      apexEl.textContent = typeof v === 'number' && v > 0 ? `${v.toFixed(1)} yd/s` : '-- yd/s';
    }
  }

  updateCombineDiagnostics(diag) {
    if (!diag || typeof document === 'undefined') return;
    const sustEl = document.getElementById('combineGGSustained');
    const impulseEl = document.getElementById('combineGGImpulse');
    const coastEl = document.getElementById('combineGGCoasting');

    if (sustEl) {
      sustEl.textContent = diag.gSustained > 0 ? `${diag.gSustained.toFixed(2)} g` : '-- g';
    }
    if (impulseEl) {
      impulseEl.textContent = diag.impulseCouplingMs > 0 ? `${diag.impulseCouplingMs} ms` : '-- ms';
    }
    if (coastEl) {
      coastEl.textContent = `${diag.coastingPct.toFixed(1)}%`;
    }
  }

  setCombineFrame(frameIdx) {
    if (this.combineGG && typeof this.combineGG.setFrame === 'function') {
      this.combineGG.setFrame(frameIdx);
    }
  }

  initGameGG(canvasEl) {
    if (!canvasEl) return null;
    if (!this.gameGG && typeof GGDiagramCanvas === 'function') {
      try {
        this.gameGG = new GGDiagramCanvas(canvasEl);
      } catch (err) {
        console.warn('GGDiagramCanvas init error for game:', err);
      }
    }
    this.initGamePills();
    return this.gameGG;
  }

  initGamePills() {
    if (this.gamePillsWired || typeof document === 'undefined') return;
    const modePills = document.querySelectorAll('#gameGGModeGroup .gg-pill');
    modePills.forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-mode');
        modePills.forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        if (this.gameGG && typeof this.gameGG.setDisplayMode === 'function') {
          this.gameGG.setDisplayMode(mode);
        }
      });
    });

    const scopePills = document.querySelectorAll('#gameGGScopeGroup .gg-pill');
    scopePills.forEach((btn) => {
      btn.addEventListener('click', async () => {
        const scope = btn.getAttribute('data-scope');
        scopePills.forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        if (!this.gameGG) return;
        if (scope === 'season' && this.currentNflId) {
          const cloud = await this.fetchPlayerCloud(this.currentNflId, 'season');
          if (cloud && typeof this.gameGG.setBinaryCloud === 'function') {
            this.gameGG.setBinaryCloud(cloud);
            this.updateGameDiagnostics(this.gameGG.getDiagnostics());
          }
        } else if (typeof this.gameGG.setCloudScope === 'function') {
          this.gameGG.setCloudScope('play');
          this.updateGameDiagnostics(this.gameGG.getDiagnostics());
        }
      });
    });
    this.gamePillsWired = true;
  }

  updateGameData(frames, snapData) {
    if (this.gameGG && typeof this.gameGG.setFrames === 'function') {
      this.gameGG.setFrames(frames, snapData);
      this.updateGameDiagnostics(this.gameGG.getDiagnostics());
    }
  }

  updateGameDiagnostics(diag) {
    if (!diag || typeof document === 'undefined') return;
    const sustEl = document.getElementById('gameGGSustained');
    const impulseEl = document.getElementById('gameGGImpulse');
    const coastEl = document.getElementById('gameGGCoasting');

    if (sustEl) {
      sustEl.textContent = diag.gSustained > 0 ? `${diag.gSustained.toFixed(2)} / ${diag.gMax.toFixed(2)} g` : '-- g';
    }
    if (impulseEl) {
      impulseEl.textContent = diag.impulseCouplingMs > 0 ? `${diag.impulseCouplingMs} ms` : '-- ms';
    }
    if (coastEl) {
      coastEl.textContent = `${diag.coastingPct.toFixed(1)}%`;
    }
  }

  setGameFrame(frameIdx) {
    if (this.gameGG && typeof this.gameGG.setFrame === 'function') {
      this.gameGG.setFrame(frameIdx);
    }
  }
}

/**
 * Lane 3 Telemetry Mode Toggle
 */
export function setupLane3ModeToggle(getStripCanvas) {
  const btnSideslip = document.getElementById('btnLane3Sideslip');
  const btnGForce = document.getElementById('btnLane3GForce');

  if (!btnSideslip || !btnGForce) return;

  function setMode(mode) {
    if (mode === 'sideslip') {
      btnSideslip.classList.add('active');
      btnGForce.classList.remove('active');
    } else {
      btnGForce.classList.add('active');
      btnSideslip.classList.remove('active');
    }

    const strip = getStripCanvas();
    if (strip && typeof strip.setLane3Mode === 'function') {
      strip.setLane3Mode(mode);
    }
  }

  btnSideslip.addEventListener('click', () => setMode('sideslip'));
  btnGForce.addEventListener('click', () => setMode('g_force'));
}
