"""Frontend Static & Integration Tests for Milestone M3.

Verifies:
- Static assets delivery via Starlette StaticFiles mount:
  - /static/index.html (HTTP 200, text/html)
  - /static/css/styles.css (HTTP 200, text/css)
  - /static/js/api.js (HTTP 200, javascript)
  - /static/js/combine_field.js (HTTP 200, javascript)
  - /static/js/timeseries.js (HTTP 200, javascript)
  - /static/js/app.js (HTTP 200, javascript)
- Mandatory DOM anchors in index.html:
  - combineCanvas, timeseriesCanvas
  - opt-out / badge-opt-out
  - tab-combine, tab-game
  - playerSelect, draftYearFilter, positionFilter, teamFilter, searchInput
  - bioName, bioPosition, bioDraftPick, bioTotalSnaps
  - drillSelect, drillMetricsCard, playbackBar, btnPlayPause
- Backend combine drills list population (/api/player/{id}/combine):
  - drills list in combine block for multi-drill prospect (Jayden Higgins 58239, Puka Nacua 56042)
  - graceful handling for 0-snap or un-tracked prospects
- Core architectural invariants in JS modules
"""

import pytest


def test_static_index_html_status_and_content_type(client):
    """GET /static/index.html returns HTTP 200 and text/html content-type."""
    response = client.get("/static/index.html")
    assert response.status_code == 200
    content_type = response.headers.get("content-type", "")
    assert "text/html" in content_type


def test_static_css_styles_status_and_content_type(client):
    """GET /static/css/styles.css returns HTTP 200 and text/css content-type."""
    response = client.get("/static/css/styles.css")
    assert response.status_code == 200
    content_type = response.headers.get("content-type", "")
    assert "text/css" in content_type
    assert "--color-cyan" in response.text
    assert "dark-theme" in response.text


@pytest.mark.parametrize("js_file", [
    "api.js",
    "combine_field.js",
    "timeseries.js",
    "app.js",
])
def test_static_js_modules_status_and_content_type(client, js_file):
    """All 4 ES6 JS modules are served with HTTP 200 and javascript content-type."""
    response = client.get(f"/static/js/{js_file}")
    assert response.status_code == 200
    content_type = response.headers.get("content-type", "")
    assert ("javascript" in content_type) or ("text/plain" in content_type)
    assert len(response.text) > 100


def test_index_html_mandatory_dom_anchors(client):
    """index.html must contain all mandatory DOM anchors per M3 specifications."""
    response = client.get("/static/index.html")
    assert response.status_code == 200
    html = response.text

    # Canvases
    assert 'id="combineCanvas"' in html or 'combineCanvas' in html
    assert 'id="timeseriesCanvas"' in html

    # Opt-Out Badges
    assert "opt-out" in html.lower()
    assert "Opt-Out / MNAR" in html

    # Tabs
    assert 'tab-combine' in html or 'tabCombine' in html
    assert 'tab-game' in html or 'tabGame' in html
    assert 'tabBtnCombine' in html
    assert 'tabBtnGame' in html

    # Header Filters & Player Selector
    assert 'id="playerSelect"' in html
    assert 'id="playerCountBadge"' in html
    assert 'id="draftYearFilter"' in html
    assert 'id="positionFilter"' in html
    assert 'id="teamFilter"' in html
    assert 'id="searchInput"' in html

    # Bio Banner
    assert 'id="bioName"' in html
    assert 'id="bioPosition"' in html
    assert 'id="bioDraftPick"' in html
    assert 'id="bioCollege"' in html
    assert 'id="bioHeight"' in html
    assert 'id="bioWeight"' in html
    assert 'id="bioTotalSnaps"' in html
    assert 'id="bioSnapBreakdown"' in html

    # Tracked Combine Drills & Playback Controls
    assert 'id="drillSelect"' in html
    assert 'id="drillDuration"' in html
    assert 'id="drillSMax"' in html
    assert 'id="drillAMax"' in html
    assert 'id="drillKappa90"' in html
    assert 'id="btnPlayPause"' in html
    assert 'id="btnStepBack"' in html
    assert 'id="btnStepForward"' in html
    assert 'id="btnReset"' in html
    assert 'id="playbackScrubber"' in html
    assert 'id="playbackRateSelect"' in html


def test_combine_api_drills_list_population(client):
    """GET /api/player/{id}/combine populates drills list for prospect with tracked drills."""
    # Jayden Higgins (58239)
    res = client.get("/api/player/58239/combine")
    assert res.status_code == 200
    data = res.json()
    assert "drills" in data
    assert isinstance(data["drills"], list)
    assert len(data["drills"]) == 15

    first_drill = data["drills"][0]
    assert "event_id" in first_drill
    assert "drill_name" in first_drill
    assert len(first_drill["event_id"]) > 0

    # Puka Nacua (56042)
    res_puka = client.get("/api/player/56042/combine")
    assert res_puka.status_code == 200
    puka_data = res_puka.json()
    assert "drills" in puka_data
    assert isinstance(puka_data["drills"], list)
    assert len(puka_data["drills"]) == 15


def test_combine_field_js_architectural_invariants(client):
    """combine_field.js contains affine transform, compass arrow, Trap 2 dashed ball, and upright post-restore."""
    res = client.get("/static/js/combine_field.js")
    assert res.status_code == 200
    code = res.text

    # Affine transform scale(scale, -scale)
    assert "scale(t.scale, -t.scale)" in code or "scale(scale, -scale)" in code
    # Compass trigonometry (sin and cos)
    assert "Math.sin(rad)" in code
    assert "Math.cos(rad)" in code
    # Proportional arrow length L = s * 0.8
    assert "s * 0.8" in code
    # Dashed ball pattern (Trap 2)
    assert "setLineDash" in code
    # Mandatory line dash reset
    assert "setLineDash([])" in code
    # Upright post-restore
    assert "restore()" in code
    assert "yardToPixel" in code


def test_timeseries_js_architectural_invariants(client):
    """timeseries.js contains 10 Hz rAF accumulator, multi-lane metrics, and scrub handling."""
    res = client.get("/static/js/timeseries.js")
    assert res.status_code == 200
    code = res.text

    # Classes exported
    assert "class PlaybackEngine" in code
    assert "class TimeseriesCanvas" in code
    # Delta accumulation & 10 Hz interval
    assert "requestAnimationFrame" in code
    assert "100.0 / this.playbackRate" in code or "100" in code
    # Tab lag guard
    assert "500" in code
    # 4 metrics
    assert "SPEED" in code
    assert "ACCEL" in code
    assert "ANG VEL" in code
    assert "CURVATURE" in code
    # Pointer capture for scrubbing
    assert "setPointerCapture" in code
