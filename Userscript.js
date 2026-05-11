// ==UserScript==
// @name         GeoFS Simple Radar
// @namespace    http://tampermonkey.net/
// @version      2026-05-11
// @description  Radar window with player dots, selection, lock, and controlled nametags
// @match        https://geo-fs.com/geofs.php*
// @match        https://www.geo-fs.com/geofs.php*
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const UPDATE_MS = 150;
  const LABEL_UPDATE_MS = 250;
  const RANGE_OPTIONS_NM = [2, 5, 10, 20, 40, 80];
  let rangeIndex = 3; // 20 nm default

  const state = {
    enabled: false,
    selectedUid: null,
    lockedUid: null,
    overlay: null,
    canvas: null,
    ctx: null,
    lastLabelTick: 0
  };

  function getOwnship() {
    const lla = window.geofs?.aircraft?.instance?.llaLocation;
    const heading = Number(window.geofs?.animation?.values?.heading ?? 0);
    if (!Array.isArray(lla) || !Number.isFinite(lla[0]) || !Number.isFinite(lla[1])) return null;
    return {
      lat: Number(lla[0]),
      lon: Number(lla[1]),
      alt: Number(lla[2] ?? 0),
      heading
    };
  }

  function isFoo(user) {
    const cs = String(user?.callsign ?? user?.cs ?? "").trim().toUpperCase();
    return cs === "FOO";
  }

  function getUsers() {
    const own = getOwnship();
    if (!own) return [];

    const list = Object.values(window.multiplayer?.visibleUsers ?? {});
    const out = [];

    for (const user of list) {
      const co = user?.lastUpdate?.co;
      if (!Array.isArray(co) || !Number.isFinite(co[0]) || !Number.isFinite(co[1])) continue;
      if (isFoo(user)) continue;

      const uid = String(user?.id ?? user?.uid ?? "").trim();
      if (!uid) continue;

      const lat = Number(co[0]);
      const lon = Number(co[1]);
      const alt = Number(co[2] ?? 0);
      const heading = Number(co[3] ?? 0);

      // Exclude self by very small positional separation
      const sep = distanceMeters([own.lat, own.lon, own.alt], [lat, lon, alt]);
      if (sep < 30) continue;

      const rel = toRelativeNm(own, { lat, lon, alt });
      if (!rel) continue;

      out.push({
        uid,
        user,
        lat,
        lon,
        alt,
        heading,
        forwardNm: rel.forwardNm,
        rightNm: rel.rightNm,
        distanceNm: Math.hypot(rel.forwardNm, rel.rightNm),
        callsign: String(user?.callsign ?? user?.cs ?? "").trim() || "NA",
        aircraftName: String(user?.aircraftName ?? "").trim() || "UNKNOWN",
        speedKts: Number.isFinite(Number(user?.lastUpdate?.st?.as)) ? Math.round(Number(user.lastUpdate.st.as)) : null
      });
    }

    out.sort((a, b) => a.distanceNm - b.distanceNm);
    return out;
  }

  function distanceMeters(a, b) {
    const latAvgRad = ((Number(a[0]) + Number(b[0])) * 0.5) * Math.PI / 180;
    const dx = (Number(b[1]) - Number(a[1])) * 111320 * Math.cos(latAvgRad);
    const dy = (Number(b[0]) - Number(a[0])) * 110540;
    const dz = Number(b[2] ?? 0) - Number(a[2] ?? 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  function toRelativeNm(own, target) {
    const latAvgRad = ((own.lat + target.lat) * 0.5) * Math.PI / 180;
    const northMeters = (target.lat - own.lat) * 110540;
    const eastMeters = (target.lon - own.lon) * 111320 * Math.cos(latAvgRad);

    const northNm = northMeters / 1852;
    const eastNm = eastMeters / 1852;

    const hdgRad = own.heading * Math.PI / 180;
    const sinH = Math.sin(hdgRad);
    const cosH = Math.cos(hdgRad);

    return {
      forwardNm: northNm * cosH + eastNm * sinH,
      rightNm: -northNm * sinH + eastNm * cosH
    };
  }

  function ensureSelection(users) {
    if (!users.length) {
      state.selectedUid = null;
      state.lockedUid = null;
      return;
    }

    if (!state.selectedUid || !users.some(u => u.uid === state.selectedUid)) {
      state.selectedUid = users[0].uid;
    }

    if (state.lockedUid && !users.some(u => u.uid === state.lockedUid)) {
      state.lockedUid = null;
    }
  }

  function cycleSelection(step = 1) {
    const users = getUsers().filter(u => u.distanceNm <= currentRangeNm());
    if (!users.length) return;

    ensureSelection(users);
    const idx = Math.max(0, users.findIndex(u => u.uid === state.selectedUid));
    const next = (idx + step + users.length) % users.length;
    state.selectedUid = users[next].uid;
  }

  function currentRangeNm() {
    return RANGE_OPTIONS_NM[rangeIndex];
  }

  function toggleLock() {
    const users = getUsers().filter(u => u.distanceNm <= currentRangeNm());
    ensureSelection(users);
    if (!state.selectedUid) return;
    state.lockedUid = state.lockedUid === state.selectedUid ? null : state.selectedUid;
  }

  function createOverlay() {
    if (state.overlay) return;

    const wrap = document.createElement("div");
    wrap.id = "geofs-radar-overlay";
    Object.assign(wrap.style, {
      position: "fixed",
      right: "20px",
      bottom: "20px",
      width: "320px",
      height: "380px",
      background: "rgba(0,0,0,0.82)",
      border: "1px solid #00ff66",
      borderRadius: "8px",
      zIndex: 999999,
      display: "none",
      boxShadow: "0 0 20px rgba(0,255,102,0.2)",
      color: "#00ff66",
      fontFamily: "monospace",
      overflow: "hidden"
    });

    const header = document.createElement("div");
    Object.assign(header.style, {
      height: "36px",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "0 10px",
      borderBottom: "1px solid rgba(0,255,102,0.35)",
      fontSize: "13px"
    });

    const title = document.createElement("div");
    title.id = "geofs-radar-title";
    title.textContent = "RADAR";

    const info = document.createElement("div");
    info.id = "geofs-radar-info";

    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 280;
    Object.assign(canvas.style, {
      width: "100%",
      height: "280px",
      display: "block"
    });

    const footer = document.createElement("div");
    footer.id = "geofs-radar-footer";
    Object.assign(footer.style, {
      height: "64px",
      borderTop: "1px solid rgba(0,255,102,0.35)",
      padding: "8px 10px",
      fontSize: "12px",
      lineHeight: "1.35"
    });

    header.appendChild(title);
    header.appendChild(info);
    wrap.appendChild(header);
    wrap.appendChild(canvas);
    wrap.appendChild(footer);
    document.body.appendChild(wrap);

    state.overlay = wrap;
    state.canvas = canvas;
    state.ctx = canvas.getContext("2d");
  }

  function setRadarVisible(visible) {
    createOverlay();
    state.enabled = visible;
    state.overlay.style.display = visible ? "block" : "none";
    if (!visible) state.lockedUid = null;
    refreshLabels(true);
  }

  function drawRadar() {
    if (!state.enabled || !state.ctx || !state.canvas) return;

    const ctx = state.ctx;
    const w = state.canvas.width;
    const h = state.canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(w, h) * 0.42;
    const rangeNm = currentRangeNm();

    const users = getUsers().filter(u => u.distanceNm <= rangeNm);
    ensureSelection(users);

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = "rgba(0,255,102,0.32)";
    ctx.lineWidth = 1;
    for (let i = 1; i <= 4; i++) {
      ctx.beginPath();
      ctx.arc(cx, cy, radius * i / 4, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.moveTo(cx, cy - radius);
    ctx.lineTo(cx, cy + radius);
    ctx.moveTo(cx - radius, cy);
    ctx.lineTo(cx + radius, cy);
    ctx.stroke();

    const sweep = (Date.now() % 2500) / 2500 * Math.PI * 2;
    ctx.strokeStyle = "#00ff66";
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.sin(sweep) * radius, cy - Math.cos(sweep) * radius);
    ctx.stroke();

    for (const u of users) {
      const x = cx + (u.rightNm / rangeNm) * radius;
      const y = cy - (u.forwardNm / rangeNm) * radius;
      if (Math.hypot(x - cx, y - cy) > radius) continue;

      const isSelected = u.uid === state.selectedUid;
      const isLocked = u.uid === state.lockedUid;

      ctx.fillStyle = isLocked ? "#ff3333" : isSelected ? "#ffff33" : "#ffffff";
      ctx.beginPath();
      ctx.arc(x, y, isLocked ? 5 : 3, 0, Math.PI * 2);
      ctx.fill();

      if (isSelected || isLocked) {
        ctx.strokeStyle = isLocked ? "#ff3333" : "#ffff33";
        ctx.strokeRect(x - 7, y - 7, 14, 14);
      }
    }

    const selected = users.find(u => u.uid === state.selectedUid) || null;
    const locked = users.find(u => u.uid === state.lockedUid) || null;

    document.getElementById("geofs-radar-info").textContent = `RNG ${rangeNm}NM`;
    document.getElementById("geofs-radar-footer").innerHTML =
      selected
        ? `SEL ${selected.callsign} | ${Math.round(selected.distanceNm * 10) / 10}NM<br>` +
          `LOCK ${locked ? locked.callsign : "NONE"}`
        : `NO TARGETS<br>LOCK NONE`;
  }

  function calculateClosingSpeed(myPos, myHeading, mySpeedKnots, otherData) {
    const DEGTORAD = Math.PI / 180;
    const myHeadingRad = myHeading * DEGTORAD;
    const myVel = [
      mySpeedKnots * Math.sin(myHeadingRad),
      mySpeedKnots * Math.cos(myHeadingRad),
      0
    ];

    const otherHeadingRad = Number(otherData?.co?.[3] ?? 0) * DEGTORAD;
    const otherSpeed = Number(otherData?.st?.as ?? 0);
    const otherVel = [
      otherSpeed * Math.sin(otherHeadingRad),
      otherSpeed * Math.cos(otherHeadingRad),
      0
    ];

    const latAvg = ((Number(myPos[0]) + Number(otherData?.co?.[0] ?? 0)) / 2) * DEGTORAD;
    const dx = (Number(otherData?.co?.[1] ?? 0) - Number(myPos[1])) * 111320 * Math.cos(latAvg);
    const dy = (Number(otherData?.co?.[0] ?? 0) - Number(myPos[0])) * 110540;
    const dz = Number(otherData?.co?.[2] ?? 0) - Number(myPos[2] ?? 0);

    const d = [dx, dy, dz];
    const dMag = Math.sqrt(d[0] ** 2 + d[1] ** 2 + d[2] ** 2) || 1;
    const dUnit = [d[0] / dMag, d[1] / dMag, d[2] / dMag];
    const relVel = [otherVel[0] - myVel[0], otherVel[1] - myVel[1], otherVel[2] - myVel[2]];
    return relVel[0] * dUnit[0] + relVel[1] * dUnit[1] + relVel[2] * dUnit[2];
  }

  function formatLockedLabel(user) {
    const myPos = window.geofs?.aircraft?.instance?.llaLocation;
    const myHeading = Number(window.geofs?.animation?.values?.heading ?? 0);
    const mySpeedKnots = Number(window.geofs?.animation?.values?.airspeedms ?? 0) * 1.94384;

    const co = user?.lastUpdate?.co;
    if (!Array.isArray(myPos) || !Array.isArray(co)) return String(user?.callsign ?? "NA");

    const feetInNm = 6076.11549;
    const distFeet = Number(user?.distance ?? distanceMeters(myPos, co) * 3.28084);
    const distNm = distFeet / feetInNm;
    const distText = distNm >= 0.5 ? `${Math.round(distNm * 100) / 100} nm` : `${Math.round(distFeet)} feet`;

    const speed = Number.isFinite(Number(user?.lastUpdate?.st?.as)) ? `${Math.round(Number(user.lastUpdate.st.as))} knots` : "";
    const closure = Math.round(calculateClosingSpeed(myPos, myHeading, mySpeedKnots, user.lastUpdate || {}));

    return `${user.callsign} ${speed} ${closure} ${distText}`.trim();
  }

  function refreshLabels(force = false) {
    const now = Date.now();
    if (!force && now - state.lastLabelTick < LABEL_UPDATE_MS) return;
    state.lastLabelTick = now;

    const users = Object.values(window.multiplayer?.visibleUsers ?? {});
    for (const user of users) {
      if (!user?.label) continue;

      if (!state.enabled) {
        if (user.callsign) user.label.text = user.callsign;
        continue;
      }

      const uid = String(user?.id ?? user?.uid ?? "").trim();
      if (uid && uid === state.lockedUid) {
        user.label.text = formatLockedLabel(user);
      } else {
        user.label.text = "";
      }
    }
  }

  function tick() {
    drawRadar();
    refreshLabels();
  }

  window.addEventListener("keyup", (e) => {
    const k = String(e.key || "").toLowerCase();

    if (k === "q") {
      setRadarVisible(!state.enabled);
      return;
    }
    if (!state.enabled) return;

    if (k === "w") {
      cycleSelection(1);
      return;
    }
    if (k === "l") {
      toggleLock();
      refreshLabels(true);
      return;
    }
    if (k === "[") {
      rangeIndex = Math.max(0, rangeIndex - 1);
      return;
    }
    if (k === "]") {
      rangeIndex = Math.min(RANGE_OPTIONS_NM.length - 1, rangeIndex + 1);
      return;
    }
  });

  createOverlay();
  setInterval(tick, UPDATE_MS);
})();
