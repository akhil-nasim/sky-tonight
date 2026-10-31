/* Sky Tonight — planets (Visible Planets API), Moon (Astronomy Engine),
   ISS passes (TLE API + satellite.js). */

const PLANETS = ["Mercury", "Venus", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune"];
const BODIES = ["Sun", "Moon", ...PLANETS];
const COLORS = {
  Moon: "#f4f1e6", Mercury: "#c2b3a3", Venus: "#f6e3b0", Mars: "#e8774f",
  Jupiter: "#e9c89c", Saturn: "#e8d29a", Uranus: "#9fe3e6", Neptune: "#7d97ff",
};
const DARK = -6;        // sun altitude below which the sky is dark enough (end of civil twilight)
const MIN_ALT = 5;      // object must clear the horizon haze by this much
const STORE_KEY = "skyTonight.location";

const $ = (id) => document.getElementById(id);
const state = { loc: null, obs: null, samples: [], night: null };

/* ---------- formatting helpers ---------- */

const fmtTime = (d) => d ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: state.loc.tz }).format(d) : "—";
const fmtDay = (d) => new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: state.loc.tz }).format(d);
const fmtDayTime = (d) => `${fmtDay(d)}, ${fmtTime(d)}`;
const compass = (az) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(((az % 360) + 360) % 360 / 45) % 8];
const compassLong = (az) => ({ N: "north", NE: "northeast", E: "east", SE: "southeast", S: "south", SW: "southwest", W: "west", NW: "northwest" })[compass(az)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function brightnessLabel(mag) {
  if (mag < -3) return "Dazzling";
  if (mag < -1) return "Very bright";
  if (mag < 1) return "Bright";
  if (mag < 4) return "Naked eye";
  if (mag < 6.5) return "Binoculars";
  return "Telescope";
}

function setStatus(msg, isError = false) {
  const el = $("status");
  el.textContent = msg;
  el.classList.toggle("error", isError);
}

/* ---------- astronomy (local) ---------- */

function horizonOf(body, date) {
  const eq = Astronomy.Equator(body, date, state.obs, true, true);
  const hor = Astronomy.Horizon(date, state.obs, eq.ra, eq.dec, "normal");
  return { eq, alt: hor.altitude, az: hor.azimuth };
}

const sunAlt = (date) => horizonOf("Sun", date).alt;

// Tonight = the current night if the Sun is already down, otherwise the next one.
function findNight(now) {
  const obs = state.obs;
  let start;
  if (sunAlt(now) < -0.833) {
    const prevSet = Astronomy.SearchRiseSet("Sun", obs, -1, new Date(now - 20 * 3600e3), 1);
    start = prevSet && prevSet.date < now ? prevSet.date : now;
  } else {
    const nextSet = Astronomy.SearchRiseSet("Sun", obs, -1, now, 1);
    start = nextSet ? nextSet.date : null;
  }
  if (!start) return null; // polar day: no sunset in the next 24h
  const rise = Astronomy.SearchRiseSet("Sun", obs, +1, start, 1);
  const end = rise ? rise.date : new Date(+start + 24 * 3600e3);
  const find = (dir, alt, from) => { const t = Astronomy.SearchAltitude("Sun", obs, dir, from, 1, alt); return t && t.date < end ? t.date : null; };
  return {
    sunset: start, sunrise: rise ? rise.date : null, end,
    darkStart: find(-1, -18, start), darkEnd: find(+1, -18, start),
    civilDusk: find(-1, DARK, start),
  };
}

// Same shape as an API sample, computed on-device. Used if the API is unreachable.
function localSample(date) {
  const bodies = {};
  for (const name of BODIES) {
    const h = horizonOf(name, date);
    bodies[name] = {
      alt: h.alt, az: h.az,
      mag: Astronomy.Illumination(name, date).mag,
      con: Astronomy.Constellation(h.eq.ra, h.eq.dec).name,
    };
  }
  return { time: date, sunAlt: bodies.Sun.alt, bodies, source: "local" };
}

/* ---------- Visible Planets API ---------- */

async function apiSample(date) {
  const { lat, lon } = state.loc;
  const url = `https://api.visibleplanets.dev/v3?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&time=${date.toISOString()}&aboveHorizon=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Visible Planets API ${res.status}`);
  const json = await res.json();
  const bodies = {};
  for (const o of json.data) {
    if (!BODIES.includes(o.name)) continue;
    bodies[o.name] = { alt: o.altitude, az: o.azimuth, mag: o.magnitude, con: o.constellation };
  }
  if (!bodies.Sun) throw new Error("Unexpected API response");
  return { time: date, sunAlt: bodies.Sun.alt, bodies, source: "api" };
}

async function loadSamples(night) {
  // Hourly samples across the night (stretched if the night is very long).
  const span = night.end - night.sunset;
  const n = Math.min(18, Math.max(6, Math.ceil(span / 3600e3) + 1));
  const times = Array.from({ length: n }, (_, i) => new Date(+night.sunset + (span * i) / (n - 1)));
  // Small concurrency limit to be polite to a free API.
  const out = new Array(n);
  let next = 0;
  async function worker() {
    while (next < n) {
      const i = next++;
      try { out[i] = await apiSample(times[i]); }
      catch { out[i] = localSample(times[i]); }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  return out;
}

/* ---------- Planets ---------- */

function analyzeBody(name, samples) {
  const dark = samples.filter((s) => s.sunAlt < DARK && s.bodies[name].alt > MIN_ALT);
  const all = samples.map((s) => s.bodies[name]);
  const maxAltNight = Math.max(...samples.filter((s) => s.sunAlt < DARK).map((s) => s.bodies[name].alt), -90);
  if (!dark.length) {
    let reason = "Stays below the horizon while the sky is dark.";
    if (name === "Mercury" || name === "Venus") reason = "Too close to the Sun to see tonight.";
    else if (maxAltNight > -15 && maxAltNight <= MIN_ALT) reason = "Only skims the horizon tonight.";
    return { name, visible: false, reason, all };
  }
  const best = dark.reduce((a, b) => (b.bodies[name].alt > a.bodies[name].alt ? b : a));
  const b = best.bodies[name];
  const from = dark[0].time, to = dark[dark.length - 1].time;
  const whole = dark.length === samples.filter((s) => s.sunAlt < DARK).length;
  return {
    name, visible: true, all, best, from, to, whole,
    alt: b.alt, az: b.az, mag: b.mag, con: b.con,
  };
}

function sparkline(name, samples) {
  const W = 300, H = 56, pad = 2;
  const x = (i) => pad + (i / (samples.length - 1)) * (W - pad * 2);
  const y = (alt) => H / 2 - (Math.max(-90, Math.min(90, alt)) / 90) * (H / 2 - pad);
  const pts = samples.map((s, i) => `${x(i).toFixed(1)},${y(s.bodies[name].alt).toFixed(1)}`);
  // Shade the fully dark part of the night.
  const darkIdx = samples.map((s, i) => (s.sunAlt < DARK ? i : -1)).filter((i) => i >= 0);
  const shade = darkIdx.length ? `<rect x="${x(darkIdx[0])}" y="0" width="${x(darkIdx[darkIdx.length - 1]) - x(darkIdx[0])}" height="${H}" fill="rgba(143,180,255,0.07)"/>` : "";
  const color = COLORS[name];
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${name} altitude through the night">
    ${shade}
    <line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" stroke="rgba(255,255,255,0.18)" stroke-dasharray="3 4" vector-effect="non-scaling-stroke"/>
    <polygon points="${x(0)},${H / 2} ${pts.join(" ")} ${x(samples.length - 1)},${H / 2}" fill="${color}" opacity="0.12"/>
    <polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
  </svg>
  <div class="muted small" style="display:flex;justify-content:space-between"><span>Sunset ${fmtTime(samples[0].time)}</span><span>Horizon ┄</span><span>Sunrise ${fmtTime(samples[samples.length - 1].time)}</span></div>`;
}

function renderPlanets(samples) {
  const results = PLANETS.map((p) => analyzeBody(p, samples));
  results.sort((a, b) => (b.visible - a.visible) || (a.visible ? a.mag - b.mag : 0));
  $("planets").innerHTML = results.map((r) => {
    const info = WHY[r.name];
    const dot = `<span class="planet-dot" style="background:radial-gradient(circle at 35% 35%, #fff8, ${COLORS[r.name]} 45%, #0006 100%);--glow:${COLORS[r.name]}55"></span>`;
    const badge = r.visible ? `<span class="badge up">Visible</span>` : `<span class="badge down">Not tonight</span>`;
    let body;
    if (r.visible) {
      const when = r.whole ? "all night" : `${fmtTime(r.from)} – ${fmtTime(r.to)}`;
      body = `
        <p class="summary-line">Best around <strong>${fmtTime(r.best.time)}</strong>, ${Math.round(r.alt)}° up in the <strong>${compassLong(r.az)}</strong>, in ${esc(r.con)}.</p>
        <div class="facts">
          <div class="stat"><span class="label">Visible</span><span class="value">${when}</span></div>
          <div class="stat"><span class="label">Highest</span><span class="value">${Math.round(r.alt)}° ${compass(r.az)}</span></div>
          <div class="stat"><span class="label">Brightness</span><span class="value" title="Magnitude ${r.mag.toFixed(1)}">${brightnessLabel(r.mag)}</span></div>
        </div>`;
    } else {
      body = `<p class="summary-line muted">${r.reason}</p>`;
    }
    return `<article class="card planet ${r.visible ? "" : "hidden-tonight"}">
      <div class="planet-head">${dot}<div><h3>${r.name}</h3><div class="tagline">${info.tagline}</div></div>${badge}</div>
      ${body}
      <div class="spark">${sparkline(r.name, samples)}</div>
      <p class="why"><strong>Why this matters.</strong> ${info.why}</p>
    </article>`;
  }).join("");

  const api = samples.filter((s) => s.source === "api").length;
  $("planetSource").textContent = api === samples.length
    ? `Positions from Visible Planets API · ${samples.length} samples through the night`
    : api ? `Partly computed on-device (API returned ${api}/${samples.length})` : "API unreachable, so positions were computed on-device";
}

/* ---------- Moon ---------- */

function moonPhaseName(deg) {
  if (deg < 6 || deg >= 354) return "New Moon";
  if (deg < 84) return "Waxing Crescent";
  if (deg < 96) return "First Quarter";
  if (deg < 174) return "Waxing Gibbous";
  if (deg < 186) return "Full Moon";
  if (deg < 264) return "Waning Gibbous";
  if (deg < 276) return "Last Quarter";
  return "Waning Crescent";
}

function moonSVG(phaseDeg, frac, southern) {
  const R = 60;
  const waxing = phaseDeg < 180;
  const rx = Math.abs(1 - 2 * frac) * R;
  const outer = waxing ? 1 : 0;
  const inner = (frac < 0.5) === waxing ? 0 : 1;
  const lit = `M 0 ${-R} A ${R} ${R} 0 0 ${outer} 0 ${R} A ${rx} ${R} 0 0 ${inner} 0 ${-R} Z`;
  return `<svg width="140" height="140" viewBox="-70 -70 140 140" role="img" aria-label="Moon ${Math.round(frac * 100)}% illuminated">
    <defs>
      <radialGradient id="moonLit" cx="40%" cy="38%" r="70%"><stop offset="0" stop-color="#fffbea"/><stop offset="1" stop-color="#d9d3bd"/></radialGradient>
    </defs>
    <circle r="${R}" fill="#20253d"/>
    <g transform="${southern ? "scale(-1,1)" : ""}">
      <path d="${lit}" fill="url(#moonLit)"/>
      <g fill="#00000018"><circle cx="-18" cy="-20" r="13"/><circle cx="14" cy="8" r="9"/><circle cx="-8" cy="26" r="7"/><circle cx="26" cy="-24" r="6"/><circle cx="-30" cy="10" r="5"/></g>
    </g>
    <circle r="${R}" fill="none" stroke="#ffffff22"/>
  </svg>`;
}

function renderMoon(samples, now) {
  const obs = state.obs;
  const phase = Astronomy.MoonPhase(now);
  const frac = Astronomy.Illumination("Moon", now).phase_fraction;
  const name = moonPhaseName(phase);
  const rise = Astronomy.SearchRiseSet("Moon", obs, +1, now, 2);
  const set = Astronomy.SearchRiseSet("Moon", obs, -1, now, 2);

  // Next full and new moon.
  let q = Astronomy.SearchMoonQuarter(now), nextFull = null, nextNew = null;
  for (let i = 0; i < 5 && (!nextFull || !nextNew); i++) {
    if (q.quarter === 2 && !nextFull) nextFull = q.time.date;
    if (q.quarter === 0 && !nextNew) nextNew = q.time.date;
    q = Astronomy.NextMoonQuarter(q);
  }

  const m = analyzeBody("Moon", samples);
  const upLine = m.visible
    ? `Up in the dark sky ${m.whole ? "all night" : `${fmtTime(m.from)} – ${fmtTime(m.to)}`}, highest around ${fmtTime(m.best.time)} in the ${compassLong(m.az)} (${esc(m.con)}).`
    : "Not above the horizon while the sky is dark tonight.";

  $("moonCard").innerHTML = `
    <div class="card-head"><h3>The Moon</h3><span class="muted small">${WHY.Moon.tagline}</span></div>
    <div class="moon-body">
      ${moonSVG(phase, frac, state.loc.lat < 0)}
      <div class="moon-stats">
        <div class="stat"><span class="label">Phase</span><span class="value">${name}</span></div>
        <div class="stat"><span class="label">Illuminated</span><span class="value">${Math.round(frac * 100)}%</span></div>
        <div class="stat"><span class="label">Next moonrise</span><span class="value">${rise ? fmtDayTime(rise.date) : "—"}</span></div>
        <div class="stat"><span class="label">Next moonset</span><span class="value">${set ? fmtDayTime(set.date) : "—"}</span></div>
        <div class="stat"><span class="label">Full moon</span><span class="value">${nextFull ? fmtDay(nextFull) : "—"}</span></div>
        <div class="stat"><span class="label">New moon</span><span class="value">${nextNew ? fmtDay(nextNew) : "—"}</span></div>
      </div>
    </div>
    <p class="summary-line" style="margin:14px 0 0">${upLine}</p>
    <p class="tip">${MOON_TIPS[name]}</p>
    <p class="why"><strong>Why this matters.</strong> ${WHY.Moon.why}</p>`;
}

/* ---------- Sky chart (polar plot, zenith at centre) ---------- */

// Looking up with north at the top, east is on the left.
function polar(alt, az, R) {
  const r = ((90 - alt) / 90) * R;
  const a = (az * Math.PI) / 180;
  return [-r * Math.sin(a), -r * Math.cos(a)];
}

function polarFrame(R, sunAltDeg) {
  const t = Math.max(0, Math.min(1, (sunAltDeg + 18) / 18)); // 0 = full dark, 1 = sunset
  const sky = `rgb(${Math.round(8 + 30 * t)},${Math.round(12 + 40 * t)},${Math.round(32 + 70 * t)})`;
  const rings = [30, 60].map((alt) => `<circle r="${((90 - alt) / 90) * R}" fill="none" stroke="#ffffff1a" stroke-dasharray="2 4"/>`).join("");
  const labels = [["N", 0], ["E", 90], ["S", 180], ["W", 270]].map(([l, az]) => {
    const [x, y] = polar(-9, az, R);
    return `<text x="${x}" y="${y}" fill="#98a2c8" font-size="${R * 0.09}" text-anchor="middle" dominant-baseline="central" font-family="Inter">${l}</text>`;
  }).join("");
  return `<circle r="${R}" fill="${sky}" stroke="#ffffff33"/>${rings}
    <line x1="${-R}" x2="${R}" y1="0" y2="0" stroke="#ffffff10"/><line y1="${-R}" y2="${R}" x1="0" x2="0" stroke="#ffffff10"/>${labels}`;
}

function renderSkyChart(i) {
  const s = state.samples[i];
  const R = 160;
  const placed = [];
  const objs = ["Moon", ...PLANETS].map((name) => ({ name, ...s.bodies[name] }))
    .filter((o) => o.alt > 0)
    .map((o) => {
      const [x, y] = polar(o.alt, o.az, R);
      const size = o.name === "Moon" ? 10 : Math.max(3, 7 - o.mag * 0.9);
      // Nudge labels down so neighbours (e.g. Saturn and Neptune) don't overlap.
      let ly = y + size + 12;
      while (placed.some((p) => Math.abs(p.x - x) < 46 && Math.abs(p.y - ly) < 12)) ly += 12;
      placed.push({ x, y: ly });
      return `<g><circle cx="${x}" cy="${y}" r="${size + 6}" fill="${COLORS[o.name]}" opacity="0.15"/>
        <circle cx="${x}" cy="${y}" r="${Math.min(size, 9)}" fill="${COLORS[o.name]}"/>
        <text x="${x}" y="${ly}" fill="#e8ecff" font-size="11" text-anchor="middle" font-family="Inter">${o.name}</text></g>`;
    }).join("");
  const sunNote = s.sunAlt > -0.8 ? "Sun up" : s.sunAlt > DARK ? "Twilight" : s.sunAlt > -18 ? "Getting dark" : "Fully dark";
  $("skyChart").innerHTML = `<svg viewBox="${-R - 24} ${-R - 24} ${2 * R + 48} ${2 * R + 48}" role="img" aria-label="Sky map at ${fmtTime(s.time)}">
    ${polarFrame(R, s.sunAlt)}${objs || `<text y="0" fill="#98a2c8" font-size="13" text-anchor="middle" font-family="Inter">Nothing bright above the horizon</text>`}
  </svg>`;
  $("chartTime").textContent = `${fmtDayTime(s.time)} · ${sunNote}`;
}

function setupSlider(samples, now) {
  const slider = $("timeSlider");
  slider.max = samples.length - 1;
  // Start at "now" if we're inside the night, else the first fully dark sample.
  let idx = samples.findIndex((s) => s.time >= now);
  if (idx <= 0) idx = Math.max(0, samples.findIndex((s) => s.sunAlt < DARK));
  slider.value = idx;
  slider.oninput = () => renderSkyChart(+slider.value);
  renderSkyChart(idx);
}

/* ---------- ISS ---------- */

async function fetchTLE() {
  try {
    const r = await fetch("https://tle.ivanstanojevic.me/api/tle/25544");
    if (!r.ok) throw new Error(r.status);
    const j = await r.json();
    return [j.line1, j.line2];
  } catch {
    const r = await fetch("https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=TLE");
    const lines = (await r.text()).trim().split(/\r?\n/);
    return [lines[1], lines[2]];
  }
}

// Cylindrical shadow model: is the satellite lit by the Sun?
function sunlit(posKm, date) {
  const s = Astronomy.GeoVector("Sun", date, false);
  const n = Math.hypot(s.x, s.y, s.z);
  const u = [s.x / n, s.y / n, s.z / n];
  const dot = posKm.x * u[0] + posKm.y * u[1] + posKm.z * u[2];
  if (dot > 0) return true;
  const perp = Math.hypot(posKm.x - dot * u[0], posKm.y - dot * u[1], posKm.z - dot * u[2]);
  return perp > 6371;
}

function computePasses(satrec, start, hours) {
  const gd = { latitude: satellite.degreesToRadians(state.loc.lat), longitude: satellite.degreesToRadians(state.loc.lon), height: 0.05 };
  const passes = [];
  let cur = null;
  const step = 10e3;
  for (let t = +start; t < +start + hours * 3600e3; t += step) {
    const date = new Date(t);
    const pv = satellite.propagate(satrec, date);
    if (!pv.position) continue;
    const look = satellite.ecfToLookAngles(gd, satellite.eciToEcf(pv.position, satellite.gstime(date)));
    const el = satellite.radiansToDegrees(look.elevation);
    const az = (satellite.radiansToDegrees(look.azimuth) + 360) % 360;
    if (el > 0) {
      if (!cur) cur = { pts: [] };
      const vis = el > 10 && sunlit(pv.position, date) && sunAlt(date) < DARK;
      cur.pts.push({ date, el, az, vis });
    } else if (cur) {
      passes.push(cur);
      cur = null;
    }
  }
  if (cur) passes.push(cur);
  return passes
    .map((p) => {
      const max = p.pts.reduce((a, b) => (b.el > a.el ? b : a));
      const vis = p.pts.filter((x) => x.vis);
      const visMax = vis.length ? vis.reduce((a, b) => (b.el > a.el ? b : a)) : null;
      // At least a minute in view to count as a sighting.
      return { ...p, start: p.pts[0], end: p.pts[p.pts.length - 1], max, visible: vis.length >= 6, visStart: vis[0], visEnd: vis[vis.length - 1], visMax };
    })
    .filter((p) => p.max.el >= 10);
}

function passSVG(p) {
  const R = 46;
  const pts = p.pts.map((x) => polar(x.el, x.az, R).map((v) => v.toFixed(1)).join(",")).join(" ");
  const visPts = p.pts.filter((x) => x.vis).map((x) => polar(x.el, x.az, R).map((v) => v.toFixed(1)).join(",")).join(" ");
  const [ex, ey] = polar(p.end.el, p.end.az, R);
  return `<svg viewBox="-55 -55 110 110" aria-hidden="true">
    <circle r="${R}" fill="#0a0f24" stroke="#ffffff33"/>
    <circle r="${R * 2 / 3}" fill="none" stroke="#ffffff14" stroke-dasharray="2 3"/><circle r="${R / 3}" fill="none" stroke="#ffffff14" stroke-dasharray="2 3"/>
    ${[["N", 0], ["E", 90], ["S", 180], ["W", 270]].map(([l, az]) => { const [x, y] = polar(-14, az, R); return `<text x="${x}" y="${y}" fill="#98a2c8" font-size="8" text-anchor="middle" dominant-baseline="central">${l}</text>`; }).join("")}
    <polyline points="${pts}" fill="none" stroke="#5d6690" stroke-width="1.5" stroke-dasharray="3 3"/>
    ${visPts ? `<polyline points="${visPts}" fill="none" stroke="#ffd27a" stroke-width="2.5" stroke-linecap="round"/>` : ""}
    <circle cx="${ex}" cy="${ey}" r="2.5" fill="${p.visible ? "#ffd27a" : "#5d6690"}"/>
  </svg>`;
}

function renderPasses(passes) {
  const visible = passes.filter((p) => p.visible);
  const other = passes.filter((p) => !p.visible);
  let html = visible.length
    ? `<div class="passes">${visible.map((p) => {
        const dur = Math.round((p.visEnd.date - p.visStart.date) / 60e3);
        const m = p.visMax;
        const quality = m.el > 50 ? "Excellent: nearly overhead" : m.el > 25 ? "Good" : "Low in the sky";
        // Evening passes usually fade into Earth's shadow; morning ones emerge from it.
        const before = p.pts[p.pts.indexOf(p.visStart) - 1], after = p.pts[p.pts.indexOf(p.visEnd) + 1];
        const begin = !before || before.el <= 10 ? "Appears" : "Emerges from Earth's shadow";
        const finish = !after || after.el <= 10 ? "drops toward the horizon" : "fades into Earth's shadow";
        return `<div class="pass visible">${passSVG(p)}<div>
          <h4>${fmtDay(p.visStart.date)} · ${fmtTime(p.visStart.date)}</h4>
          <div class="route">${begin} in the ${compassLong(p.visStart.az)} (${Math.round(p.visStart.el)}°) → highest ${Math.round(m.el)}° in the ${compassLong(m.az)} → ${finish} in the ${compassLong(p.visEnd.az)}</div>
          <div class="facts"><span><strong>${dur} min</strong> visible</span><span>Highest at ${fmtTime(m.date)}</span><span>${quality}</span></div>
        </div></div>`;
      }).join("")}</div>`
    : `<p class="tip">No visible ISS passes in the next 3 days. The station is above you, but either in daylight or in Earth's shadow. Visible passes come in runs of a week or two, so check back soon.</p>`;
  if (other.length) {
    html += `<details class="pass-list-other"><summary>${other.length} more pass${other.length > 1 ? "es" : ""} you won't see (daylight or shadow)</summary><ul>
      ${other.map((p) => `<li>${fmtDayTime(p.start.date)}, max ${Math.round(p.max.el)}° ${compass(p.max.az)}</li>`).join("")}</ul></details>`;
  }
  $("issPasses").innerHTML = html;
}

let issTimer = null;
function startIssTicker(satrec) {
  clearInterval(issTimer);
  const tick = () => {
    const d = new Date();
    const pv = satellite.propagate(satrec, d);
    if (!pv.position) return;
    const g = satellite.eciToGeodetic(pv.position, satellite.gstime(d));
    const lat = satellite.degreesLat(g.latitude), lon = satellite.degreesLong(g.longitude);
    const v = Math.hypot(pv.velocity.x, pv.velocity.y, pv.velocity.z) * 3600;
    $("issNow").textContent = `Right now: ${Math.abs(lat).toFixed(1)}°${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? "E" : "W"} · ${Math.round(g.height)} km up · ${Math.round(v).toLocaleString()} km/h`;
  };
  tick();
  issTimer = setInterval(tick, 2000);
}

async function loadISS() {
  $("issWhy").textContent = WHY.ISS.why;
  $("issPasses").innerHTML = `<p class="skeleton">Fetching the station's orbit…</p>`;
  try {
    const [l1, l2] = await fetchTLE();
    const satrec = satellite.twoline2satrec(l1, l2);
    startIssTicker(satrec);
    renderPasses(computePasses(satrec, new Date(Date.now() - 10 * 60e3), 72));
  } catch (e) {
    $("issPasses").innerHTML = `<p class="status error">Couldn't load ISS orbit data (${esc(e.message)}).</p>`;
  }
}

/* ---------- Orchestration ---------- */

async function run(loc) {
  state.loc = loc;
  state.obs = new Astronomy.Observer(loc.lat, loc.lon, 0);
  try { localStorage.setItem(STORE_KEY, JSON.stringify(loc)); } catch {}

  $("welcome").hidden = true;
  $("dash").hidden = false;
  const now = new Date();
  $("placeName").textContent = loc.name;
  $("dateLine").textContent = `Tonight, ${new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long", timeZone: loc.tz }).format(now)}`;

  const night = findNight(now);
  if (!night) {
    setStatus("The Sun doesn't set here in the next 24 hours, so there's no night sky to show. Midnight sun!", true);
    return;
  }
  state.night = night;
  $("sunTimes").innerHTML = [
    ["Sunset", night.sunset], ["Dark sky", night.darkStart], ["Dark ends", night.darkEnd], ["Sunrise", night.sunrise],
  ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v ? fmtTime(v) : "—"}</dd></div>`).join("");

  loadISS();
  setStatus("Asking the Visible Planets API where everything will be tonight…");
  $("planets").innerHTML = `<p class="skeleton">Loading planets…</p>`;
  state.samples = await loadSamples(night);
  setStatus("");
  renderMoon(state.samples, now);
  renderPlanets(state.samples);
  setupSlider(state.samples, now);
}

/* ---------- Location ---------- */

const browserTZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

$("geoBtn").addEventListener("click", () => {
  if (!navigator.geolocation) return setStatus("Geolocation isn't available. Search for a city instead.", true);
  $("geoBtn").textContent = "Locating…";
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      $("geoBtn").textContent = "Use my location";
      const { latitude: lat, longitude: lon } = pos.coords;
      run({ lat, lon, tz: browserTZ, name: `Your location · ${lat.toFixed(2)}°, ${lon.toFixed(2)}°` });
    },
    () => {
      $("geoBtn").textContent = "Use my location";
      $("searchInput").focus();
      const msg = "Location permission was denied. Search for a city instead.";
      if ($("dash").hidden) $("welcome").querySelector("p").textContent = msg; else setStatus(msg, true);
    },
    { timeout: 10000, maximumAge: 600000 }
  );
});

let searchTimer;
$("searchInput").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (q.length < 2) { $("searchResults").hidden = true; return; }
  searchTimer = setTimeout(() => searchCity(q), 300);
});
$("searchForm").addEventListener("submit", (e) => { e.preventDefault(); $("searchResults").querySelector("button")?.click(); });
document.addEventListener("click", (e) => { if (!$("searchForm").contains(e.target)) $("searchResults").hidden = true; });

async function searchCity(q) {
  try {
    const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=en&format=json`);
    const j = await r.json();
    const list = $("searchResults");
    list.innerHTML = (j.results || []).map((c, i) =>
      `<li><button type="button" data-i="${i}">${esc(c.name)}<span class="muted small">${esc([c.admin1, c.country].filter(Boolean).join(", "))}</span></button></li>`
    ).join("") || `<li class="muted small" style="padding:8px">No matches</li>`;
    list.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      const c = j.results[+b.dataset.i];
      list.hidden = true;
      $("searchInput").value = "";
      run({ lat: c.latitude, lon: c.longitude, tz: c.timezone || browserTZ, name: [c.name, c.country].filter(Boolean).join(", ") });
    }));
    list.querySelectorAll("button span").forEach((s) => { s.style.display = "block"; });
    list.hidden = false;
  } catch {
    setStatus("City search is unavailable right now.", true);
  }
}

/* ---------- Red mode + starfield ---------- */

$("redBtn").addEventListener("click", () => {
  const on = document.documentElement.classList.toggle("red");
  $("redBtn").setAttribute("aria-pressed", on);
});

function drawStars() {
  const c = $("stars"), ctx = c.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  c.width = innerWidth * dpr; c.height = innerHeight * dpr;
  ctx.scale(dpr, dpr);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const n = Math.round((innerWidth * innerHeight) / 2600);
  for (let i = 0; i < n; i++) {
    const r = rand() ** 3 * 1.4 + 0.2;
    ctx.globalAlpha = 0.25 + rand() * 0.6;
    ctx.fillStyle = rand() > 0.85 ? "#ffe9c4" : "#dfe6ff";
    ctx.beginPath(); ctx.arc(rand() * innerWidth, rand() * innerHeight, r, 0, Math.PI * 2); ctx.fill();
  }
}
drawStars();
addEventListener("resize", drawStars);

/* ---------- Boot ---------- */

try {
  const saved = JSON.parse(localStorage.getItem(STORE_KEY));
  if (saved && typeof saved.lat === "number") run(saved);
} catch {}
