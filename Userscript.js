// ==UserScript==
// @name         GeoFS Radar Addon Improved
// @namespace    geofs-local
// @version      1.3
// @description  Draggable radar window with clean tag blocking, target cycling, lock tag, richer target stats, and extended ranges
// @match        https://www.geo-fs.com/*
// @match        https://geo-fs.com/*
// @match        https://legacy.geo-fs.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const KEY_TOGGLE = "q";
  const KEY_NEXT = "w";
  const KEY_PREV = "r";
  const KEY_LOCK = "l";
  const KEY_RANGE_UP = "y";
  const KEY_RANGE_DOWN = "u";

  // Extended to AWACS ranges
  const RANGE_OPTIONS_NM = [2, 5, 10, 20, 40, 80, 160, 200, 300];
  const LABEL_REFRESH_MS = 180;
  const CONTACT_STALE_MS = 10000;

  const state = {
    enabled: false,
    selectedUid: null,
    lockedUid: null,
    rangeIndex: 3, // Defaults to 20NM
    overlay: null,
    header: null,
    canvas: null,
    footer: null,
    title: null,
    rangeText: null,
    ctx: null,
    dpr: Math.max(1, window.devicePixelRatio || 1),
    canvasCssW: 252,
    canvasCssH: 206,
    panelW: 252,
    panelH: 336,
    dragActive: false,
    dragOffsetX: 0,
    dragOffsetY: 0,
    labelTickAt: 0,
    contactCache: Object.create(null),
    rafId: 0
  };

  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return el.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function normalizeDeg(deg) {
    return (Number(deg || 0) % 360 + 360) % 360;
  }

  function currentRangeNm() {
    return RANGE_OPTIONS_NM[state.rangeIndex];
  }

  function isFooCallsign(callsign) {
    return String(callsign || "").trim().toUpperCase() === "FOO";
  }

  function getUserUid(user) {
    const uid = String(user?.id ?? user?.uid ?? "").trim();
    return uid || null;
  }

  function getUserStyleKey(user) {
    return user?.isTraffic ? "traffic"
      : user?.premium ? "premium"
      : user?.acid == 1 ? "xavier"
      : "default";
  }

  function removeUserLabel(user) {
    if (!user) return;
    if (user.label) {
      try { window.geofs?.api?.removeLabel(user.label); } catch (e) {}
      user.label = null;
    }
    if (user.icon) {
      try { user.icon.destroy(); } catch (e) {}
      user.icon = null;
    }
  }

  function showUserLabel(user) {
    if (!user || user.label) return;
    const proto = window.multiplayer?.User?.prototype;
    const originalAdd = proto?.__radarOriginalAddCallsign;
    if (typeof originalAdd !== "function") return;
    try {
      originalAdd.call(user, user.callsign || "", getUserStyleKey(user));
    } catch (e) {}
  }

  function getAllUsersMap() {
    const out = new Map();

    function absorb(source) {
      for (const user of Object.values(source || {})) {
        const uid = getUserUid(user);
        if (uid) out.set(uid, user);
      }
    }

    absorb(window.multiplayer?.users);
    absorb(window.multiplayer?.visibleUsers);
    return out;
  }

  function getOwnship() {
    const lla = window.geofs?.aircraft?.instance?.llaLocation;
    const heading = Number(window.geofs?.animation?.values?.heading ?? 0);
    const airspeedMs = Number(window.geofs?.animation?.values?.airspeedms ?? 0);

    if (!Array.isArray(lla) || !Number.isFinite(lla[0]) || !Number.isFinite(lla[1])) {
      return null;
    }

    return {
      lat: Number(lla[0]),
      lon: Number(lla[1]),
      alt: Number(lla[2] ?? 0),
      heading,
      speedKnots: airspeedMs * 1.94384,
      lla
    };
  }

  function distanceMeters(a, b) {
    const latAvgRad = ((Number(a[0]) + Number(b[0])) * 0.5) * Math.PI / 180;
    const dx = (Number(b[1]) - Number(a[1])) * 111320 * Math.cos(latAvgRad);
    const dy = (Number(b[0]) - Number(a[0])) * 110540;
    const dz = Number(b[2] ?? 0) - Number(a[2] ?? 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  function toRelativeNm(own, targetLat, targetLon) {
    const latAvgRad = (own.lat + targetLat) * 0.5 * Math.PI / 180;
    const northMeters = (targetLat - own.lat) * 110540;
    const eastMeters = (targetLon - own.lon) * 111320 * Math.cos(latAvgRad);

    return {
      northNm: northMeters / 1852,
      eastNm: eastMeters / 1852
    };
  }

  function toHeadingFrame(relativeNm, headingDeg) {
    const hdgRad = Number(headingDeg || 0) * Math.PI / 180;
    const sinH = Math.sin(hdgRad);
    const cosH = Math.cos(hdgRad);

    return {
      forwardNm: relativeNm.northNm * cosH + relativeNm.eastNm * sinH,
      rightNm: -relativeNm.northNm * sinH + relativeNm.eastNm * cosH
    };
  }

  function getBearingDeg(northNm, eastNm) {
    return normalizeDeg(Math.atan2(eastNm, northNm) * 180 / Math.PI);
  }

  function getSortToken(contact) {
    return `${String(contact.callsign || "").toUpperCase()}|${String(contact.uid || "")}`;
  }

  function formatAltitudeFeet(feet) {
    return Number.isFinite(feet) ? `${Math.round(feet)}FT` : "--";
  }

  function formatDistanceText(distanceNm) {
    if (!Number.isFinite(distanceNm)) return "--";
    if (distanceNm >= 0.5) return `${(Math.round(distanceNm * 100) / 100).toFixed(2)}NM`;
    return `${Math.round(distanceNm * 6076.11549)}FT`;
  }

  function formatClosureText(closureKts) {
    if (!Number.isFinite(closureKts)) return "--";
    return `${Math.round(closureKts)}KT`;
  }

  function getVisibleContacts() {
    const own = getOwnship();
    if (!own) return [];

    const now = Date.now();
    const visible = Object.values(window.multiplayer?.visibleUsers || {});

    for (const user of visible) {
      const uid = getUserUid(user);
      const co = user?.lastUpdate?.co;
      if (!uid || !Array.isArray(co) || !Number.isFinite(co[0]) || !Number.isFinite(co[1])) continue;
      if (isFooCallsign(user?.callsign ?? user?.cs)) continue;

      const lat = Number(co[0]);
      const lon = Number(co[1]);
      const alt = Number(co[2] ?? 0);

      if (distanceMeters(own.lla, [lat, lon, alt]) < 30) continue;

      state.contactCache[uid] = {
        uid,
        user,
        callsign: String(user?.callsign ?? user?.cs ?? "").trim() || "NA",
        aircraftName: String(user?.aircraftName ?? "").trim() || "UNKNOWN",
        lat,
        lon,
        alt,
        altFeet: Number.isFinite(alt) ? Math.round(alt * 3.28084) : null,
        headingDeg: normalizeDeg(Number(co[3] ?? 0)),
        speedKts: Number.isFinite(Number(user?.lastUpdate?.st?.as)) ? Math.round(Number(user.lastUpdate.st.as)) : null,
        lastSeenMs: now
      };
    }

    const contacts = [];
    for (const uid of Object.keys(state.contactCache)) {
      const c = state.contactCache[uid];
      if (!c) continue;

      if (now - Number(c.lastSeenMs || 0) > CONTACT_STALE_MS) {
        delete state.contactCache[uid];
        if (state.selectedUid === uid) state.selectedUid = null;
        if (state.lockedUid === uid) state.lockedUid = null;
        continue;
      }

      const rel = toRelativeNm(own, c.lat, c.lon);
      const frame = toHeadingFrame(rel, own.heading);
      const distanceNm = Math.hypot(frame.forwardNm, frame.rightNm);
      const bearingDeg = getBearingDeg(rel.northNm, rel.eastNm);
      const altDeltaFt = Number.isFinite(c.altFeet) ? Math.round(c.altFeet - own.alt * 3.28084) : null;

      contacts.push({
        ...c,
        northNm: rel.northNm,
        eastNm: rel.eastNm,
        forwardNm: frame.forwardNm,
        rightNm: frame.rightNm,
        distanceNm,
        bearingDeg,
        altDeltaFt
      });
    }

    contacts.sort((a, b) => getSortToken(a).localeCompare(getSortToken(b)));
    return contacts;
  }

  function getInRangeContacts() {
    const maxRange = currentRangeNm();
    return getVisibleContacts().filter(c => c.distanceNm <= maxRange);
  }

  function ensureSelection(contacts) {
    const list = Array.isArray(contacts) ? contacts : [];
    if (!list.length) {
      state.selectedUid = null;
      state.lockedUid = null;
      return;
    }

    if (!state.selectedUid || !list.some(c => c.uid === state.selectedUid)) {
      state.selectedUid = list[0].uid;
    }

    if (state.lockedUid && !list.some(c => c.uid === state.lockedUid)) {
      state.lockedUid = null;
    }
  }

  function stepSelection(direction) {
    const contacts = getInRangeContacts();
    if (!contacts.length) {
      state.selectedUid = null;
      return;
    }

    ensureSelection(contacts);
    const idx = Math.max(0, contacts.findIndex(c => c.uid === state.selectedUid));
    const nextIndex = (idx + (direction > 0 ? 1 : -1) + contacts.length) % contacts.length;
    state.selectedUid = contacts[nextIndex].uid;
  }

  function stepRange(direction) {
    state.rangeIndex = clamp(
      state.rangeIndex + (direction > 0 ? 1 : -1),
      0,
      RANGE_OPTIONS_NM.length - 1
    );
    const contacts = getInRangeContacts();
    ensureSelection(contacts);
  }

  function toggleLock() {
    const contacts = getInRangeContacts();
    ensureSelection(contacts);
    if (!state.selectedUid) return;
    state.lockedUid = state.lockedUid === state.selectedUid ? null : state.selectedUid;
    applyLabelPolicy();
  }

  function calculateClosingSpeed(myPos, myHeading, mySpeedKnots, otherData) {
    const DEGTORAD = Math.PI / 180;

    const myHeadingRad = myHeading * DEGTORAD;
    const myVelKnots = [
      mySpeedKnots * Math.sin(myHeadingRad),
      mySpeedKnots * Math.cos(myHeadingRad),
      0
    ];

    const otherHeadingRad = Number(otherData?.co?.[3] ?? 0) * DEGTORAD;
    const otherSpeed = Number(otherData?.st?.as ?? 0);
    const otherVelKnots = [
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

    const relVelKnots = [
      otherVelKnots[0] - myVelKnots[0],
      otherVelKnots[1] - myVelKnots[1],
      otherVelKnots[2] - myVelKnots[2]
    ];

    return relVelKnots[0] * dUnit[0] + relVelKnots[1] * dUnit[1] + relVelKnots[2] * dUnit[2];
  }

  function getLiveTargetMetrics(user) {
    const my = getOwnship();
    if (!my) return null;

    const co = user?.lastUpdate?.co;
    if (!Array.isArray(co)) return null;

    const altFeet = Number.isFinite(Number(co[2])) ? Math.round(Number(co[2]) * 3.28084) : null;
    const speedKts = Number.isFinite(Number(user?.lastUpdate?.st?.as)) ? Math.round(Number(user.lastUpdate.st.as)) : null;
    const closureKts = Math.round(
      calculateClosingSpeed(my.lla, my.heading, my.speedKnots, user?.lastUpdate || {})
    );
    const distFeet = Number(user?.distance) ||
      (Array.isArray(co) ? distanceMeters(my.lla, co) * 3.28084 : 0);
    const distNm = distFeet / 6076.11549;

    return {
      altFeet,
      speedKts,
      closureKts,
      distanceNm: distNm
    };
  }

  function formatLockedLabel(user) {
    const metrics = getLiveTargetMetrics(user);
    const callsign = String(user?.callsign ?? user?.cs ?? "NA").trim() || "NA";

    const speedText = metrics?.speedKts != null ? `${metrics.speedKts}KT` : "--";
    const closureText = formatClosureText(metrics?.closureKts);
    const distanceText = formatDistanceText(metrics?.distanceNm);
    const altitudeText = formatAltitudeFeet(metrics?.altFeet);

    // Cleaned up, label-less locked tag
    return `${callsign} ${speedText} ${closureText} ${distanceText} ${altitudeText}`;
  }

  function updateLockedLabel() {
    if (!state.enabled || !state.lockedUid) return;
    const user = getAllUsersMap().get(state.lockedUid);
    if (!user) return;

    showUserLabel(user);
    if (user.label) {
      try {
        user.label.text = formatLockedLabel(user);
      } catch (e) {}
    }
  }

  function applyLabelPolicy() {
    const allUsers = getAllUsersMap();

    for (const user of allUsers.values()) {
      const uid = getUserUid(user);

      if (!state.enabled) {
        showUserLabel(user);
        continue;
      }

      if (uid && uid === state.lockedUid && !isFooCallsign(user?.callsign ?? user?.cs)) {
        showUserLabel(user);
        if (user.label) {
          try { user.label.text = formatLockedLabel(user); } catch (e) {}
        }
      } else {
        removeUserLabel(user);
      }
    }
  }

  function patchGeoFS() {
    if (!window.multiplayer || !window.geofs || !window.multiplayer.User || !window.multiplayer.User.prototype) {
      return false;
    }

    const proto = window.multiplayer.User.prototype;

    if (!proto.__radarOriginalAddCallsign) {
      proto.__radarOriginalAddCallsign = proto.addCallsign;
    }
    if (!proto.__radarOriginalRemoveCallsign) {
      proto.__radarOriginalRemoveCallsign = proto.removeCallsign;
    }
    if (proto.__radarPatchApplied) {
      return true;
    }

    proto.__radarPatchApplied = true;

    proto.addCallsign = function (callsign, styleKey) {
      const uid = getUserUid(this);
      const cs = String(this.callsign || callsign || "").trim();

      if (state.enabled) {
        const allowed = uid && state.lockedUid === uid && !isFooCallsign(cs);
        if (!allowed) {
          this.label = null;
          if (this.icon) {
            try { this.icon.destroy(); } catch (e) {}
            this.icon = null;
          }
          return;
        }

        const result = proto.__radarOriginalAddCallsign.call(this, callsign, styleKey);
        try {
          if (this.label) this.label.text = formatLockedLabel(this);
        } catch (e) {}
        return result;
      }

      return proto.__radarOriginalAddCallsign.call(this, callsign, styleKey);
    };

    proto.removeCallsign = function () {
      removeUserLabel(this);
    };

    return true;
  }

  function createOverlay() {
    if (state.overlay) return;

    const overlay = document.createElement("div");
    overlay.id = "geofs-radar-overlay";
    Object.assign(overlay.style, {
      position: "fixed",
      left: `${Math.max(16, window.innerWidth - 300)}px`,
      top: "88px",
      width: `${state.panelW}px`,
      height: `${state.panelH}px`,
      background: "rgba(0,0,0,0.84)",
      border: "1px solid #00ff66",
      borderRadius: "8px",
      boxShadow: "0 0 20px rgba(0,255,102,0.18)",
      color: "#00ff66",
      fontFamily: "monospace",
      zIndex: "999999",
      display: "none",
      userSelect: "none",
      overflow: "hidden",
      pointerEvents: "auto"
    });

    const header = document.createElement("div");
    Object.assign(header.style, {
      height: "28px",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "0 8px",
      borderBottom: "1px solid rgba(0,255,102,0.28)",
      cursor: "move",
      fontSize: "12px",
      letterSpacing: "0.4px"
    });

    const title = document.createElement("div");
    title.textContent = "RADAR";

    const rangeText = document.createElement("div");
    rangeText.textContent = "20NM";

    const canvas = document.createElement("canvas");
    Object.assign(canvas.style, {
      display: "block",
      width: `${state.canvasCssW}px`,
      height: `${state.canvasCssH}px`,
      background: "#000"
    });

    const footer = document.createElement("div");
    Object.assign(footer.style, {
      height: "100px",
      borderTop: "1px solid rgba(0,255,102,0.28)",
      padding: "6px 8px",
      fontSize: "11px",
      lineHeight: "1.25",
      whiteSpace: "pre-line"
    });

    header.appendChild(title);
    header.appendChild(rangeText);
    overlay.appendChild(header);
    overlay.appendChild(canvas);
    overlay.appendChild(footer);
    document.body.appendChild(overlay);

    state.overlay = overlay;
    state.header = header;
    state.canvas = canvas;
    state.footer = footer;
    state.title = title;
    state.rangeText = rangeText;
    state.ctx = canvas.getContext("2d");

    resizeCanvas();
    bindDrag();
    bindWheelRange();
  }

  function resizeCanvas() {
    if (!state.canvas || !state.ctx) return;
    state.dpr = Math.max(1, window.devicePixelRatio || 1);
    state.canvas.width = Math.round(state.canvasCssW * state.dpr);
    state.canvas.height = Math.round(state.canvasCssH * state.dpr);
    state.ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  }

  function bindWheelRange() {
    state.overlay.addEventListener("wheel", function (e) {
      if (!state.enabled) return;
      e.preventDefault();
      stepRange(e.deltaY > 0 ? 1 : -1);
    }, { passive: false });
  }

  function bindDrag() {
    state.header.addEventListener("mousedown", function (e) {
      state.dragActive = true;
      const rect = state.overlay.getBoundingClientRect();
      state.dragOffsetX = e.clientX - rect.left;
      state.dragOffsetY = e.clientY - rect.top;
      e.preventDefault();
    });

    window.addEventListener("mousemove", function (e) {
      if (!state.dragActive) return;
      const x = clamp(e.clientX - state.dragOffsetX, 0, window.innerWidth - state.panelW);
      const y = clamp(e.clientY - state.dragOffsetY, 0, window.innerHeight - state.panelH);
      state.overlay.style.left = `${x}px`;
      state.overlay.style.top = `${y}px`;
    });

    window.addEventListener("mouseup", function () {
      state.dragActive = false;
    });
  }

  function setRadarEnabled(enabled) {
    state.enabled = !!enabled;
    if (!state.enabled) {
      state.lockedUid = null;
    }
    if (state.overlay) {
      state.overlay.style.display = state.enabled ? "block" : "none";
    }
    applyLabelPolicy();
  }

  function getPanelTargetInfo(contacts) {
    const selected = contacts.find(c => c.uid === state.selectedUid) || null;
    const locked = contacts.find(c => c.uid === state.lockedUid) || null;
    const target = locked || selected;
    const isLocked = !!locked;

    if (!target) return "NO TARGET\nLOCK NONE\nQ TOGGLE  W/R SEL  Y/U RNG  L LOCK";

    const liveUser = getAllUsersMap().get(target.uid);
    const liveMetrics = liveUser ? getLiveTargetMetrics(liveUser) : null;

    const speedText = liveMetrics?.speedKts != null ? `${liveMetrics.speedKts}KT` : (target.speedKts != null ? `${target.speedKts}KT` : "--");
    const closureText = formatClosureText(liveMetrics?.closureKts);
    const distanceText = formatDistanceText(liveMetrics?.distanceNm ?? target.distanceNm);
    const altitudeText = formatAltitudeFeet(liveMetrics?.altFeet ?? target.altFeet);
    const headingText = Number.isFinite(target.headingDeg) ? `${Math.round(target.headingDeg)}°` : "--";
    const bearingText = Number.isFinite(target.bearingDeg) ? `${Math.round(target.bearingDeg)}°` : "--";
    const altDeltaText = Number.isFinite(target.altDeltaFt)
      ? `${target.altDeltaFt >= 0 ? "+" : ""}${Math.round(target.altDeltaFt)}FT`
      : "--";

    return [
      `${isLocked ? "LOCK" : "SEL "} ${target.callsign}`,
      `${target.aircraftName}`,
      `SPD ${speedText}  ALT ${altitudeText}  HDG ${headingText}`,
      `RNG ${distanceText}  VC ${closureText}  BRG ${bearingText}`,
      `DALT ${altDeltaText}  Q TOGGLE  W/R SEL  Y/U RNG  L LOCK`
    ].join("\n");
  }

  function drawRadar(timestamp) {
    if (!state.enabled || !state.ctx) return;

    const ctx = state.ctx;
    const w = state.canvasCssW;
    const h = state.canvasCssH;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const radius = Math.min(w, h) * 0.40;
    const rangeNm = currentRangeNm();
    const contacts = getInRangeContacts();

    ensureSelection(contacts);

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = "rgba(0,255,102,0.18)";
    ctx.lineWidth = 1;
    for (let i = 1; i <= 4; i++) {
      ctx.beginPath();
      ctx.arc(cx, cy, radius * i / 4, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.moveTo(cx - radius, cy);
    ctx.lineTo(cx + radius, cy);
    ctx.moveTo(cx, cy - radius);
    ctx.lineTo(cx, cy + radius);
    ctx.stroke();

    const sweepAngle = ((timestamp * 0.0012) % (Math.PI * 2));
    for (let i = 0; i < 10; i++) {
      const a = sweepAngle - i * 0.06;
      const alpha = 0.22 - i * 0.018;
      if (alpha <= 0) continue;
      ctx.strokeStyle = `rgba(0,255,102,${alpha})`;
      ctx.lineWidth = i === 0 ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.sin(a) * radius, cy - Math.cos(a) * radius);
      ctx.stroke();
    }

    ctx.strokeStyle = "rgba(255,255,255,0.75)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 8);
    ctx.lineTo(cx, cy + 8);
    ctx.moveTo(cx - 8, cy);
    ctx.lineTo(cx + 8, cy);
    ctx.stroke();

    for (const c of contacts) {
      const x = cx + (c.rightNm / rangeNm) * radius;
      const y = cy - (c.forwardNm / rangeNm) * radius;
      if (Math.hypot(x - cx, y - cy) > radius) continue;

      const isSelected = c.uid === state.selectedUid;
      const isLocked = c.uid === state.lockedUid;

      ctx.fillStyle = isLocked ? "#ff3333" : isSelected ? "#ffff33" : "#ffffff";
      ctx.beginPath();
      ctx.arc(x, y, isLocked ? 4 : 2.7, 0, Math.PI * 2);
      ctx.fill();

      if (isSelected || isLocked) {
        ctx.strokeStyle = isLocked ? "#ff3333" : "#ffff33";
        ctx.lineWidth = 1;
        ctx.strokeRect(x - 6, y - 6, 12, 12);
      }
    }

    state.title.textContent = `RADAR ${contacts.length}`;
    state.rangeText.textContent = `${rangeNm}NM`;
    state.footer.textContent = getPanelTargetInfo(contacts);
  }

  function animationLoop(timestamp) {
    if (state.enabled) {
      drawRadar(timestamp);

      const now = Date.now();
      if (now - state.labelTickAt >= LABEL_REFRESH_MS) {
        state.labelTickAt = now;
        applyLabelPolicy();
        updateLockedLabel();
      }
    }
    state.rafId = window.requestAnimationFrame(animationLoop);
  }

  function onKey(event) {
    if (isTypingTarget(event.target)) return;
    if (event.repeat) return;

    const key = String(event.key || "").toLowerCase();
    const handled = [KEY_TOGGLE, KEY_NEXT, KEY_PREV, KEY_LOCK, KEY_RANGE_UP, KEY_RANGE_DOWN].includes(key);
    if (!handled) return;

    event.preventDefault();
    event.stopPropagation();

    if (key === KEY_TOGGLE) {
      setRadarEnabled(!state.enabled);
      return;
    }

    if (!state.enabled) return;

    if (key === KEY_NEXT) {
      stepSelection(1);
      return;
    }

    if (key === KEY_PREV) {
      stepSelection(-1);
      return;
    }

    if (key === KEY_LOCK) {
      toggleLock();
      return;
    }

    if (key === KEY_RANGE_UP) {
      stepRange(1);
      return;
    }
    
    if (key === KEY_RANGE_DOWN) {
      stepRange(-1);
    }
  }

  function waitForGeoFS() {
    if (!patchGeoFS()) {
      setTimeout(waitForGeoFS, 800);
      return;
    }

    createOverlay();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", resizeCanvas);

    if (!state.rafId) {
      state.rafId = window.requestAnimationFrame(animationLoop);
    }

    applyLabelPolicy();
  }

  waitForGeoFS();
})();
