// NextFloor Moonraker (plugin API 1): 3D printers run by Klipper/Moonraker in the 3D plan.
//
// - Handles the "Current Print State" sensor of the Moonraker integration (sensor.<printer>_current_print_state).
//   Place it as a device where the printer stands (room → Devices → Place); a tap on its marker, or on a piece of
//   furniture linked to the same sensor, then opens the printer window instead of Home Assistant's dialog.
// - The marker shows progress and time left while printing ("42% · 1h 12m"), and is highlighted while busy.
// - The window shows the state, file, a progress bar with layers, time left, elapsed time and finish time,
//   nozzle/bed/chamber temperatures, the slicer thumbnail, the printer's camera and (optional) Pause/Resume/Cancel.
// - The other entities are found on the same Home Assistant device by their Moonraker names, so it works for any
//   printer of that integration without setup. A smart plug that powers the printer is found by its name ("<printer>
//   … socket / plug / power", one with "printer" in it first): while it is off the printer shows as off straight away,
//   instead of a minute later when the integration notices. Nothing is stored outside the plan; the buttons press the
//   integration's own button entities after a confirmation.

const TEXT = {
  en: {
    standby: "Idle",
    printing: "Printing",
    paused: "Paused",
    complete: "Finished",
    cancelled: "Cancelled",
    error: "Error",
    offline: "Not connected",
    off: "Off",
    left: "Left",
    elapsed: "Elapsed",
    finish: "Finishes",
    layer: "Layer",
    nozzle: "Nozzle",
    bed: "Bed",
    chamber: "Chamber",
    box: "Box",
    pause: "Pause",
    resume: "Resume",
    cancel: "Cancel",
    confirmPause: "Pause the print on {name}?",
    confirmCancel: "Cancel the print on {name}? This cannot be undone.",
    tomorrow: "tomorrow",
    camera: "Show the camera",
    cameraView: "Camera picture",
    still: "Still picture (refreshes)",
    live: "Live",
    thumbnail: "Show the print's thumbnail",
    controls: "Pause / Resume / Cancel buttons",
    controlsHint: "Each press asks first.",
  },
};

const both = (key) => Object.fromEntries(Object.entries(TEXT).map(([lang, texts]) => [lang, texts[key]]));
const textOf = (hass, key) => (TEXT[(hass?.language ?? "en").slice(0, 2)] ?? TEXT.en)[key] ?? TEXT.en[key];

const SUFFIX = "_current_print_state";
const BUSY = new Set(["printing", "paused"]);
const DEAD = new Set(["unavailable", "unknown"]);

/** The printer's other entities, found by Moonraker's names: first `<domain>.<prefix><name>`, else on the same device. */
const relatedCache = new WeakMap();
function related(hass, entityId) {
  const reg = hass.entities ?? {};
  let perHass = relatedCache.get(reg);
  if (!perHass) relatedCache.set(reg, (perHass = new Map()));
  if (perHass.has(entityId)) return perHass.get(entityId);

  const prefix = entityId.slice("sensor.".length, -SUFFIX.length + 1); // "q2_"
  const device = reg[entityId]?.device_id;
  const onDevice = device ? Object.values(reg).filter((e) => e.device_id === device).map((e) => e.entity_id) : [];
  const find = (domain, name) => {
    const exact = `${domain}.${prefix}${name}`;
    if (hass.states[exact]) return exact;
    // shortest wins, so "_progress" does not pick "_layer_progress"
    return onDevice.filter((id) => id.startsWith(`${domain}.`) && id.endsWith(`_${name}`)).sort((a, b) => a.length - b.length)[0] ?? null;
  };
  const cameras = onDevice.filter((id) => id.startsWith("camera."));
  const deviceName = device ? (hass.devices?.[device]?.name_by_user ?? hass.devices?.[device]?.name) : null;
  const name = deviceName ?? hass.states[entityId]?.attributes.friendly_name?.replace(/ current print state$/i, "") ?? entityId;
  const r = {
    name,
    power: powerSwitch(hass, name),
    printerState: find("sensor", "printer_state"),
    message: find("sensor", "printer_message"),
    filename: find("sensor", "filename"),
    progress: find("sensor", "progress"),
    left: find("sensor", "print_time_left"),
    elapsed: find("sensor", "print_duration"),
    eta: find("sensor", "print_eta"),
    layer: find("sensor", "current_layer"),
    layers: find("sensor", "total_layer"),
    nozzle: find("sensor", "extruder_temperature"),
    nozzleTarget: find("number", "extruder_target"),
    bed: find("sensor", "bed_temperature"),
    bedTarget: find("number", "bed_target"),
    chamber: find("sensor", "chamber_temperature"),
    chamberTarget: find("number", "chamber_target"),
    boxChange: find("sensor", "box_filament_change"),
    pause: find("button", "pause_print"),
    resume: find("button", "resume_print"),
    cancel: find("button", "cancel_print"),
    thumbnail: cameras.find((id) => id.includes("thumbnail")) ?? null,
    camera: cameras.find((id) => !id.includes("thumbnail")) ?? null,
  };
  perHass.set(entityId, r);
  return r;
}

/** The smart plug that powers the printer: a switch named "<printer> … socket|plug|power", one saying "printer" first. */
function powerSwitch(hass, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const named = new RegExp(`^${esc}\\b.*\\b(socket|plug|power|outlet)\\b`, "i");
  const found = Object.keys(hass.states).filter((id) => id.startsWith("switch.") && named.test(String(hass.states[id].attributes.friendly_name ?? "")));
  return found.find((id) => /printer/i.test(String(hass.states[id].attributes.friendly_name))) ?? (found.length === 1 ? found[0] : null);
}

const stateOf = (hass, id) => (id ? hass.states[id]?.state : undefined);
function num(hass, id) {
  const s = stateOf(hass, id);
  const n = s === undefined || DEAD.has(s) ? NaN : Number(s);
  return Number.isFinite(n) ? n : null;
}

/** A duration sensor in seconds, whatever its unit. */
function seconds(hass, id) {
  const n = num(hass, id);
  if (n === null) return null;
  const unit = hass.states[id]?.attributes.unit_of_measurement;
  return n * ({ s: 1, min: 60, h: 3600, d: 86400 }[unit] ?? 1);
}

function formatDuration(s) {
  if (s === null || s <= 0) return "–";
  const m = Math.round(s / 60);
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

function formatFinish(hass, id) {
  const s = stateOf(hass, id);
  const when = s && !DEAD.has(s) ? new Date(s) : null;
  if (!when || Number.isNaN(when.getTime())) return "–";
  const tz = hass.config?.time_zone;
  const lang = hass.locale?.language ?? hass.language ?? "en";
  // Home Assistant's own 12/24-hour choice (profile → time format), else the language's
  const tf = hass.locale?.time_format;
  const opts = { hour: "2-digit", minute: "2-digit", timeZone: tz, ...(tf === "24" ? { hour12: false } : tf === "12" ? { hour12: true } : {}) };
  const time = when.toLocaleTimeString(lang, opts);
  const day = (d) => d.toLocaleDateString("en-CA", { timeZone: tz });
  const tomorrow = new Date(Date.now() + 86400000);
  if (day(when) === day(new Date())) return time;
  if (day(when) === day(tomorrow)) return `${time} ${textOf(hass, "tomorrow")}`;
  return `${when.toLocaleDateString(lang, { weekday: "short", timeZone: tz })} ${time}`;
}

/** What the printer is doing: the print state, "off" while its plug is off, "offline" when Moonraker is not connected. */
function printState(hass, entityId) {
  if (stateOf(hass, related(hass, entityId).power) === "off") return "off";
  const s = stateOf(hass, entityId);
  return !s || DEAD.has(s) ? "offline" : s;
}

const percent = (hass, r) => {
  const p = num(hass, r.progress);
  return p === null ? null : Math.max(0, Math.min(100, p));
};

// ---------------------------------------------------------------------------------------------------------------
// The window

const CSS = `
  .mr { font: 13px/1.35 system-ui, sans-serif; color: #e6f4fb; }
  .mr-top { display: flex; gap: 10px; padding: 10px 12px 6px; align-items: center; }
  .mr-thumb { width: 72px; height: 72px; flex: none; border-radius: 8px; background: rgba(255,255,255,.06) center/contain no-repeat; }
  .mr-thumb[hidden] { display: none; }
  .mr-head { min-width: 0; flex: 1; }
  .mr-state { font-weight: 600; font-size: 15px; display: flex; align-items: center; gap: 6px; }
  .mr-dot { width: 9px; height: 9px; border-radius: 50%; background: #6b7f8a; flex: none; }
  .mr-file { opacity: .75; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mr-msg { opacity: .75; font-size: 12px; }
  .mr-bar { height: 8px; margin: 4px 12px 2px; border-radius: 4px; background: rgba(255,255,255,.1); overflow: hidden; }
  .mr-bar > div { height: 100%; width: 0; background: #22b8e6; transition: width .6s; }
  .mr-barline { display: flex; justify-content: space-between; padding: 0 12px; font-size: 12px; opacity: .8; }
  .mr-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px 8px; padding: 8px 12px; }
  .mr-grid > div > span { display: block; font-size: 11px; opacity: .6; }
  .mr-grid > div > b { font-weight: 600; }
  .mr-cam { margin: 2px 0 0; background: #000; min-height: 40px; }
  .mr-cam[hidden] { display: none; }
  .mr-btns { display: flex; gap: 8px; padding: 8px 12px 10px; }
  .mr-btns[hidden], .mr-btns button[hidden] { display: none; }
  .mr-btns button { flex: 1; border: 1px solid rgba(127,208,255,.35); background: rgba(127,208,255,.08); color: inherit; border-radius: 8px; padding: 6px; font: inherit; cursor: pointer; }
  .mr-btns button.danger { border-color: rgba(229,34,46,.6); background: rgba(229,34,46,.15); }
  .mr-box { padding: 0 12px 6px; font-size: 12px; opacity: .85; }
  .mr-box[hidden] { display: none; }
`;

const DOT = { printing: "#22b8e6", paused: "#f0b429", complete: "#3ecf6e", cancelled: "#9aa5ab", error: "#e5222e", offline: "#4a5a63", off: "#4a5a63" };

async function cameraCard(hass, cameraId, live) {
  try {
    const helpers = await window.loadCardHelpers?.();
    if (helpers) {
      const card = helpers.createCardElement({ type: "picture-entity", entity: cameraId, camera_view: live ? "live" : "auto", show_name: false, show_state: false, tap_action: { action: "none" } });
      card.hass = hass;
      return card;
    }
  } catch {
    // the still picture below
  }
  const img = document.createElement("img");
  img.style.cssText = "display:block;width:100%";
  const pic = hass.states[cameraId]?.attributes.entity_picture;
  if (typeof pic === "string") img.src = pic;
  return img;
}

function el(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  parent?.append(e);
  return e;
}

/** Builds the window once; its `hass` setter fills in the values on every state change. */
function printerWindow(hass, entityId, settings) {
  const r = related(hass, entityId);
  const root = el("div", "mr");
  el("style", null, root).textContent = CSS;

  const top = el("div", "mr-top", root);
  const thumb = el("div", "mr-thumb", top);
  thumb.hidden = true;
  const head = el("div", "mr-head", top);
  const stateLine = el("div", "mr-state", head);
  const dot = el("span", "mr-dot", stateLine);
  const stateText = el("span", null, stateLine);
  const file = el("div", "mr-file", head);
  const msg = el("div", "mr-msg", head);

  const bar = el("div", "mr-bar", root);
  const fill = el("div", null, bar);
  const barLine = el("div", "mr-barline", root);
  const pct = el("span", null, barLine);
  const layerText = el("span", null, barLine);

  const grid = el("div", "mr-grid", root);
  const cell = (label) => {
    const c = el("div", null, grid);
    el("span", null, c).textContent = label;
    return el("b", null, c);
  };
  const left = cell(textOf(hass, "left"));
  const elapsed = cell(textOf(hass, "elapsed"));
  const finish = cell(textOf(hass, "finish"));
  const nozzle = cell(textOf(hass, "nozzle"));
  const bed = cell(textOf(hass, "bed"));
  const chamber = r.chamber ? cell(textOf(hass, "chamber")) : null;

  const box = el("div", "mr-box", root);
  box.hidden = true;

  const cam = el("div", "mr-cam", root);
  cam.hidden = true;
  let camEl = null;
  let camLoading = false;

  const btns = el("div", "mr-btns", root);
  const button = (key, cls) => {
    const b = el("button", cls, btns);
    b.type = "button";
    b.textContent = textOf(hass, key);
    return b;
  };
  const bPause = button("pause");
  const bResume = button("resume");
  const bCancel = button("cancel", "danger");
  const press = (id, ask) => {
    if (!id || !lastHass) return;
    if (ask && !confirm(ask.replace("{name}", r.name))) return;
    void lastHass.callService("button", "press", { entity_id: id });
  };
  bPause.addEventListener("click", () => press(r.pause, textOf(hass, "confirmPause")));
  bResume.addEventListener("click", () => press(r.resume, null));
  bCancel.addEventListener("click", () => press(r.cancel, textOf(hass, "confirmCancel")));

  const temp = (cur, target) => {
    const c = num(lastHass, cur);
    const t = num(lastHass, target);
    if (c === null) return "–";
    return t ? `${Math.round(c)} / ${Math.round(t)} °C` : `${Math.round(c)} °C`;
  };

  let lastHass = null;
  let thumbKey = null;
  const update = (h) => {
    lastHass = h;
    const s = printState(h, entityId);
    const busy = BUSY.has(s);
    const down = s === "off" || s === "offline";
    grid.style.display = down ? "none" : "";
    cam.hidden = down || !(settings.camera && r.camera);
    dot.style.background = DOT[s] ?? "#6b7f8a";
    stateText.textContent = textOf(h, s) ?? s;

    const name = stateOf(h, r.filename);
    file.textContent = !down && name && !DEAD.has(name) ? name.replace(/^.*\//, "") : "";
    const m = stateOf(h, r.message);
    msg.textContent = !busy && !down && m && !DEAD.has(m) ? m : "";

    const p = percent(h, r);
    const showBar = busy || s === "complete";
    bar.style.display = barLine.style.display = showBar ? "" : "none";
    fill.style.width = `${s === "complete" ? 100 : (p ?? 0)}%`;
    pct.textContent = p === null ? "" : `${(s === "complete" ? 100 : p).toFixed(p < 10 ? 1 : 0)}%`;
    const layer = num(h, r.layer);
    const layers = num(h, r.layers);
    layerText.textContent = layers ? `${textOf(h, "layer")} ${layer ?? 0} / ${layers}` : "";

    left.textContent = busy ? formatDuration(seconds(h, r.left)) : "–";
    elapsed.textContent = busy || s === "complete" ? formatDuration(seconds(h, r.elapsed)) : "–";
    finish.textContent = busy ? formatFinish(h, r.eta) : "–";
    nozzle.textContent = temp(r.nozzle, r.nozzleTarget);
    bed.textContent = temp(r.bed, r.bedTarget);
    if (chamber) chamber.textContent = temp(r.chamber, r.chamberTarget);

    const change = stateOf(h, r.boxChange);
    box.hidden = !change || DEAD.has(change) || change === "idle";
    if (!box.hidden) box.textContent = `${textOf(h, "box")}: ${change}`;

    // the slicer's picture of the file; the camera answers with an error while no file is loaded
    if (settings.thumbnail && r.thumbnail) {
      const pic = h.states[r.thumbnail]?.attributes.entity_picture;
      const key = !down && name && !DEAD.has(name) && typeof pic === "string" ? `${pic}|${name}` : null;
      if (key !== thumbKey) {
        thumbKey = key;
        thumb.hidden = true;
        if (key) {
          const img = new Image();
          img.onload = () => {
            if (thumbKey !== key) return;
            thumb.style.backgroundImage = `url("${img.src}")`;
            thumb.hidden = false;
          };
          img.src = `${pic}&file=${encodeURIComponent(name)}`;
        }
      }
    }

    btns.hidden = !settings.controls || !busy;
    bPause.hidden = s !== "printing" || !r.pause;
    bResume.hidden = s !== "paused" || !r.resume;
    bCancel.hidden = !r.cancel;

    if (!cam.hidden && !camEl && !camLoading) {
      camLoading = true;
      void cameraCard(h, r.camera, settings.camera_view === "live").then((c) => {
        camEl = c;
        if ("hass" in c && lastHass) c.hass = lastHass;
        cam.append(c);
      });
    }
    if (camEl && "hass" in camEl && !cam.hidden) camEl.hass = h;
  };
  update(hass);
  Object.defineProperty(root, "hass", { set: update });
  return root;
}

// ---------------------------------------------------------------------------------------------------------------
// The device

/** The printer whose window is open, so a second tap closes it (unless it was closed with its ✕ meanwhile). */
let openPrinter = null;
let openWindow = null;

const printer = {
  match: (entityId) => entityId.startsWith("sensor.") && entityId.endsWith(SUFFIX),
  kind: "sensor",
  settings: [
    { key: "thumbnail", label: both("thumbnail"), type: "boolean", default: true },
    { key: "camera", label: both("camera"), type: "boolean", default: true },
    { key: "camera_view", label: both("cameraView"), type: "select", default: "auto", options: [["auto", both("still")], ["live", both("live")]] },
    { key: "controls", label: both("controls"), type: "boolean", default: true, hint: both("controlsHint") },
  ],
  marker: ({ hass, entityId }) => {
    const r = related(hass, entityId);
    const s = printState(hass, entityId);
    const p = percent(hass, r);
    let text = "";
    if (s === "printing") {
      const left = seconds(hass, r.left);
      text = [p === null ? null : `${Math.floor(p)}%`, left ? formatDuration(left) : null].filter(Boolean).join(" · ");
    } else if (s === "paused") text = `${textOf(hass, "paused")}${p === null ? "" : ` · ${Math.floor(p)}%`}`;
    else if (s === "error") text = textOf(hass, "error");
    else if (s === "complete") text = textOf(hass, "complete");
    else if (s === "off") text = textOf(hass, "off");
    return { icon: "mdi:printer-3d-nozzle", text, active: BUSY.has(s) };
  },
  watch: ({ hass, entityId }) => {
    const r = related(hass, entityId);
    return [r.progress, r.left, r.printerState, r.power].filter(Boolean);
  },
  tap: ({ hass, entityId, settings, showWindow }) => {
    if (openPrinter === entityId && openWindow?.isConnected) {
      openPrinter = openWindow = null;
      showWindow(null);
      return true;
    }
    openPrinter = entityId;
    openWindow = printerWindow(hass, entityId, settings);
    showWindow(openWindow, { title: related(hass, entityId).name });
    return true;
  },
};

const plugin = {
  id: "moonraker",
  name: "Moonraker",
  version: "1.1.0",
  apiVersion: 1,
  devices: [printer],
};

// works whether NextFloor is already running or loads after this script
if (window.NextFloor) window.NextFloor.register(plugin);
else (window.__nextfloorPlugins ??= []).push(plugin);
