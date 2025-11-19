async function handleGpsStartPlanning(pickedPos) {
  if (!lastGps) {
    appendLog("No GPS fix yet. Allow location access first.");
    return;
  }
  const startPoint = {
    lon: lastGps.lon,
    lat: lastGps.lat,
    height: lastGps.ground || 0
  };
  const start = await clampPointToGround(startPoint);
  await finalizePlanningWithStartEnd(start, pickedPos);
}

async function handleCustomStartPlanning(pickedPos) {
  const endPos = await clampPointToGround(pickedPos);
  if (!routeStart) {
    routeStart = endPos;
    routeStartEntity = viewer.entities.add({
      position: cart(endPos.lon, endPos.lat, (endPos.height || 0) + 1.5),
      point: { pixelSize: 12, color: Cesium.Color.LIME }
    });
    appendLog("Custom start set. Click again for the destination.");
    return;
  }
  await finalizePlanningWithStartEnd(routeStart, pickedPos);
}

async function finalizePlanningWithStartEnd(startPoint, pickedPos) {
  const endPos = await clampPointToGround(pickedPos);

  clearPlannedRoute();

  routeStart = startPoint;
  routeEnd = endPos;

  routeStartEntity = viewer.entities.add({
    position: cart(routeStart.lon, routeStart.lat, (routeStart.height || 0) + 1.5),
    point: { pixelSize: 12, color: Cesium.Color.LIME }
  });

  routeEndEntity = viewer.entities.add({
    position: cart(endPos.lon, endPos.lat, (endPos.height || 0) + 1.5),
    point: { pixelSize: 12, color: Cesium.Color.RED }
  });

  appendLog("End set. Calculating route...");
  try {
    await planRoute(routeStart, routeEnd);
  } catch (error) {
    appendLog("Route planning failed: " + error.message);
  }
}
let viewer, youEntity;
let heightOffsetValue = 0;
let lastGps = null;
let watchId = null; // continuous GPS updates

let routeStart = null;
let routeEnd = null;
let routeStartEntity = null;
let routeEndEntity = null;
let currentRouteEntity = null;
let clickHandler = null;
let planningMode = false;
let routePlanBtnEl = null;
let clearRouteBtnEl = null;
let pendingPlanningMode = null;
let drawingMode = false;
let drawPoints = [];
let drawPointEntities = [];
let drawPolylineEntity = null;
let drawStartBtnEl = null;
let drawUndoBtnEl = null;
let drawFinishBtnEl = null;
let drawColorSelectEl = null;
let drawSaveBtnEl = null;
let drawRemoveBtnEl = null;
let routeNameInputEl = null;
let startModeRadios = [];
let locationSearchInputEl = null;
let locationSearchBtnEl = null;
let drawRouteColor = "ORANGE";
let savedRoutesListEl = null;
let exportRoutesBtnEl = null;
let editingRouteId = null;
let storedRouteEntities = {};
const LOCAL_ROUTES_KEY = "viewerSavedRoutes";
let storedRoutes = loadRoutesFromStorage();
let baseConfigRoutes = [];
let graphNodes = new Map();
let graphAdjacency = new Map();
const TEMP_NODE_PREFIX = "_tempNode";
let followerEntity = null;
let followerAnimationHandle = null;
let followerAnimationState = null;
const ROUTE_FOLLOWER_SPEED_MPS = 12.0;
const DRAW_COLOR_MAP = {
  ORANGE: Cesium.Color.ORANGE,
  YELLOW: Cesium.Color.YELLOW,
  CYAN: Cesium.Color.CYAN,
  MAGENTA: Cesium.Color.MAGENTA,
  LIME: Cesium.Color.LIME,
  RED: Cesium.Color.RED,
  WHITE: Cesium.Color.WHITE
};

function setRouteInfo(route) {
  const container = document.getElementById("routeInfoContent");
  if (!container) return;

  if (!route) {
    container.textContent = "Click a route on the map to see details.";
    return;
  }

  container.innerHTML = `
    <strong>${route.name}</strong><br/>
    <small>${route.id}</small><br/><br/>
    ${route.description ? route.description : "No description."}
  `;
}

function appendLog(msg) {
  const el = document.getElementById("log");
  if (!el) return;
  el.textContent += "\n" + msg;
  el.scrollTop = el.scrollHeight;
}

async function loadConfig() {
  const res = await fetch("config.json");
  if (!res.ok) throw new Error("config.json ei latautunut");
  return res.json();
}

function cart(lon, lat, h=0) {
  return Cesium.Cartesian3.fromDegrees(lon, lat, h);
}

async function init() {
  appendLog("init() alkaa");

  setupUI();
  appendLog("UI kytketty");

  const cfg = await loadConfig();
  appendLog("config.json ladattu");
  baseConfigRoutes = Array.isArray(cfg.routes) ? cfg.routes : [];
  rebuildRouteGraph();

  viewer = new Cesium.Viewer("app", {
    terrain: cfg.useWorldTerrain ? Cesium.Terrain.fromWorldTerrain() : undefined,
    infoBox: false, selectionIndicator: false, geocoder: false,
    animation: false, timeline: false, homeButton: false, fullscreenButton: false
  });

  viewer.scene.camera.setView({
    destination: cart(
      cfg.startView.longitude,
      cfg.startView.latitude,
      cfg.startView.height
    ),
    orientation: {
      heading: Cesium.Math.toRadians(cfg.startView.heading),
      pitch: Cesium.Math.toRadians(cfg.startView.pitch),
      roll: Cesium.Math.toRadians(cfg.startView.roll)
    }
  });

  try {
    const tileset = await Cesium.Cesium3DTileset.fromIonAssetId(cfg.ionAssetId);
    viewer.scene.primitives.add(tileset);
    await tileset.readyPromise;

    viewer.camera.flyToBoundingSphere(tileset.boundingSphere, {
      duration: 2,
      offset: new Cesium.HeadingPitchRange(
        0,
        Cesium.Math.toRadians(-35),
        tileset.boundingSphere.radius * 2
      )
    });

    appendLog("3D-malli ladattu (Asset ID: " + cfg.ionAssetId + ")");
  // Initialize route info panel with default text
  setRouteInfo(null);

  // Add routes from config.json, if any
  if (cfg.routes && Array.isArray(cfg.routes)) {
    appendLog("Lisätään " + cfg.routes.length + " reittiä kartalle.");
    addRoutesToViewer(cfg.routes);
  } else {
    appendLog("Ei reittejä configissa.");
  }

  // Enable clicking on routes to show details
  setupRouteClickHandling();
  restoreStoredRoutesOnScene();

  } catch (e) {
    appendLog("3D-mallin lataus epäonnistui: " + e.message);
  }

  youEntity = viewer.entities.add({
    point: { pixelSize: 12, color: Cesium.Color.BLUE },
    label: {
      text: "My Location",
      pixelOffset: new Cesium.Cartesian2(0, -30),
      fillColor: Cesium.Color.WHITE,
      showBackground: true
    }
  });
  youEntity.show = false;

  markPlanningControlsReady();

  requestInitialPermission();
  startContinuousWatch();
}

function updateEntityFromLastGps() {
  if (!lastGps || !youEntity) return;
  const { lon, lat, ground } = lastGps;
  const height = ground + heightOffsetValue;
  const p = Cesium.Cartesian3.fromDegrees(lon, lat, height);
  youEntity.position = p;
  youEntity.show = true;
}

async function updatePosition(pos) {
  appendLog("GPS päivitys saatu");

  const lon = pos.coords.longitude;
  const lat = pos.coords.latitude;

  const carto = Cesium.Cartographic.fromDegrees(lon, lat);

  let terrain = await Cesium.sampleTerrainMostDetailed(
    viewer.terrainProvider,
    [carto]
  ).catch(() => [carto]);

  const ground = terrain[0].height || 0;
  lastGps = { lon, lat, ground };

  updateEntityFromLastGps();
}

function requestInitialPermission() {
  if (!navigator.geolocation) {
    appendLog("Geolocation ei ole saatavilla (initial).");
    return;
  }
  appendLog("Kysytään sijaintilupaa...");
  navigator.geolocation.getCurrentPosition(
    () => {
      appendLog("Sijaintilupa myönnetty.");
    },
    (err) => {
      appendLog("Sijaintilupa hylätty tai virhe: " + err.message);
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
  );
}

function startContinuousWatch() {
  if (!navigator.geolocation) {
    appendLog("Geolocation ei ole saatavilla (continuous).");
    return;
  }
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
  }
  appendLog("Aloitetaan jatkuva GPS-seuranta pistettä varten (ei kameraa)...");
  watchId = navigator.geolocation.watchPosition(
    updatePosition,
    (err) => appendLog("GPS virhe (continuous): " + err.message),
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
  );
}


function addRoutesToViewer(routes) {
  if (!viewer || !routes) return;

  routes.forEach(route => {
    if (!route.points || !route.points.length) return;

    const positions = route.points.map(p => cart(p.lon, p.lat, p.height || 0));
    const colorName = route.color || "YELLOW";
    const color = Cesium.Color[colorName] || Cesium.Color.YELLOW;

    const entity = viewer.entities.add({
      name: route.name,
      polyline: {
        positions: positions,
        width: 4,
        material: color
      }
    });

    // keep reference to route data so we can access it on click
    entity.routeData = route;
  });
}

function setupRouteClickHandling() {
  enableRouteInfoClicks();
}
function ensureClickHandler() {
  if (!viewer) return null;
  if (!clickHandler) {
    clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  }
  return clickHandler;
}
function enableRouteInfoClicks() {
  const handler = ensureClickHandler();
  if (!handler) return;
  handler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_CLICK);
  handler.setInputAction((movement) => {
    if (drawingMode) {
      handleDrawingClick(movement);
      return;
    }
    const picked = viewer.scene.pick(movement.position);
    if (Cesium.defined(picked) && picked.id && picked.id.routeData) {
      const route = picked.id.routeData;
      appendLog("Route clicked: " + route.name);
      setRouteInfo(route);
    } else {
      setRouteInfo(null);
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

function clearPlannedRoute() {
  routeStart = null;
  routeEnd = null;
  if (routeStartEntity) { viewer.entities.remove(routeStartEntity); routeStartEntity=null;}
  if (routeEndEntity) { viewer.entities.remove(routeEndEntity); routeEndEntity=null;}
  if (currentRouteEntity) { viewer.entities.remove(currentRouteEntity); currentRouteEntity=null;}
  stopRouteFollower();
  appendLog("Cleared planned route.");
}
function getClickPosition(movement) {
  const scene = viewer.scene;
  let cartesian = scene.pickPosition(movement.position);
  if (!Cesium.defined(cartesian)) {
    const ray = viewer.camera.getPickRay(movement.position);
    cartesian = scene.globe.pick(ray, scene);
  }
  if (!Cesium.defined(cartesian)) return null;
  const cartographic = Cesium.Cartographic.fromCartesian(cartesian);
  const lon = Cesium.Math.toDegrees(cartographic.longitude);
  const lat = Cesium.Math.toDegrees(cartographic.latitude);
  const height = cartographic.height;
  return {lon, lat, height};
}
async function clampPointToGround(position) {
  if (!viewer || !position) return position;
  const carto = Cesium.Cartographic.fromDegrees(position.lon, position.lat);
  try {
    const [sampled] = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, [carto]);
    if (sampled) {
      return { lon: Cesium.Math.toDegrees(sampled.longitude), lat: Cesium.Math.toDegrees(sampled.latitude), height: sampled.height || 0 };
    }
  } catch (e) {
    appendLog("Ground clamp failed, using picked height: " + e.message);
  }
  return position;
}

function updatePlanningButtonLabel() {
  if (!routePlanBtnEl) return;
  routePlanBtnEl.textContent = planningMode ? "Exit planning mode" : "Plan new route";
}

function setPlanningMode(enabled) {
  if (!viewer) {
    pendingPlanningMode = enabled;
    appendLog("Viewer not ready for planning yet. Your choice will be applied once loading finishes.");
    return;
  }
  pendingPlanningMode = null;
  if (planningMode === enabled) return;
  planningMode = enabled;
  if (planningMode) {
    clearPlannedRoute();
    enablePlanningClicks();
    appendLog("Route planning mode ON. Click once for start, again for end.");
  } else {
    enableRouteInfoClicks();
    appendLog("Route planning mode OFF. Click a saved route to view info.");
  }
  updatePlanningButtonLabel();
}

function enablePlanningClicks() {
  const handler = ensureClickHandler();
  if (!handler) return;
  handler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_CLICK);
  handler.setInputAction(async (movement) => {
    if (drawingMode) return;
    const pickedPos = getClickPosition(movement);
    if (!pickedPos) return;
    await handlePlanningClick(pickedPos);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

function getSelectedStartMode() {
  const selected = startModeRadios.find((radio) => radio.checked);
  return selected ? selected.value : "gps";
}

async function handlePlanningClick(pickedPos) {
  const startMode = getSelectedStartMode();
  if (startMode === "custom") {
    await handleCustomStartPlanning(pickedPos);
  } else {
    await handleGpsStartPlanning(pickedPos);
  }
}

function togglePlanningModeFromUI() {
  setPlanningMode(!planningMode);
}

function attachPlanningButtons(planBtn, clearBtn) {
  routePlanBtnEl = planBtn;
  clearRouteBtnEl = clearBtn;
  if (routePlanBtnEl) {
    routePlanBtnEl.onclick = togglePlanningModeFromUI;
  }
  if (clearRouteBtnEl) {
    clearRouteBtnEl.onclick = () => {
      clearPlannedRoute();
      if (planningMode) {
        appendLog("Route cleared. Pick start point again.");
      }
    };
  }
  setPlanningControlsEnabled(false);
}

function setPlanningControlsEnabled(enabled) {
  if (routePlanBtnEl) {
    routePlanBtnEl.disabled = !enabled;
    if (enabled) {
      updatePlanningButtonLabel();
    } else {
      routePlanBtnEl.textContent = "Loading route planner...";
    }
  }
  if (clearRouteBtnEl) {
    clearRouteBtnEl.disabled = !enabled;
  }
}

function markPlanningControlsReady() {
  setPlanningControlsEnabled(true);
  if (pendingPlanningMode !== null) {
    const desired = pendingPlanningMode;
    pendingPlanningMode = null;
    setPlanningMode(desired);
  }
}

function toggleDrawingModeFromUI() {
  setDrawingMode(!drawingMode);
}

function setDrawingMode(enabled) {
  if (!viewer) {
    appendLog("Viewer not ready yet.");
    return;
  }
  if (drawingMode === enabled) return;
  if (enabled) {
    setPlanningMode(false);
    enableRouteInfoClicks();
    if (drawPoints.length > 0) {
      clearCurrentDrawing();
    }
    appendLog("Route drawing mode ON. Click on the map to start a new drawing.");
  } else {
    finalizeCurrentDrawingSession();
    appendLog("Route drawing mode OFF.");
  }
  drawingMode = enabled;
  updateDrawingButtonsState();
}

function clearCurrentDrawing() {
  drawPoints = [];
  drawPointEntities.forEach((entity) => viewer.entities.remove(entity));
  drawPointEntities = [];
  if (drawPolylineEntity) {
    viewer.entities.remove(drawPolylineEntity);
    drawPolylineEntity = null;
  }
  if (!editingRouteId && routeNameInputEl) {
    routeNameInputEl.value = "";
  }
  updateDrawingButtonsState();
}

function finalizeCurrentDrawingSession() {
  if (drawPoints.length >= 2) {
    saveDrawingToScene(true);
    appendLog("Latest drawing saved before stopping.");
  } else if (drawPoints.length > 0) {
    clearCurrentDrawing();
    appendLog("Drawing had too few points and was cleared.");
  }
}

async function handleDrawingClick(movement) {
  if (!drawingMode) return;
  const pickedPos = getClickPosition(movement);
  if (!pickedPos) return;
  const pos = await clampPointToGround(pickedPos);
  drawPoints.push(pos);
  const marker = viewer.entities.add({
    position: cart(pos.lon, pos.lat, (pos.height || 0) + 1.5),
    point: {
      pixelSize: 10,
      color: Cesium.Color.fromCssColorString("#FF8800")
    }
  });
  drawPointEntities.push(marker);
  updateDrawingPolyline();
  updateDrawingButtonsState();
  appendLog(`Drawing point ${drawPoints.length} added.`);
}

function updateDrawingPolyline() {
  if (drawPolylineEntity) {
    viewer.entities.remove(drawPolylineEntity);
    drawPolylineEntity = null;
  }
  if (drawPoints.length < 2) return;
  const positions = drawPoints.map((p) =>
    cart(p.lon, p.lat, (p.height || 0) + 1.5)
  );
  const color = DRAW_COLOR_MAP[drawRouteColor] || Cesium.Color.ORANGE;
  drawPolylineEntity = viewer.entities.add({
    polyline: {
      positions,
      width: 5,
      material: new Cesium.PolylineOutlineMaterialProperty({
        color,
        outlineWidth: 2,
        outlineColor: Cesium.Color.BLACK
      })
    }
  });
}

function undoDrawingPoint() {
  if (!drawingMode || drawPoints.length === 0) {
    appendLog("No drawing points to undo.");
    return;
  }
  const removedPoint = drawPoints.pop();
  const entity = drawPointEntities.pop();
  if (entity) {
    viewer.entities.remove(entity);
  }
  updateDrawingPolyline();
  updateDrawingButtonsState();
  appendLog(
    `Removed last point at lon ${removedPoint.lon.toFixed(5)}, lat ${removedPoint.lat.toFixed(5)}.`
  );
}

async function finishDrawingRoute() {
  if (!drawingMode) {
    appendLog("Enable drawing mode first.");
    return;
  }
  if (drawPoints.length < 2) {
    appendLog("Add at least two points before exporting the route.");
    return;
  }
  const snippet = buildRouteSnippetFromDrawing();
  const copied = await copyTextToClipboard(snippet);
  if (copied) {
    appendLog("Route JSON copied to clipboard. Paste it into config.json.");
  } else {
    appendLog("Clipboard unavailable. Route JSON printed to console.");
  }
  console.log("New route snippet:", snippet);
}

function buildRouteSnippetFromDrawing() {
  const routeId = "route-" + Date.now();
  const route = {
    id: routeId,
    name: routeId,
    description: "Drawn route",
    color: drawRouteColor,
    points: drawPoints.map((p) => ({
      lon: Number(p.lon.toFixed(6)),
      lat: Number(p.lat.toFixed(6)),
      height: Number((p.height || 0).toFixed(2))
    }))
  };
  return JSON.stringify(route, null, 2);
}

async function copyTextToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {
    appendLog("Clipboard write failed: " + err.message);
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const success = document.execCommand("copy");
    document.body.removeChild(textarea);
    return success;
  } catch (err) {
    appendLog("Fallback copy failed: " + err.message);
    return false;
  }
}

function updateDrawingButtonsState() {
  if (drawStartBtnEl) {
    drawStartBtnEl.textContent = drawingMode ? "Stop drawing" : "Start drawing route";
  }
  if (drawUndoBtnEl) {
    drawUndoBtnEl.disabled = drawPoints.length === 0;
  }
  if (drawFinishBtnEl) {
    drawFinishBtnEl.disabled = drawPoints.length < 2;
  }
  if (drawSaveBtnEl) {
    drawSaveBtnEl.disabled = drawPoints.length < 2;
  }
  if (drawRemoveBtnEl) {
    const hasContent = drawPoints.length > 0 || drawPointEntities.length > 0 || storedRoutes.length > 0;
    drawRemoveBtnEl.disabled = !hasContent;
  }
}

function handleDrawColorChange(evt) {
  const value = (evt && evt.target && evt.target.value) || "ORANGE";
  drawRouteColor = DRAW_COLOR_MAP[value] ? value : "ORANGE";
  appendLog("Drawing color set to " + drawRouteColor + ".");
  updateDrawingPolyline();
}

function saveDrawingToScene(skipLog = false) {
  if (drawPoints.length < 2) {
    appendLog("Add at least two points before saving to the model.");
    return;
  }
  if (!viewer) {
    appendLog("Viewer not ready.");
    return;
  }

  const existingRoute = editingRouteId
    ? storedRoutes.find((route) => route.id === editingRouteId)
    : null;

  const defaultName = existingRoute
    ? existingRoute.name || existingRoute.id
    : `Route ${storedRoutes.length + 1}`;

  let routeNameFromField =
    routeNameInputEl && routeNameInputEl.value ? routeNameInputEl.value.trim() : "";
  if (!routeNameFromField && existingRoute) {
    routeNameFromField = existingRoute.name || existingRoute.id;
  }
  const routeName = routeNameFromField || defaultName;

  const routeId = existingRoute ? existingRoute.id : "route-" + Date.now();

  const serializedPoints = drawPoints.map((p) => ({
    lon: Number(p.lon.toFixed(6)),
    lat: Number(p.lat.toFixed(6)),
    height: Number((p.height || 0).toFixed(2))
  }));

  const routeRecord = {
    id: routeId,
    name: routeName,
    color: drawRouteColor,
    points: serializedPoints
  };

  if (existingRoute) {
    const idx = storedRoutes.findIndex((r) => r.id === routeId);
    if (idx >= 0) {
      storedRoutes[idx] = routeRecord;
    }
  } else {
    storedRoutes.push(routeRecord);
  }

  persistStoredRoutes();
  addOrUpdateStoredRouteEntity(routeRecord);

  if (!skipLog) {
    appendLog(`Route "${routeName}" saved to the 3D model.`);
  }

  editingRouteId = null;
  clearCurrentDrawing();
  if (routeNameInputEl) {
    routeNameInputEl.value = "";
  }
}

function removeAllDrawings() {
  clearCurrentDrawing();
  Object.keys(storedRouteEntities).forEach((routeId) => {
    const entity = storedRouteEntities[routeId];
    if (entity && viewer) {
      viewer.entities.remove(entity);
    }
  });
  storedRouteEntities = {};
  storedRoutes = [];
  persistStoredRoutes();
  editingRouteId = null;
  if (routeNameInputEl) {
    routeNameInputEl.value = "";
  }
  appendLog("All drawings removed.");
  updateDrawingButtonsState();
}

function loadRoutesFromStorage() {
  try {
    const raw = localStorage.getItem(LOCAL_ROUTES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn("Failed to load routes from storage:", err);
    return [];
  }
}

function persistStoredRoutes() {
  try {
    localStorage.setItem(LOCAL_ROUTES_KEY, JSON.stringify(storedRoutes));
  } catch (err) {
    appendLog("Unable to persist routes: " + err.message);
  }
  rebuildRouteGraph();
  renderSavedRoutesList();
  updateDrawingButtonsState();
}

function renderSavedRoutesList() {
  if (!savedRoutesListEl) return;
  savedRoutesListEl.innerHTML = "";
  if (!storedRoutes.length) {
    const empty = document.createElement("em");
    empty.textContent = "No saved routes yet.";
    savedRoutesListEl.appendChild(empty);
    return;
  }
  storedRoutes.forEach((route) => {
    const row = document.createElement("div");
    row.className = "saved-route-row";

    const label = document.createElement("span");
    label.textContent = `${route.name || route.id} (${route.color || "ORANGE"})`;
    row.appendChild(label);

    const editBtn = document.createElement("button");
    editBtn.textContent = "Edit";
    editBtn.onclick = () => loadRouteForEditing(route.id);
    row.appendChild(editBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.onclick = () => deleteStoredRoute(route.id);
    row.appendChild(deleteBtn);

    savedRoutesListEl.appendChild(row);
  });
}

function addOrUpdateStoredRouteEntity(route) {
  if (!viewer || !route || !route.points) return;
  if (storedRouteEntities[route.id]) {
    viewer.entities.remove(storedRouteEntities[route.id]);
  }
  const positions = route.points.map((p) =>
    cart(p.lon, p.lat, (p.height || 0) + 1.5)
  );
  const color = DRAW_COLOR_MAP[route.color] || Cesium.Color.ORANGE;
  const entity = viewer.entities.add({
    polyline: {
      positions,
      width: 4,
      material: new Cesium.PolylineGlowMaterialProperty({
        color,
        glowPower: 0.2
      })
    }
  });
  storedRouteEntities[route.id] = entity;
}

function restoreStoredRoutesOnScene() {
  if (!viewer) return;
  Object.keys(storedRouteEntities).forEach((routeId) => {
    const entity = storedRouteEntities[routeId];
    if (entity) {
      viewer.entities.remove(entity);
    }
  });
  storedRouteEntities = {};
  storedRoutes.forEach((route) => addOrUpdateStoredRouteEntity(route));
  rebuildRouteGraph();
}

function deleteStoredRoute(routeId) {
  const idx = storedRoutes.findIndex((route) => route.id === routeId);
  if (idx === -1) return;
  if (storedRouteEntities[routeId] && viewer) {
    viewer.entities.remove(storedRouteEntities[routeId]);
    delete storedRouteEntities[routeId];
  }
  storedRoutes.splice(idx, 1);
  persistStoredRoutes();
  if (editingRouteId === routeId) {
    editingRouteId = null;
    clearCurrentDrawing();
  }
  appendLog("Route removed.");
}

function loadRouteForEditing(routeId) {
  const route = storedRoutes.find((r) => r.id === routeId);
  if (!route) return;
  editingRouteId = routeId;
  setDrawingMode(true);
  drawRouteColor = route.color || "ORANGE";
  if (drawColorSelectEl) {
    drawColorSelectEl.value = drawRouteColor;
  }
  if (routeNameInputEl) {
    routeNameInputEl.value = route.name || route.id;
  }
  drawPoints = route.points.map((p) => ({ ...p }));
  rebuildDrawingVisualsFromPoints();
  appendLog(`Editing route "${route.name || route.id}".`);
}

function rebuildDrawingVisualsFromPoints() {
  drawPointEntities.forEach((entity) => viewer.entities.remove(entity));
  drawPointEntities = [];
  drawPoints.forEach((pos) => {
    const marker = viewer.entities.add({
      position: cart(pos.lon, pos.lat, (pos.height || 0) + 1.5),
      point: {
        pixelSize: 10,
        color: Cesium.Color.fromCssColorString("#FF8800")
      }
    });
    drawPointEntities.push(marker);
  });
  updateDrawingPolyline();
  updateDrawingButtonsState();
}

function exportStoredRoutes() {
  if (!storedRoutes.length) {
    appendLog("No routes to export.");
    return;
  }
  const blob = new Blob([JSON.stringify(storedRoutes, null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "saved-routes.json";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  appendLog("Routes exported.");
}

function startRouteFollower(positions) {
  stopRouteFollower();
  if (!viewer || !positions || positions.length < 2) return;

  const segmentLengths = [];
  let totalLength = 0;
  for (let i = 1; i < positions.length; i++) {
    const len = Cesium.Cartesian3.distance(positions[i - 1], positions[i]);
    segmentLengths.push(len);
    totalLength += len;
  }
  if (totalLength === 0) return;

  followerEntity = viewer.entities.add({
    position: positions[0],
    point: { pixelSize: 12, color: Cesium.Color.BLUE },
    label: {
      text: "Route bot",
      scale: 0.5,
      pixelOffset: new Cesium.Cartesian2(0, -22),
      showBackground: true
    }
  });

  followerAnimationState = {
    positions,
    segmentLengths,
    totalLength,
    duration: Math.max(totalLength / ROUTE_FOLLOWER_SPEED_MPS, 1),
    startTime: performance.now()
  };

  const step = (timestamp) => {
    if (!followerAnimationState || !followerEntity) return;
    const elapsed = (timestamp - followerAnimationState.startTime) / 1000;
    const t = Math.min(elapsed / followerAnimationState.duration, 1);
    const newPosition = getPositionAlongRoute(followerAnimationState, t);
    if (newPosition) {
      followerEntity.position = newPosition;
    }
    if (t >= 1) {
      followerAnimationState = null;
      followerAnimationHandle = null;
      return;
    }
    followerAnimationHandle = requestAnimationFrame(step);
  };

  followerAnimationHandle = requestAnimationFrame(step);
}

function getPositionAlongRoute(state, fraction) {
  if (!state || !state.positions || state.positions.length < 2) return null;
  const targetDistance = state.totalLength * fraction;
  if (targetDistance <= 0) {
    return Cesium.Cartesian3.clone(state.positions[0]);
  }
  let accumulated = 0;
  for (let i = 1; i < state.positions.length; i++) {
    const segmentLength = state.segmentLengths[i - 1];
    if (accumulated + segmentLength >= targetDistance) {
      const segmentFraction = (targetDistance - accumulated) / segmentLength;
      return Cesium.Cartesian3.lerp(
        state.positions[i - 1],
        state.positions[i],
        segmentFraction,
        new Cesium.Cartesian3()
      );
    }
    accumulated += segmentLength;
  }
  return Cesium.Cartesian3.clone(
    state.positions[state.positions.length - 1]
  );
}

function stopRouteFollower() {
  if (followerAnimationHandle) {
    cancelAnimationFrame(followerAnimationHandle);
    followerAnimationHandle = null;
  }
  followerAnimationState = null;
  if (followerEntity && viewer) {
    viewer.entities.remove(followerEntity);
  }
  followerEntity = null;
}

function attachDrawingButtons(startBtn, undoBtn, finishBtn, colorSelect, saveBtn, removeBtn) {
  drawStartBtnEl = startBtn;
  drawUndoBtnEl = undoBtn;
  drawFinishBtnEl = finishBtn;
  drawColorSelectEl = colorSelect;
  drawSaveBtnEl = saveBtn;
  drawRemoveBtnEl = removeBtn;

  if (drawStartBtnEl) {
    drawStartBtnEl.onclick = toggleDrawingModeFromUI;
  }
  if (drawUndoBtnEl) {
    drawUndoBtnEl.onclick = undoDrawingPoint;
  }
  if (drawFinishBtnEl) {
    drawFinishBtnEl.onclick = finishDrawingRoute;
  }
  if (drawColorSelectEl) {
    drawColorSelectEl.onchange = handleDrawColorChange;
  }
  if (drawSaveBtnEl) {
    drawSaveBtnEl.onclick = saveDrawingToScene;
  }
  if (drawRemoveBtnEl) {
    drawRemoveBtnEl.onclick = removeAllDrawings;
  }

  updateDrawingButtonsState();
}

function buildTerrainSampledPositions(start, end, samples = 32) {
  const cartographics = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const lon = Cesium.Math.lerp(start.lon, end.lon, t);
    const lat = Cesium.Math.lerp(start.lat, end.lat, t);
    cartographics.push(Cesium.Cartographic.fromDegrees(lon, lat));
  }
  return cartographics;
}

function metersBetweenPoints(positions) {
  if (!positions || positions.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < positions.length; i++) {
    total += Cesium.Cartesian3.distance(positions[i - 1], positions[i]);
  }
  return total;
}

function rebuildRouteGraph() {
  graphNodes = new Map();
  graphAdjacency = new Map();
  const combinedRoutes = [
    ...(Array.isArray(baseConfigRoutes) ? baseConfigRoutes : []),
    ...(Array.isArray(storedRoutes) ? storedRoutes : [])
  ];
  combinedRoutes.forEach((route) => addRouteToGraph(route));
}

function triggerLocationSearch() {
  if (!viewer) return;
  const query = locationSearchInputEl ? locationSearchInputEl.value.trim() : "";
  if (!query) {
    appendLog("Enter a place or coordinates to search.");
    return;
  }
  performLocationSearch(query).catch((err) =>
    appendLog("Search failed: " + err.message)
  );
}

async function performLocationSearch(query) {
  const coordResult = parseCoordinateQuery(query);
  if (coordResult) {
    flyCameraTo(coordResult.lon, coordResult.lat);
    appendLog(
      "Jumped to coordinates: " +
        coordResult.lat.toFixed(4) +
        ", " +
        coordResult.lon.toFixed(4)
    );
    return;
  }

  appendLog('Searching "' + query + '" ...');
  const url =
    "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" +
    encodeURIComponent(query);
  const response = await fetch(url, {
    headers: { Accept: "application/json" }
  });
  if (!response.ok) {
    throw new Error("Geocoding service error (" + response.status + ")");
  }
  const data = await response.json();
  if (!Array.isArray(data) || !data.length) {
    appendLog("No results for search.");
    return;
  }
  const hit = data[0];
  const lon = parseFloat(hit.lon);
  const lat = parseFloat(hit.lat);
  if (Number.isNaN(lon) || Number.isNaN(lat)) {
    appendLog("Search result missing coordinates.");
    return;
  }
  flyCameraTo(lon, lat);
  appendLog('Focused on "' + (hit.display_name || query) + '".');
}

function parseCoordinateQuery(query) {
  const parts = query.split(",").map((p) => p.trim());
  if (parts.length !== 2) return null;
  const first = parseFloat(parts[0]);
  const second = parseFloat(parts[1]);
  if (Number.isNaN(first) || Number.isNaN(second)) return null;
  // assume lat, lon if first within latitude bounds, otherwise lon, lat
  if (Math.abs(first) <= 90 && Math.abs(second) <= 180) {
    return { lat: first, lon: second };
  }
  if (Math.abs(second) <= 90 && Math.abs(first) <= 180) {
    return { lat: second, lon: first };
  }
  return null;
}

function flyCameraTo(lon, lat) {
  if (!viewer) return;
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, 800),
    duration: 1.5
  });
}

function addRouteToGraph(route) {
  if (!route || !route.points || route.points.length === 0) return;
  const routeId = route.id || `route-${Math.random().toString(36).slice(2)}`;
  route.points.forEach((pt, idx) => {
    const nodeId = `${routeId}:${idx}`;
    const height = pt.height || 0;
    const cartesian = cart(pt.lon, pt.lat, height + 1.5);
    graphNodes.set(nodeId, {
      id: nodeId,
      lon: pt.lon,
      lat: pt.lat,
      height,
      cart: cartesian
    });
    if (!graphAdjacency.has(nodeId)) {
      graphAdjacency.set(nodeId, []);
    }
    if (idx > 0) {
      const prevId = `${routeId}:${idx - 1}`;
      const prevNode = graphNodes.get(prevId);
      if (!prevNode) return;
      const dist = Cesium.Cartesian3.distance(prevNode.cart, cartesian);
      graphAdjacency.get(nodeId).push({ id: prevId, weight: dist });
      if (!graphAdjacency.has(prevId)) {
        graphAdjacency.set(prevId, []);
      }
      graphAdjacency.get(prevId).push({ id: nodeId, weight: dist });
    }
  });
}

function findNearestGraphNodes(position, count = 3) {
  if (!position || !graphNodes.size) return [];
  const referenceCart = cart(position.lon, position.lat, (position.height || 0) + 1.5);
  const distances = [];
  graphNodes.forEach((node) => {
    const dist = Cesium.Cartesian3.distance(referenceCart, node.cart);
    distances.push({ node, dist });
  });
  distances.sort((a, b) => a.dist - b.dist);
  return distances.slice(0, count);
}

function computeNetworkRoute(start, end) {
  if (!graphNodes.size) return null;
  const adjacency = new Map();
  graphAdjacency.forEach((edges, key) => {
    adjacency.set(
      key,
      edges.map((edge) => ({ id: edge.id, weight: edge.weight }))
    );
  });
  const nodes = new Map();
  graphNodes.forEach((node, key) => {
    nodes.set(key, { ...node });
  });

  const startId = `${TEMP_NODE_PREFIX}-start-${Date.now()}`;
  const endId = `${TEMP_NODE_PREFIX}-end-${Date.now()}`;
  const startCart = cart(start.lon, start.lat, (start.height || 0) + 1.5);
  const endCart = cart(end.lon, end.lat, (end.height || 0) + 1.5);

  nodes.set(startId, { id: startId, lon: start.lon, lat: start.lat, height: start.height || 0, cart: startCart });
  nodes.set(endId, { id: endId, lon: end.lon, lat: end.lat, height: end.height || 0, cart: endCart });
  adjacency.set(startId, []);
  adjacency.set(endId, []);

  const startNeighbors = findNearestGraphNodes(start, 3);
  const endNeighbors = findNearestGraphNodes(end, 3);
  if (!startNeighbors.length || !endNeighbors.length) return null;

  startNeighbors.forEach(({ node, dist }) => {
    adjacency.get(startId).push({ id: node.id, weight: dist });
    if (!adjacency.has(node.id)) adjacency.set(node.id, []);
    adjacency.get(node.id).push({ id: startId, weight: dist });
  });

  endNeighbors.forEach(({ node, dist }) => {
    adjacency.get(endId).push({ id: node.id, weight: dist });
    if (!adjacency.has(node.id)) adjacency.set(node.id, []);
    adjacency.get(node.id).push({ id: endId, weight: dist });
  });

  const pathIds = dijkstra(adjacency, startId, endId);
  if (!pathIds || pathIds.length < 2) return null;

  const positions = pathIds
    .map((id) => nodes.get(id))
    .filter(Boolean)
    .map((node) => node.cart);

  return {
    positions,
    lengthMeters: metersBetweenPoints(positions),
    mode: "network"
  };
}

function dijkstra(adjacency, startId, endId) {
  const distances = new Map();
  const previous = new Map();
  const unvisited = new Set(adjacency.keys());

  adjacency.forEach((_, key) => {
    distances.set(key, key === startId ? 0 : Infinity);
  });

  while (unvisited.size > 0) {
    let currentId = null;
    let smallestDistance = Infinity;
    unvisited.forEach((nodeId) => {
      const dist = distances.get(nodeId);
      if (dist < smallestDistance) {
        smallestDistance = dist;
        currentId = nodeId;
      }
    });

    if (currentId === null) break;
    if (currentId === endId) break;

    unvisited.delete(currentId);
    const neighbors = adjacency.get(currentId) || [];
    neighbors.forEach(({ id: neighborId, weight }) => {
      if (!unvisited.has(neighborId)) return;
      const alt = distances.get(currentId) + weight;
      if (alt < distances.get(neighborId)) {
        distances.set(neighborId, alt);
        previous.set(neighborId, currentId);
      }
    });
  }

  if (!previous.has(endId) && startId !== endId) return null;

  const path = [];
  let current = endId;
  path.push(current);
  while (current !== startId) {
    current = previous.get(current);
    if (!current) return null;
    path.push(current);
  }
  return path.reverse();
}

async function planRoute(start, end) {
  if (!viewer) return;
  stopRouteFollower();

  let routeResult = null;
  const networkRoute = computeNetworkRoute(start, end);
  if (networkRoute && networkRoute.positions && networkRoute.positions.length >= 2) {
    routeResult = networkRoute;
  } else {
    routeResult = await buildTerrainLineRoute(start, end);
  }

  if (!routeResult || !routeResult.positions || routeResult.positions.length < 2) {
    appendLog("Unable to compute route between selected points.");
    return;
  }

  if (currentRouteEntity) {
    viewer.entities.remove(currentRouteEntity);
    currentRouteEntity = null;
  }

  const color =
    routeResult.mode === "network" ? Cesium.Color.CYAN : Cesium.Color.RED;

  currentRouteEntity = viewer.entities.add({
    polyline: {
      positions: routeResult.positions,
      width: 4,
      material: new Cesium.PolylineGlowMaterialProperty({
        glowPower: 0.2,
        color
      })
    }
  });

  startRouteFollower(routeResult.positions);

  appendLog(
    `${routeResult.mode === "network" ? "Network" : "Direct"} route, length approx. ` +
      routeResult.lengthMeters.toFixed(0) +
      " m."
  );
}

async function buildTerrainLineRoute(start, end) {
  const samples = buildTerrainSampledPositions(start, end, 48);
  let terrain;
  try {
    terrain = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, samples);
  } catch (e) {
    appendLog("Terrain samples failed, falling back to straight line: " + e.message);
    terrain = samples;
  }

  const positions = terrain.map((carto) => {
    const height = carto.height || 0;
    return Cesium.Cartesian3.fromRadians(
      carto.longitude,
      carto.latitude,
      height + 1.5
    );
  });

  return {
    positions,
    lengthMeters: metersBetweenPoints(positions),
    mode: "direct"
  };
}

function setupUI() {
  const locateBtn = document.getElementById("locateBtn");
  const slider = document.getElementById("heightOffset");
  const label = document.getElementById("heightValue");
  const planBtn = document.getElementById("routePlanBtn");
  const clearRouteBtn = document.getElementById("clearRouteBtn");
  const drawRouteBtn = document.getElementById("drawRouteBtn");
  const drawUndoBtn = document.getElementById("drawUndoBtn");
  const drawFinishBtn = document.getElementById("drawFinishBtn");
  const drawColorSelect = document.getElementById("drawColorSelect");
  const drawSaveBtn = document.getElementById("drawSaveBtn");
  const drawRemoveBtn = document.getElementById("drawRemoveBtn");
  routeNameInputEl = document.getElementById("routeNameInput");
  startModeRadios = Array.from(document.querySelectorAll('input[name="startMode"]'));
  locationSearchInputEl = document.getElementById("locationSearchInput");
  locationSearchBtnEl = document.getElementById("locationSearchBtn");
  savedRoutesListEl = document.getElementById("savedRoutesList");
  exportRoutesBtnEl = document.getElementById("exportRoutesBtn");

  if (locateBtn) {
    locateBtn.onclick = () => {
      appendLog("Missä olen? -nappia painettu");
      if (!navigator.geolocation) {
        appendLog("Geolocation ei ole saatavilla (Missä olen?).");
        return;
      }
      if (lastGps && youEntity && youEntity.position) {
        appendLog("Käytetään viimeisintä tunnettua sijaintia kameran keskitykseen.");
        const p = youEntity.position.getValue(new Cesium.JulianDate());
        viewer.camera.flyTo({ destination: p, duration: 1.0 });
      } else {
        appendLog("Ei vielä GPS-sijaintia, pyydetään yksi kerta (getCurrentPosition)...");
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            appendLog("Single GPS fix saatu (Missä olen?)");
            updatePosition(pos);
            if (youEntity && youEntity.position) {
              const p = youEntity.position.getValue(new Cesium.JulianDate());
              viewer.camera.flyTo({ destination: p, duration: 1.0 });
            }
          },
          (err) => {
            appendLog("GPS virhe (Missä olen?): " + err.message);
          },
          { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
        );
      }
    };
  }

  if (slider && label) {
    slider.oninput = () => {
      heightOffsetValue = Number(slider.value);
      label.textContent = heightOffsetValue;
      appendLog("Korkeus offset: " + heightOffsetValue + " m");
      updateEntityFromLastGps();
    };
  }

  attachPlanningButtons(planBtn, clearRouteBtn);
  attachDrawingButtons(drawRouteBtn, drawUndoBtn, drawFinishBtn, drawColorSelect, drawSaveBtn, drawRemoveBtn);

  if (startModeRadios.length) {
    startModeRadios.forEach((radio) => {
      radio.onchange = () => {
        appendLog(
          radio.value === "gps"
            ? "Start mode set to GPS. Only click destination."
            : "Start mode set to Custom. Click start point first."
        );
      };
    });
  }

  if (locationSearchBtnEl) {
    locationSearchBtnEl.onclick = () => triggerLocationSearch();
  }
  if (locationSearchInputEl) {
    locationSearchInputEl.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        triggerLocationSearch();
      }
    });
  }

  if (exportRoutesBtnEl) {
    exportRoutesBtnEl.onclick = exportStoredRoutes;
  }

  renderSavedRoutesList();
}

init().catch(e => appendLog("Virhe init(): " + e.message));
