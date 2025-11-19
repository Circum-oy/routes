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
const destinationPoi = {
  name: "Visitor center",
  lon: 24.9765,
  lat: 60.1857,
  height: 5
};
let destinationEntity = null;
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
let drawRouteColor = "ORANGE";
let savedRoutesListEl = null;
let exportRoutesBtnEl = null;
let editingRouteId = null;
let storedRouteEntities = {};
const LOCAL_ROUTES_KEY = "viewerSavedRoutes";
let storedRoutes = loadRoutesFromStorage();
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
  addDestinationPoiMarker(destinationPoi);
  restoreStoredRoutesOnScene();

  } catch (e) {
    appendLog("3D-mallin lataus epäonnistui: " + e.message);
  }

  youEntity = viewer.entities.add({
    point: { pixelSize: 12, color: Cesium.Color.BLUE },
    label: {
      text: "Minä",
      pixelOffset: new Cesium.Cartesian2(0, -30),
      fillColor: Cesium.Color.BLACK,
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
    } else if (Cesium.defined(picked) && picked.id && picked.id.destinationPoi) {
      const poi = picked.id.destinationPoi;
      appendLog("Destination clicked: " + poi.name);
      planRouteFromUserLocation(poi);
    } else {
      setRouteInfo(null);
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

function addDestinationPoiMarker(poi) {
  if (!viewer || !poi) return;
  if (destinationEntity) {
    viewer.entities.remove(destinationEntity);
    destinationEntity = null;
  }
  destinationEntity = viewer.entities.add({
    name: poi.name,
    position: cart(poi.lon, poi.lat, poi.height || 0),
    billboard: {
      image: Cesium.buildModuleUrl("Assets/Textures/maki/marker.png"),
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      scale: 1.2
    },
    label: {
      text: poi.name,
      pixelOffset: new Cesium.Cartesian2(0, -40),
      scale: 0.6,
      fillColor: Cesium.Color.BLACK,
      showBackground: true
    }
  });
  destinationEntity.destinationPoi = poi;
  appendLog("Destination marker added: " + poi.name);
}

function clearPlannedRoute() {
  routeStart = null;
  routeEnd = null;
  if (routeStartEntity) { viewer.entities.remove(routeStartEntity); routeStartEntity=null;}
  if (routeEndEntity) { viewer.entities.remove(routeEndEntity); routeEndEntity=null;}
  if (currentRouteEntity) { viewer.entities.remove(currentRouteEntity); currentRouteEntity=null;}
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
    const pos = await clampPointToGround(pickedPos);
    if (!routeStart) {
      routeStart = pos;
      routeStartEntity = viewer.entities.add({
        position: cart(pos.lon, pos.lat, pos.height),
        point: { pixelSize: 10, color: Cesium.Color.GREEN }
      });
      appendLog("Start set.");
    } else if (!routeEnd) {
      routeEnd = pos;
      routeEndEntity = viewer.entities.add({
        position: cart(pos.lon, pos.lat, pos.height),
        point: { pixelSize: 10, color: Cesium.Color.RED }
      });
      appendLog("End set. Calculating route...");
      try {
        await planRoute(routeStart, routeEnd);
      } catch (error) {
        appendLog("Route planning failed: " + error.message);
      }
    } else {
      clearPlannedRoute();
      routeStart = pos;
      routeStartEntity = viewer.entities.add({
        position: cart(pos.lon, pos.lat, pos.height),
        point: { pixelSize: 10, color: Cesium.Color.GREEN }
      });
      appendLog("Previous plan cleared. Start redefined.");
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
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
  storedRoutes.forEach((route) => addOrUpdateStoredRouteEntity(route));
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

async function planRouteFromUserLocation(poi) {
  if (!viewer) {
    appendLog("Viewer not ready yet.");
    return;
  }
  if (!lastGps) {
    appendLog("No GPS fix yet. Allow location access and try again.");
    return;
  }
  const userGround = {
    lon: lastGps.lon,
    lat: lastGps.lat,
    height: lastGps.ground || 0
  };
  const destination = {
    lon: poi.lon,
    lat: poi.lat,
    height: poi.height || 0
  };

  const clampedStart = await clampPointToGround(userGround);
  const clampedEnd = await clampPointToGround(destination);

  clearPlannedRoute();

  routeStart = clampedStart;
  routeEnd = clampedEnd;

  routeStartEntity = viewer.entities.add({
    position: cart(clampedStart.lon, clampedStart.lat, (clampedStart.height || 0) + 1.5),
    point: { pixelSize: 12, color: Cesium.Color.LIME }
  });

  routeEndEntity = viewer.entities.add({
    position: cart(clampedEnd.lon, clampedEnd.lat, (clampedEnd.height || 0) + 1.5),
    point: { pixelSize: 12, color: Cesium.Color.RED }
  });

  await planRoute(clampedStart, clampedEnd);
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

async function planRoute(start, end) {
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

  if (currentRouteEntity) {
    viewer.entities.remove(currentRouteEntity);
    currentRouteEntity = null;
  }

  currentRouteEntity = viewer.entities.add({
    polyline: {
      positions,
      width: 4,
      material: new Cesium.PolylineGlowMaterialProperty({
        glowPower: 0.2,
        color: Cesium.Color.RED
      })
    }
  });

  const lengthMeters = metersBetweenPoints(positions);
  appendLog(
    "Planned terrain-aware route, length approx. " +
    lengthMeters.toFixed(0) +
    " m."
  );
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

  if (exportRoutesBtnEl) {
    exportRoutesBtnEl.onclick = exportStoredRoutes;
  }

  renderSavedRoutesList();
}

init().catch(e => appendLog("Virhe init(): " + e.message));
