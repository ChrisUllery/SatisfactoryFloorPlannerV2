const canvas = document.getElementById("plannerCanvas");
const ctx = canvas.getContext("2d");

const machineSelect = document.getElementById("machineSelect");
const recipeSearch = document.getElementById("recipeSearch");
const addMachineBtn = document.getElementById("addMachineBtn");
const plannerViewBtn = document.getElementById("plannerViewBtn");
const summaryViewBtn = document.getElementById("summaryViewBtn");
const selectedInfo = document.getElementById("selectedInfo");
const importFactoryFile = document.getElementById("importFactoryFile");
const importFactoryBtn = document.getElementById("importFactoryBtn");
const summaryViewEl = document.getElementById("summaryView");
const summaryCardsEl = document.getElementById("summaryCards");
const summaryTableBody = document.querySelector("#summaryTable tbody");
const summaryPreviewCanvas = document.getElementById("summaryPreviewCanvas");
const summaryPreviewCtx = summaryPreviewCanvas
  ? summaryPreviewCanvas.getContext("2d")
  : null;
const exportSummaryPdfBtn = document.getElementById("exportSummaryPdfBtn");
const FOUNDATION_SIZE = 8;
const SNAP_SIZE = 0.5;
const MIN_ZOOM = 4;
const MAX_ZOOM = 80;

let machineCatalog = {};

const GAME_DATA_PATH = "data/game_data.json";

let gameData = null;

const MACHINE_FOOTPRINTS = {
  "Constructor": { width: 8, length: 6 },
  "Smelter": { width: 9, length: 6 },
  "Foundry": { width: 10, length: 9 },
  "Assembler": { width: 15, length: 10 },
  "Manufacturer": { width: 18, length: 10 },
  "Refinery": { width: 20, length: 10 },
  "Packager": { width: 8, length: 8 },
  "Blender": { width: 18, length: 16 },
  "Particle Accelerator": { width: 30, length: 30 },
  "Fuel-Powered Generator": { width: 18, length: 16 },
  "Coal-Powered Generator": { width: 18, length: 16 },
  "Water Extractor": { width: 20, length: 14 },
  "Miner": { width: 8, length: 8 },
  "Oil Extractor": { width: 10, length: 10 },
  "Resource Well Extractor": { width: 8, length: 8 },
  "Quantum Encoder": { width: 24, length: 20 },
  "Converter": { width: 16, length: 16 },
  "Space Elevator": { width: 40, length: 40 }
};

async function loadGameData() {
  if (gameData) return gameData;

  const response = await fetch(GAME_DATA_PATH);
  if (!response.ok) {
    throw new Error(`Could not load ${GAME_DATA_PATH}`);
  }

  gameData = await response.json();
  return gameData;
}

function parseFraction(value) {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value === "number") return value;

  const str = String(value).trim();

  if (str.includes("/")) {
    const [a, b] = str.split("/").map(Number);
    return a / b;
  }

  return Number(str);
}

function getRecipeMaps(data) {
  const recipeMap = new Map();
  const machineMap = new Map();

  for (const recipe of data.Recipes || []) {
    recipeMap.set(recipe.Name, recipe);
  }

  for (const machine of data.Machines || []) {
    machineMap.set(machine.Name, machine);
  }

  return { recipeMap, machineMap };
}

function getPositivePartsPerMinute(recipe) {
  const batchTime = parseFraction(recipe.BatchTime);
  if (!batchTime) return {};

  const output = {};

  for (const part of recipe.Parts || []) {
    const amount = parseFraction(part.Amount);
    if (amount > 0) {
      output[part.Part] = (output[part.Part] || 0) + (amount / batchTime) * 60;
    }
  }

  return output;
}

function getNegativePartsPerMinute(recipe) {
  const batchTime = parseFraction(recipe.BatchTime);
  if (!batchTime) return {};

  const input = {};

  for (const part of recipe.Parts || []) {
    const amount = parseFraction(part.Amount);
    if (amount < 0) {
      input[part.Part] = (input[part.Part] || 0) + (Math.abs(amount) / batchTime) * 60;
    }
  }

  return input;
}

function getMainMachineName(recipe) {
  return recipe?.Machine || "Unknown";
}

function getParserFootprint(machineName) {
  return MACHINE_FOOTPRINTS[machineName] || { width: 10, length: 10 };
}

function chooseGrid(count) {
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  return { rows, cols };
}

function getBlockEstimate(machineName, roundedCount, gap) {
  const footprint = getParserFootprint(machineName);
  const { rows, cols } = chooseGrid(roundedCount);

  const totalWidth = cols * footprint.width + Math.max(0, cols - 1) * gap;
  const totalLength = rows * footprint.length + Math.max(0, rows - 1) * gap;

  return {
    rows,
    cols,
    width: totalWidth,
    length: totalLength
  };
}

function buildNodeState(sfmd, recipeMap) {
  return sfmd.Data.map((node, index) => {
    const recipe = recipeMap.get(node.Name);

    if (!recipe) {
      return {
        index,
        node,
        recipe: null,
        outputsPerMinute: {},
        inputsPerMinute: {},
        machineCountExact: 0,
        outputDemands: {},
        warnings: [`Recipe "${node.Name}" not found in game_data.json`]
      };
    }

    return {
      index,
      node,
      recipe,
      outputsPerMinute: getPositivePartsPerMinute(recipe),
      inputsPerMinute: getNegativePartsPerMinute(recipe),
      machineCountExact: 0,
      outputDemands: {},
      warnings: []
    };
  });
}

function addDemandToNode(nodes, nodeIndex, partName, ppm) {
  const state = nodes[nodeIndex];
  if (!state || !state.recipe) return;

  state.outputDemands[partName] = (state.outputDemands[partName] || 0) + ppm;

  const outputRate = state.outputsPerMinute[partName];
  if (!outputRate || outputRate <= 0) {
    state.warnings.push(`No output rate found for part "${partName}"`);
    return;
  }

  const requiredMachineCount = state.outputDemands[partName] / outputRate;
  const previousMachineCount = state.machineCountExact;

  if (requiredMachineCount <= previousMachineCount + 1e-9) {
    return;
  }

  const deltaMachines = requiredMachineCount - previousMachineCount;
  state.machineCountExact = requiredMachineCount;

  for (const [inputPart, inputRatePerMachine] of Object.entries(state.inputsPerMinute)) {
    const totalAdditionalInput = inputRatePerMachine * deltaMachines;
    const upstreamList = state.node.Inputs?.[inputPart] || [];

    if (upstreamList.length === 0) {
      continue;
    }

    const splitDemand = totalAdditionalInput / upstreamList.length;

    for (const upstreamIndex of upstreamList) {
      addDemandToNode(nodes, upstreamIndex, inputPart, splitDemand);
    }
  }
}

function solveFactory(sfmd, gameData) {
  const { recipeMap } = getRecipeMaps(gameData);
  const nodes = buildNodeState(sfmd, recipeMap);

  for (const state of nodes) {
    const maxMachines = parseFraction(state.node.Max);
    if (maxMachines > 0 && state.recipe) {
      state.machineCountExact = maxMachines;

      for (const [inputPart, inputRatePerMachine] of Object.entries(state.inputsPerMinute)) {
        const totalInputPpm = inputRatePerMachine * maxMachines;
        const upstreamList = state.node.Inputs?.[inputPart] || [];

        if (upstreamList.length === 0) continue;

        const splitDemand = totalInputPpm / upstreamList.length;

        for (const upstreamIndex of upstreamList) {
          addDemandToNode(nodes, upstreamIndex, inputPart, splitDemand);
        }
      }
    }
  }

  return nodes;
}

function computeNodeDepths(nodes) {
  const depths = new Array(nodes.length).fill(0);
  const visited = new Array(nodes.length).fill(false);

  function getDepth(i) {
    if (visited[i]) return depths[i];
    visited[i] = true;

    const node = nodes[i];
    if (!node.recipe) return 0;

    let maxDepth = 0;

    for (const inputs of Object.values(node.node.Inputs || {})) {
      for (const upstreamIndex of inputs) {
        maxDepth = Math.max(maxDepth, getDepth(upstreamIndex) + 1);
      }
    }

    depths[i] = maxDepth;
    return maxDepth;
  }

  nodes.forEach((_, i) => getDepth(i));
  return depths;
}

function buildRecipeSummaryFromSfmd(sfmd, gameData, gap = 1) {
  const solvedNodes = solveFactory(sfmd, gameData);
  const grouped = new Map();
  const depths = computeNodeDepths(solvedNodes);
  const EXCLUDED_MACHINES = ["Miner", "Water Extractor", "Resource Well Extractor", "Oil Extractor"];

  for (const nodeState of solvedNodes) {
    if (!nodeState.recipe || nodeState.machineCountExact <= 0) continue;

    const machineName = getMainMachineName(nodeState.recipe);
    if (EXCLUDED_MACHINES.includes(machineName)) {
      continue;
    }

    const recipeName = nodeState.recipe.Name;
    const nodeDepth = depths[nodeState.index] ?? 0;

    if (!grouped.has(recipeName)) {
      grouped.set(recipeName, {
        recipeName,
        machineName,
        exactMachines: 0,
        warnings: [],
        depthTotal: 0,
        depthCount: 0,
        maxDepth: 0
      });
    }

    const group = grouped.get(recipeName);
    group.exactMachines += nodeState.machineCountExact;
    group.warnings.push(...nodeState.warnings);
    group.depthTotal += nodeDepth;
    group.depthCount += 1;
    group.maxDepth = Math.max(group.maxDepth, nodeDepth);
  }

  return Array.from(grouped.values())
    .map(group => {
      const roundedMachines = Math.ceil(group.exactMachines);
      const footprint = getParserFootprint(group.machineName);
      const block = getBlockEstimate(group.machineName, roundedMachines, gap);
      const avgDepth = group.depthCount ? group.depthTotal / group.depthCount : 0;

      return {
        ...group,
        avgDepth,
        roundedMachines,
        footprint,
        block
      };
    })
    .sort((a, b) => {
      if (a.avgDepth !== b.avgDepth) {
        return a.avgDepth - b.avgDepth;
      }

      if (a.roundedMachines !== b.roundedMachines) {
        return b.roundedMachines - a.roundedMachines;
      }

      return a.recipeName.localeCompare(b.recipeName);
    });
}

async function loadMachineCatalog() {
  const response = await fetch("data/machines.json");
  machineCatalog = await response.json();
}

const state = {
  camera: {
    x: 0,
    y: 0,
    zoom: 20
  },
  machines: [],
  selectedMachineIds: [],
  clipboard: [],
  dragMode: null,
  dragStartScreen: { x: 0, y: 0 },
  machineDragOffsets: [],
  marqueeRect: null,
  isDragging: false,
  viewMode: "planner",
  lastImportedRows: null
};

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * window.devicePixelRatio;
  canvas.height = rect.height * window.devicePixelRatio;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  draw();
}

function worldToScreen(wx, wy) {
  return {
    x: wx * state.camera.zoom + state.camera.x,
    y: wy * state.camera.zoom + state.camera.y
  };
}

function screenToWorld(sx, sy) {
  return {
    x: (sx - state.camera.x) / state.camera.zoom,
    y: (sy - state.camera.y) / state.camera.zoom
  };
}

function snap(value) {
  return Math.round(value / SNAP_SIZE) * SNAP_SIZE;
}

function snapPosition(x, y) {
  return {
    x: snap(x),
    y: snap(y)
  };
}

function getMachineDefinition(type) {
  return machineCatalog[type] || null;
}

function getMachineById(id) {
  return state.machines.find(machine => machine.id === id) || null;
}

function getSelectedMachines() {
  return state.selectedMachineIds
    .map(id => getMachineById(id))
    .filter(Boolean);
}

function getPrimarySelectedMachine() {
  const selected = getSelectedMachines();
  return selected.length === 1 ? selected[0] : null;
}

function isMachineSelected(id) {
  return state.selectedMachineIds.includes(id);
}

function clearSelection() {
  state.selectedMachineIds = [];
}

function setSelection(ids) {
  state.selectedMachineIds = [...ids];
}

function addToSelection(id) {
  if (!state.selectedMachineIds.includes(id)) {
    state.selectedMachineIds.push(id);
  }
}

function getMachineFootprint(machine) {
  const rotated = machine.rotation % 180 !== 0;
  return {
    width: rotated ? machine.length : machine.width,
    length: rotated ? machine.width : machine.length
  };
}

function getMachineBounds(
  machine,
  overrideX = machine.x,
  overrideY = machine.y,
  overrideRotation = machine.rotation
) {
  const rotated = overrideRotation % 180 !== 0;
  const width = rotated ? machine.length : machine.width;
  const length = rotated ? machine.width : machine.length;

  return {
    left: overrideX,
    top: overrideY,
    right: overrideX + width,
    bottom: overrideY + length,
    width,
    length
  };
}

function getMachineBufferRects(
  machine,
  overrideX = machine.x,
  overrideY = machine.y,
  overrideRotation = machine.rotation
) {
  if (machine.isGroup) {
    return {
      input: null,
      output: null
    };
  }

  const bounds = getMachineBounds(machine, overrideX, overrideY, overrideRotation);
  const bufferDepth = 1;
  const rotation = ((overrideRotation % 360) + 360) % 360;

  const topRect = {
    left: bounds.left,
    right: bounds.right,
    top: bounds.top - bufferDepth,
    bottom: bounds.top
  };

  const bottomRect = {
    left: bounds.left,
    right: bounds.right,
    top: bounds.bottom,
    bottom: bounds.bottom + bufferDepth
  };

  const leftRect = {
    left: bounds.left - bufferDepth,
    right: bounds.left,
    top: bounds.top,
    bottom: bounds.bottom
  };

  const rightRect = {
    left: bounds.right,
    right: bounds.right + bufferDepth,
    top: bounds.top,
    bottom: bounds.bottom
  };

  // Base rule:
  // 0°   = input top,    output bottom
  // 90°  = input right,  output left
  // 180° = input bottom, output top
  // 270° = input left,   output right

  if (rotation === 0) {
    return { input: topRect, output: bottomRect };
  }

  if (rotation === 90) {
    return { input: rightRect, output: leftRect };
  }

  if (rotation === 180) {
    return { input: bottomRect, output: topRect };
  }

  if (rotation === 270) {
    return { input: leftRect, output: rightRect };
  }

  return { input: topRect, output: bottomRect };
}

function getMachineOccupiedRects(
  machine,
  overrideX = machine.x,
  overrideY = machine.y,
  overrideRotation = machine.rotation
) {
  const bounds = getMachineBounds(machine, overrideX, overrideY, overrideRotation);

  if (machine.isGroup) {
    return [bounds];
  }

  const buffers = getMachineBufferRects(machine, overrideX, overrideY, overrideRotation);

  return [
    bounds,
    buffers.input,
    buffers.output
  ].filter(Boolean);
}

function rectSetsOverlap(rectsA, rectsB) {
  for (const rectA of rectsA) {
    for (const rectB of rectsB) {
      if (rectanglesOverlap(rectA, rectB)) {
        return true;
      }
    }
  }
  return false;
}

function wouldMachineOverlap(
  machine,
  testX = machine.x,
  testY = machine.y,
  testRotation = machine.rotation,
  ignoreIds = []
) {
  const testRects = getMachineOccupiedRects(machine, testX, testY, testRotation);

  for (const other of state.machines) {
    if (other.id === machine.id) continue;
    if (ignoreIds.includes(other.id)) continue;

    const otherRects = getMachineOccupiedRects(other);

    if (rectSetsOverlap(testRects, otherRects)) {
      return true;
    }
  }

  return false;
}

function rectanglesOverlap(a, b) {
  const separated =
    a.right <= b.left ||
    a.left >= b.right ||
    a.bottom <= b.top ||
    a.top >= b.bottom;

  return !separated;
}

function canPlaceMachine(machine, testX = machine.x, testY = machine.y, testRotation = machine.rotation) {
  return !wouldMachineOverlap(machine, testX, testY, testRotation);
}

function findOpenPlacement(machine, originX, originY, maxRadius = 40) {
  const start = snapPosition(originX, originY);

  if (canPlaceMachine(machine, start.x, start.y, machine.rotation)) {
    return start;
  }

  for (let radius = 1; radius <= maxRadius; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        const onRing = Math.abs(dx) === radius || Math.abs(dy) === radius;
        if (!onRing) continue;

        const testX = snap(start.x + dx * SNAP_SIZE);
        const testY = snap(start.y + dy * SNAP_SIZE);

        if (canPlaceMachine(machine, testX, testY, machine.rotation)) {
          return { x: testX, y: testY };
        }
      }
    }
  }

  return null;
}

function updateSelectedInfo() {
  const selected = getSelectedMachines();

  if (selected.length === 0) {
    selectedInfo.textContent = "None";
    return;
  }

  if (selected.length > 1) {
    const sameBlockIds = [...new Set(
      selected
        .map(machine => machine.blockId)
        .filter(Boolean)
    )];

    const sameRecipeNames = [...new Set(
      selected
        .map(machine => machine.recipeName)
        .filter(Boolean)
    )];

    let extra = "";

    if (sameBlockIds.length === 1) {
      extra += `<br>Block ID: ${sameBlockIds[0]}`;
    }

    if (sameRecipeNames.length === 1) {
      extra += `<br>Recipe: ${sameRecipeNames[0]}`;
    }

    selectedInfo.innerHTML = `
      <strong>${selected.length} machines selected</strong>
      ${extra}<br>
      Ctrl+C: Copy<br>
      Ctrl+X: Cut<br>
      Ctrl+V: Paste<br>
      Delete: Remove
    `;
    return;
  }

  const machine = selected[0];
  const footprint = getMachineFootprint(machine);

  if (machine.isGroup) {
    selectedInfo.innerHTML = `
      <strong>${machine.recipeName}</strong><br>
      Group Type: ${machine.groupMachineType}<br>
      Count: ${machine.groupCount}<br>
      Layout: ${machine.groupRows} × ${machine.groupCols}<br>
      Width: ${footprint.width} m<br>
      Length: ${footprint.length} m<br>
      X: ${machine.x.toFixed(1)} m<br>
      Y: ${machine.y.toFixed(1)} m<br>
      Rotation: ${machine.rotation}°
    `;
    return;
  }

  if (machine.blockId || machine.recipeName) {
    selectedInfo.innerHTML = `
      <strong>${machine.recipeName || machine.type}</strong><br>
      ${machine.type}<br><br>

      Block Machine Type: ${machine.blockMachineType || machine.type}<br>
      Block ID: ${machine.blockId || "—"}<br>
      Block Index: ${machine.blockIndex ?? "—"}<br>
      Block Count: ${machine.blockCount ?? "—"}<br>
      Layout: ${(machine.blockRows ?? "—")} × ${(machine.blockCols ?? "—")}<br>
      Position In Block: ${
        machine.blockPosition
          ? `${machine.blockPosition.row}, ${machine.blockPosition.col}`
          : "—"
      }<br>
      Width: ${footprint.width} m<br>
      Length: ${footprint.length} m<br>
      X: ${machine.x.toFixed(1)} m<br>
      Y: ${machine.y.toFixed(1)} m<br>
      Rotation: ${machine.rotation}°
    `;
    return;
  }

  selectedInfo.innerHTML = `
    <strong>${machine.type}</strong><br>
    Width: ${footprint.width} m<br>
    Length: ${footprint.length} m<br>
    X: ${machine.x.toFixed(1)} m<br>
    Y: ${machine.y.toFixed(1)} m<br>
    Rotation: ${machine.rotation}°
  `;
}

function createMachine(type, x, y) {
  const def = getMachineDefinition(type);

  if (!def) {
    throw new Error(`Unknown machine type: ${type}`);
  }

  return {
    id: crypto.randomUUID(),
    type,
    x,
    y,
    width: def.width,
    length: def.length,
    rotation: 0,
    color: def.color
  };
}


function placeMachine(type) {
  const rect = canvas.getBoundingClientRect();
  const centerWorld = screenToWorld(rect.width / 2, rect.height / 2);

  const machine = createMachine(type, 0, 0);
  const placement = findOpenPlacement(machine, centerWorld.x, centerWorld.y);

  if (!placement) return;

  machine.x = placement.x;
  machine.y = placement.y;

  state.machines.push(machine);
  setSelection([machine.id]);

  updateSelectedInfo();
  draw();
}

async function renderRecipePalette(filterText = "") {
  const data = await loadGameData();

  machineSelect.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select a recipe...";
  placeholder.disabled = true;
  placeholder.selected = true;
  machineSelect.appendChild(placeholder);

  const search = filterText.trim().toLowerCase();

  const recipes = (data.Recipes || [])
    .filter(r => r.Name && r.Machine)
    .filter(r => {
      if (!search) return true;
      return (
        r.Name.toLowerCase().includes(search) ||
        r.Machine.toLowerCase().includes(search)
      );
    })
    .sort((a, b) => a.Name.localeCompare(b.Name));

  for (const recipe of recipes) {
    const option = document.createElement("option");
    option.value = recipe.Name;
    option.textContent = `${recipe.Name} (${recipe.Machine})`;
    machineSelect.appendChild(option);
  }
}

recipeSearch.addEventListener("input", () => {
  renderRecipePalette(recipeSearch.value);
});


addMachineBtn.addEventListener("click", async () => {
  const selectedRecipeName = machineSelect.value;
  if (!selectedRecipeName) return;

  const data = await loadGameData();
  const recipe = data.Recipes.find(r => r.Name === selectedRecipeName);

  if (!recipe) {
    alert("Recipe not found");
    return;
  }

  placeMachineFromRecipe(recipe);
});

plannerViewBtn.addEventListener("click", () => {
  state.viewMode = "planner";
  updateViewModeUI();
  draw();
});

summaryViewBtn.addEventListener("click", () => {
  state.viewMode = "summary";
  updateViewModeUI();

  if (state.lastImportedRows && state.lastImportedRows.length > 0) {
    renderSummaryView(state.lastImportedRows);
  }
});

async function readJsonFile(file) {
  const text = await file.text();
  return JSON.parse(text);
}

function normalizeImportedRows(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload.rows)) {
    return payload.rows;
  }

  if (Array.isArray(payload.blocks)) {
    return payload.blocks;
  }

  throw new Error("Imported JSON does not contain a rows array.");
}

function placeMachineFromRecipe(recipe) {
  const machineType = recipe.Machine;

  const def = getMachineDefinition(machineType);
  if (!def) {
    alert(`No machine definition for ${machineType}`);
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const centerWorld = screenToWorld(rect.width / 2, rect.height / 2);

  const machine = {
    id: crypto.randomUUID(),
    type: machineType,
    recipeName: recipe.Name,

    x: 0,
    y: 0,
    width: def.width,
    length: def.length,
    rotation: 0,
    color: def.color
  };

  const placement = findOpenPlacement(machine, centerWorld.x, centerWorld.y);
  if (!placement) return;

  machine.x = placement.x;
  machine.y = placement.y;

  state.machines.push(machine);
  setSelection([machine.id]);

  updateSelectedInfo();
  draw();
}

function renderSummaryCards(rows) {
  const totalExact = rows.reduce((sum, row) => sum + row.exactMachines, 0);
  const totalRounded = rows.reduce((sum, row) => sum + row.roundedMachines, 0);
  const totalArea = rows.reduce((sum, row) => sum + row.block.width * row.block.length, 0);

  summaryCardsEl.innerHTML = `
    <div class="summary-card">
      <div class="label">Recipe Blocks</div>
      <div class="value">${rows.length}</div>
    </div>
    <div class="summary-card">
      <div class="label">Exact Machines</div>
      <div class="value">${totalExact.toFixed(2)}</div>
    </div>
    <div class="summary-card">
      <div class="label">Rounded Machines</div>
      <div class="value">${totalRounded}</div>
    </div>
    <div class="summary-card">
      <div class="label">Estimated Area</div>
      <div class="value">${totalArea.toFixed(0)} m²</div>
    </div>
  `;
}

function renderSummaryTable(rows) {
  summaryTableBody.innerHTML = "";

  for (const row of rows) {
    const tr = document.createElement("tr");

    tr.innerHTML = `
      <td><strong>${escapeHtml(row.recipeName)}</strong></td>
      <td>${escapeHtml(row.machineName)}</td>
      <td>${row.exactMachines.toFixed(2)}</td>
      <td><span class="badge">${row.roundedMachines}</span></td>
      <td>${row.footprint.width}m × ${row.footprint.length}m</td>
      <td>${row.block.rows} rows × ${row.block.cols} cols</td>
      <td>${row.block.width.toFixed(1)}m × ${row.block.length.toFixed(1)}m</td>
    `;

    summaryTableBody.appendChild(tr);
  }
}

function drawSummaryPreview(rows) {
  if (!summaryPreviewCanvas || !summaryPreviewCtx) return;

  if (!rows.length) {
    summaryPreviewCanvas.width = 1400;
    summaryPreviewCanvas.height = 900;

    summaryPreviewCtx.clearRect(0, 0, summaryPreviewCanvas.width, summaryPreviewCanvas.height);
    summaryPreviewCtx.fillStyle = "#0c1117";
    summaryPreviewCtx.fillRect(0, 0, summaryPreviewCanvas.width, summaryPreviewCanvas.height);
    summaryPreviewCtx.fillStyle = "#9fb0c2";
    summaryPreviewCtx.font = "20px Arial";
    summaryPreviewCtx.fillText("No blocks to draw yet.", 30, 50);
    return;
  }

  const padding = 30;
  const blockGapMeters = 4;
  const labelLineHeight = 22;
  const labelBlockGap = 8;
  const labelLines = 4;
  const labelHeight = labelLines * labelLineHeight;
  const minCanvasWidth = 1400;

  const maxBlockWidth = Math.max(...rows.map(r => r.block.width));
  const maxBlockLength = Math.max(...rows.map(r => r.block.length));

  const usableWidth = minCanvasWidth - padding * 2;
  const scaleX = usableWidth / Math.max(maxBlockWidth * 4, 120);
  const scaleY = 900 / Math.max(maxBlockLength * 6, 120);
  const scale = Math.max(6, Math.min(scaleX, scaleY));

  const itemGapPx = blockGapMeters * scale;

  const measuredItems = rows.map(row => {
    const drawWidth = row.block.width * scale;
    const drawHeight = row.block.length * scale;

    const line1 = row.recipeName;
    const line2 = `${row.machineName} × ${row.roundedMachines}`;
    const line3 = `${row.block.rows} × ${row.block.cols}`;
    const line4 = `${row.block.width.toFixed(1)}m × ${row.block.length.toFixed(1)}m`;

    summaryPreviewCtx.font = "bold 16px Arial";
    const line1Width = summaryPreviewCtx.measureText(line1).width;

    summaryPreviewCtx.font = "14px Arial";
    const line2Width = summaryPreviewCtx.measureText(line2).width;
    const line3Width = summaryPreviewCtx.measureText(line3).width;
    const line4Width = summaryPreviewCtx.measureText(line4).width;

    const labelWidth = Math.max(line1Width, line2Width, line3Width, line4Width);
    const itemWidth = Math.max(drawWidth, labelWidth);
    const itemHeight = labelHeight + labelBlockGap + drawHeight;

    return {
      row,
      drawWidth,
      drawHeight,
      line1,
      line2,
      line3,
      line4,
      itemWidth,
      itemHeight
    };
  });

  let x = padding;
  let y = padding;
  let currentRowHeight = 0;

  for (const item of measuredItems) {
    if (x + item.itemWidth > minCanvasWidth - padding) {
      x = padding;
      y += currentRowHeight + itemGapPx;
      currentRowHeight = 0;
    }

    currentRowHeight = Math.max(currentRowHeight, item.itemHeight);
    x += item.itemWidth + itemGapPx;
  }

  const neededHeight = Math.max(900, Math.ceil(y + currentRowHeight + padding));

  summaryPreviewCanvas.width = minCanvasWidth;
  summaryPreviewCanvas.height = neededHeight;

  summaryPreviewCtx.clearRect(0, 0, summaryPreviewCanvas.width, summaryPreviewCanvas.height);
  summaryPreviewCtx.fillStyle = "#0c1117";
  summaryPreviewCtx.fillRect(0, 0, summaryPreviewCanvas.width, summaryPreviewCanvas.height);

  x = padding;
  y = padding;
  currentRowHeight = 0;

  for (const item of measuredItems) {
    if (x + item.itemWidth > summaryPreviewCanvas.width - padding) {
      x = padding;
      y += currentRowHeight + itemGapPx;
      currentRowHeight = 0;
    }

    const labelX = x;
    const labelY = y;
    const rectX = x;
    const rectY = labelY + labelHeight + labelBlockGap;

    summaryPreviewCtx.fillStyle = "#e8eef5";
    summaryPreviewCtx.font = "bold 16px Arial";
    summaryPreviewCtx.fillText(item.line1, labelX, labelY + 18);

    summaryPreviewCtx.fillStyle = "#9fb0c2";
    summaryPreviewCtx.font = "14px Arial";
    summaryPreviewCtx.fillText(item.line2, labelX, labelY + 18 + labelLineHeight);
    summaryPreviewCtx.fillText(item.line3, labelX, labelY + 18 + labelLineHeight * 2);
    summaryPreviewCtx.fillText(item.line4, labelX, labelY + 18 + labelLineHeight * 3);

    summaryPreviewCtx.fillStyle = "#243446";
    summaryPreviewCtx.strokeStyle = "#6fc2ff";
    summaryPreviewCtx.lineWidth = 2;
    summaryPreviewCtx.fillRect(rectX, rectY, item.drawWidth, item.drawHeight);
    summaryPreviewCtx.strokeRect(rectX, rectY, item.drawWidth, item.drawHeight);

    x += item.itemWidth + itemGapPx;
    currentRowHeight = Math.max(currentRowHeight, item.itemHeight);
  }
}

function renderSummaryView(rows) {
  renderSummaryCards(rows);
  renderSummaryTable(rows);
  drawSummaryPreview(rows);
}

function updateViewModeUI() {
  if (state.viewMode === "summary") {
    canvas.style.display = "none";
    summaryViewEl.style.display = "block";
  } else {
    canvas.style.display = "block";
    summaryViewEl.style.display = "none";
  }
}

function exportSummaryPdf() {
  if (!state.lastImportedRows || state.lastImportedRows.length === 0) {
    alert("Import a factory first so there is something to export.");
    return;
  }

  const previousViewMode = state.viewMode;

  state.viewMode = "summary";
  updateViewModeUI();
  renderSummaryView(state.lastImportedRows);

  setTimeout(() => {
    window.print();

    state.viewMode = previousViewMode;
    updateViewModeUI();
    draw();
  }, 100);
}

function createImportedMachine(type, x, y, metadata = {}) {
  const machine = createMachine(type, x, y);

  return {
    ...machine,
    recipeName: metadata.recipeName || null,
    blockId: metadata.blockId || null,
    blockIndex: metadata.blockIndex ?? null,
    blockRows: metadata.blockRows ?? null,
    blockCols: metadata.blockCols ?? null,
    blockCount: metadata.blockCount ?? null,
    blockMachineType: metadata.blockMachineType || null,
    exactMachines: metadata.exactMachines ?? null,
    blockPosition: metadata.blockPosition || null
  };
}

function buildClusterMachinesFromRow(row, anchorX, anchorY, blockIndex) {
  if (!row.block || !row.machineName || !row.recipeName) {
    return [];
  }

  const def = getMachineDefinition(row.machineName);
  if (!def) {
    console.warn(`Unknown machine type in import: ${row.machineName}`);
    return [];
  }

  const rows = row.block.rows || 1;
  const cols = row.block.cols || 1;
  const count = row.roundedMachines || rows * cols;

  const blockId = crypto.randomUUID();
  const machines = [];

  const rowGap = 2;
  const colGap = 2;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const index = r * cols + c;
      if (index >= count) break;

      const x = snap(anchorX + c * (def.width + colGap));
      const y = snap(anchorY + r * (def.length + rowGap));

      machines.push(
        createImportedMachine(row.machineName, x, y, {
          recipeName: row.recipeName,
          blockId,
          blockIndex,
          blockRows: rows,
          blockCols: cols,
          blockCount: count,
          blockMachineType: row.machineName,
          exactMachines: row.exactMachines ?? null,
          blockPosition: { row: r, col: c, index }
        })
      );
    }
  }

  return machines;
}

function getClusterBounds(machines) {
  if (machines.length === 0) return null;

  const bounds = machines.map(machine => getMachineBounds(machine));

  return {
    left: Math.min(...bounds.map(b => b.left)),
    top: Math.min(...bounds.map(b => b.top)),
    right: Math.max(...bounds.map(b => b.right)),
    bottom: Math.max(...bounds.map(b => b.bottom)),
    width: Math.max(...bounds.map(b => b.right)) - Math.min(...bounds.map(b => b.left)),
    length: Math.max(...bounds.map(b => b.bottom)) - Math.min(...bounds.map(b => b.top))
  };
}

function canPlaceImportedCluster(clusterMachines, extraMachines = []) {
  const blockers = [...state.machines, ...extraMachines];
  const clusterIds = new Set(clusterMachines.map(machine => machine.id));

  for (const machine of clusterMachines) {
    for (const other of blockers) {
      if (!other || clusterIds.has(other.id)) continue;

      const aRects = getMachineOccupiedRects(machine);
      const bRects = getMachineOccupiedRects(other);

      if (rectSetsOverlap(aRects, bRects)) {
        return false;
      }
    }
  }

  return true;
}

function findOpenClusterPlacement(row, originX, originY, blockIndex, extraMachines = [], maxRadius = 240) {
  const start = snapPosition(originX, originY);

  const tryBuildAt = (testX, testY) => {
    const clusterMachines = buildClusterMachinesFromRow(row, testX, testY, blockIndex);
    if (clusterMachines.length === 0) return null;

    if (canPlaceImportedCluster(clusterMachines, extraMachines)) {
      return clusterMachines;
    }

    return null;
  };

  let cluster = tryBuildAt(start.x, start.y);
  if (cluster) return cluster;

  for (let radius = 1; radius <= maxRadius; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        const onRing = Math.abs(dx) === radius || Math.abs(dy) === radius;
        if (!onRing) continue;

        const testX = snap(start.x + dx * SNAP_SIZE);
        const testY = snap(start.y + dy * SNAP_SIZE);

        cluster = tryBuildAt(testX, testY);
        if (cluster) return cluster;
      }
    }
  }

  return null;
}

function importMachineClusters(rows) {
  const rect = canvas.getBoundingClientRect();
  const centerWorld = screenToWorld(rect.width / 2, rect.height / 2);

  const importedMachines = [];
  state.machines = [];

  let cursorX = snap(centerWorld.x);
  let cursorY = snap(centerWorld.y);
  let currentRowHeight = 0;

  const gap = 8;
  const maxRowWidth = 260;
  const maxRowAttempts = Math.max(rows.length * 8, 100);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.block || !row.machineName || !row.recipeName) continue;

    let placedCluster = null;
    let attempts = 0;

    while (!placedCluster && attempts < maxRowAttempts) {
      const estimatedBlockWidth = row.block.width;
      const estimatedBlockHeight = row.block.length;

      if (cursorX + estimatedBlockWidth > centerWorld.x + maxRowWidth) {
        cursorX = snap(centerWorld.x);
        cursorY = snap(cursorY + currentRowHeight + gap);
        currentRowHeight = 0;
      }

      const candidateCluster = findOpenClusterPlacement(
        row,
        cursorX,
        cursorY,
        i,
        importedMachines,
        240
      );

      if (candidateCluster && candidateCluster.length > 0) {
        placedCluster = candidateCluster;
        break;
      }

      cursorX = snap(centerWorld.x);
      cursorY = snap(cursorY + Math.max(currentRowHeight, estimatedBlockHeight) + gap);
      currentRowHeight = 0;
      attempts += 1;
    }

    if (!placedCluster) {
      console.warn("Failed to place cluster without overlap:", row.recipeName);
      continue;
    }

    const clusterBounds = getClusterBounds(placedCluster);
    if (!clusterBounds) {
      console.warn("Failed to compute cluster bounds:", row.recipeName);
      continue;
    }

    importedMachines.push(...placedCluster);

    cursorX = snap(clusterBounds.right + gap);
    currentRowHeight = Math.max(currentRowHeight, clusterBounds.length);
  }

  if (importedMachines.length === 0) {
    throw new Error("No valid machine clusters were imported.");
  }

  state.machines.push(...importedMachines);

  clearSelection();
  setSelection(importedMachines.map(m => m.id));

  updateSelectedInfo();
  draw();
}
function importMachineClusters(rows) {
  const rect = canvas.getBoundingClientRect();
  const centerWorld = screenToWorld(rect.width / 2, rect.height / 2);

  const importedMachines = [];
  state.machines = [];

  let cursorX = snap(centerWorld.x);
  let cursorY = snap(centerWorld.y);
  let currentRowHeight = 0;

  const gap = 8;
  const maxRowWidth = 200;
  const maxRowAttempts = Math.max(rows.length * 4, 40);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.block || !row.machineName || !row.recipeName) continue;

    let placedCluster = null;
    let attempts = 0;

    while (!placedCluster && attempts < maxRowAttempts) {
      const estimatedBlockWidth = row.block.width;
      const estimatedBlockHeight = row.block.length;

      if (cursorX + estimatedBlockWidth > centerWorld.x + maxRowWidth) {
        cursorX = snap(centerWorld.x);
        cursorY = snap(cursorY + currentRowHeight + gap);
        currentRowHeight = 0;
      }

      const candidateCluster = findOpenClusterPlacement(
        row,
        cursorX,
        cursorY,
        i,
        importedMachines
      );

      if (candidateCluster && candidateCluster.length > 0) {
        placedCluster = candidateCluster;
        break;
      }

      cursorX = snap(centerWorld.x);
      cursorY = snap(cursorY + Math.max(currentRowHeight, estimatedBlockHeight) + gap);
      currentRowHeight = 0;
      attempts += 1;
    }

    if (!placedCluster) {
      console.warn("Failed to place cluster without overlap:", row.recipeName);
      continue;
    }

    const clusterBounds = getClusterBounds(placedCluster);
    if (!clusterBounds) {
      console.warn("Failed to compute cluster bounds:", row.recipeName);
      continue;
    }

    importedMachines.push(...placedCluster);

    cursorX = snap(clusterBounds.right + gap);
    currentRowHeight = Math.max(currentRowHeight, clusterBounds.length);
  }

  if (importedMachines.length === 0) {
    throw new Error("No valid machine clusters were imported.");
  }

  state.machines.push(...importedMachines);

  clearSelection();
  setSelection(importedMachines.map(m => m.id));

  updateSelectedInfo();
  draw();
}

importFactoryBtn.addEventListener("click", async () => {
  try {
    const file = importFactoryFile.files?.[0];
    if (!file) return;

    let rows;

    if (file.name.toLowerCase().endsWith(".sfmd")) {
      const sfmd = await readJsonFile(file);

      if (!sfmd || !Array.isArray(sfmd.Data)) {
        throw new Error("Uploaded file does not look like a valid .sfmd save.");
      }

      const gd = await loadGameData();
      rows = buildRecipeSummaryFromSfmd(sfmd, gd, 1);
    } else {
      const payload = await readJsonFile(file);
      rows = normalizeImportedRows(payload);
    }

    if (typeof gtag === "function") {
      gtag("event", "import_success", {
        file_type: file.name.toLowerCase().endsWith(".sfmd") ? "sfmd" : "json"
      });
    }

    state.lastImportedRows = rows;
    renderSummaryView(rows);
    importMachineClusters(rows);
  } catch (error) {
    if (typeof gtag === "function") {
      gtag("event", "import_failure");
    }

    console.error(error);
    alert(error.message);
  }
});

function drawGrid() {
  const rect = canvas.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;

  const topLeft = screenToWorld(0, 0);
  const bottomRight = screenToWorld(width, height);

  const minorStep = SNAP_SIZE;
  const foundationStep = FOUNDATION_SIZE;

  const startXMinor = Math.floor(topLeft.x / minorStep) * minorStep;
  const endXMinor = Math.ceil(bottomRight.x / minorStep) * minorStep;
  const startYMinor = Math.floor(topLeft.y / minorStep) * minorStep;
  const endYMinor = Math.ceil(bottomRight.y / minorStep) * minorStep;

  ctx.lineWidth = 1;

  if (state.camera.zoom >= 12) {
    ctx.strokeStyle = "#1f2a33";

    for (let x = startXMinor; x <= endXMinor; x += minorStep) {
      const sx = worldToScreen(x, 0).x;
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, height);
      ctx.stroke();
    }

    for (let y = startYMinor; y <= endYMinor; y += minorStep) {
      const sy = worldToScreen(0, y).y;
      ctx.beginPath();
      ctx.moveTo(0, sy);
      ctx.lineTo(width, sy);
      ctx.stroke();
    }
  }

  const startXFoundation = Math.floor(topLeft.x / foundationStep) * foundationStep;
  const endXFoundation = Math.ceil(bottomRight.x / foundationStep) * foundationStep;
  const startYFoundation = Math.floor(topLeft.y / foundationStep) * foundationStep;
  const endYFoundation = Math.ceil(bottomRight.y / foundationStep) * foundationStep;

  ctx.strokeStyle = "#3a4a57";

  for (let x = startXFoundation; x <= endXFoundation; x += foundationStep) {
    const sx = worldToScreen(x, 0).x;
    ctx.beginPath();
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, height);
    ctx.stroke();
  }

  for (let y = startYFoundation; y <= endYFoundation; y += foundationStep) {
    const sy = worldToScreen(0, y).y;
    ctx.beginPath();
    ctx.moveTo(0, sy);
    ctx.lineTo(width, sy);
    ctx.stroke();
  }
}

function drawOrigin() {
  const origin = worldToScreen(0, 0);

  ctx.strokeStyle = "#ff7b72";
  ctx.lineWidth = 2;

  ctx.beginPath();
  ctx.moveTo(origin.x - 10, origin.y);
  ctx.lineTo(origin.x + 10, origin.y);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(origin.x, origin.y - 10);
  ctx.lineTo(origin.x, origin.y + 10);
  ctx.stroke();
}

function drawWrappedMachineLabel(ctx, text, centerX, centerY, maxWidth, maxHeight, fontSize) {
  const lineHeight = fontSize * 1.15;

  const rawLines = String(text).split("\n");
  const finalLines = [];

  for (const rawLine of rawLines) {
    const words = rawLine.split(" ");
    let currentLine = words[0] || "";

    for (let i = 1; i < words.length; i++) {
      const testLine = `${currentLine} ${words[i]}`;
      if (ctx.measureText(testLine).width <= maxWidth) {
        currentLine = testLine;
      } else {
        finalLines.push(currentLine);
        currentLine = words[i];
      }
    }

    if (currentLine) {
      finalLines.push(currentLine);
    }
  }

  if (finalLines.length === 0) {
    return;
  }

  let linesToDraw = finalLines;

  while (linesToDraw.length * lineHeight > maxHeight && linesToDraw.length > 1) {
    linesToDraw = linesToDraw.slice(0, -1);
  }

  const totalHeight = linesToDraw.length * lineHeight;
  let y = centerY - totalHeight / 2 + lineHeight / 2;

  for (const line of linesToDraw) {
    ctx.fillText(line, centerX, y);
    y += lineHeight;
  }
}

function drawGroupLabel(machine, screenPos, widthPx, heightPx) {
  const centerX = screenPos.x + widthPx / 2;
  const centerY = screenPos.y + heightPx / 2;

  const lines = [
    machine.recipeName,
    `${machine.groupMachineType} × ${machine.groupCount}`,
    `${machine.groupRows} × ${machine.groupCols}`,
    `${getMachineFootprint(machine).width.toFixed(1)}m × ${getMachineFootprint(machine).length.toFixed(1)}m`
  ];

  let fontSize = Math.floor(Math.min(widthPx, heightPx) * 0.11);
  fontSize = Math.max(10, Math.min(22, fontSize));

  while (fontSize > 8) {
    ctx.font = `bold ${fontSize}px Arial`;
    const line1Width = ctx.measureText(lines[0]).width;

    ctx.font = `${fontSize - 1}px Arial`;
    const otherWidths = lines.slice(1).map(line => ctx.measureText(line).width);
    const widest = Math.max(line1Width, ...otherWidths);
    const totalHeight = fontSize * 1.35 * 4;

    if (widest <= widthPx - 16 && totalHeight <= heightPx - 16) {
      break;
    }

    fontSize -= 1;
  }

  const titleFont = `bold ${fontSize}px Arial`;
  const bodyFont = `${Math.max(fontSize - 1, 8)}px Arial`;
  const lineHeight = fontSize * 1.35;
  const totalHeight = lineHeight * 4;
  let y = centerY - totalHeight / 2 + lineHeight * 0.8;

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ctx.fillStyle = "#e8eef5";
  ctx.font = titleFont;
  ctx.fillText(lines[0], centerX, y);

  ctx.fillStyle = "#d2dbe5";
  ctx.font = bodyFont;
  ctx.fillText(lines[1], centerX, y + lineHeight);
  ctx.fillText(lines[2], centerX, y + lineHeight * 2);
  ctx.fillText(lines[3], centerX, y + lineHeight * 3);

  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
}

function drawMachines() {
  for (const machine of state.machines) {
    const footprint = getMachineFootprint(machine);
    const screenPos = worldToScreen(machine.x, machine.y);

    const widthPx = footprint.width * state.camera.zoom;
    const heightPx = footprint.length * state.camera.zoom;

    if (machine.isGroup) {
      ctx.fillStyle = machine.color || "#2f4257";
      ctx.globalAlpha = 0.82;
      ctx.fillRect(screenPos.x, screenPos.y, widthPx, heightPx);
      ctx.globalAlpha = 1;

      ctx.strokeStyle = isMachineSelected(machine.id) ? "#ffd866" : "#6fc2ff";
      ctx.lineWidth = isMachineSelected(machine.id) ? 3 : 2;
      ctx.strokeRect(screenPos.x, screenPos.y, widthPx, heightPx);

      drawGroupLabel(machine, screenPos, widthPx, heightPx);
      continue;
    }

    ctx.fillStyle = machine.color;
    ctx.fillRect(screenPos.x, screenPos.y, widthPx, heightPx);

    const buffers = getMachineBufferRects(machine);

    ctx.save();

    if (buffers.input) {
      let topLeft = worldToScreen(buffers.input.left, buffers.input.top);
      let bufferWidthPx = (buffers.input.right - buffers.input.left) * state.camera.zoom;
      let bufferHeightPx = (buffers.input.bottom - buffers.input.top) * state.camera.zoom;

      ctx.fillStyle = "rgba(80, 200, 120, 0.22)";
      ctx.strokeStyle = "rgba(80, 200, 120, 0.55)";
      ctx.lineWidth = 1;
      ctx.fillRect(topLeft.x, topLeft.y, bufferWidthPx, bufferHeightPx);
      ctx.strokeRect(topLeft.x, topLeft.y, bufferWidthPx, bufferHeightPx);
    }

    if (buffers.output) {
      let topLeft = worldToScreen(buffers.output.left, buffers.output.top);
      let bufferWidthPx = (buffers.output.right - buffers.output.left) * state.camera.zoom;
      let bufferHeightPx = (buffers.output.bottom - buffers.output.top) * state.camera.zoom;

      ctx.fillStyle = "rgba(255, 215, 0, 0.18)";
      ctx.strokeStyle = "rgba(255, 215, 0, 0.45)";
      ctx.fillRect(topLeft.x, topLeft.y, bufferWidthPx, bufferHeightPx);
      ctx.strokeRect(topLeft.x, topLeft.y, bufferWidthPx, bufferHeightPx);
    }

    ctx.restore();

    ctx.strokeStyle = isMachineSelected(machine.id) ? "#ffd866" : "#0b0f14";
    ctx.lineWidth = isMachineSelected(machine.id) ? 3 : 1.5;
    ctx.strokeRect(screenPos.x, screenPos.y, widthPx, heightPx);

    const paddingX = 8;
    const paddingY = 8;
    const maxTextWidth = Math.max(16, widthPx - paddingX * 2);
    const maxTextHeight = Math.max(16, heightPx - paddingY * 2);

    let fontSize = Math.floor(Math.min(widthPx, heightPx) * 0.18);
    fontSize = Math.max(8, Math.min(24, fontSize));

    ctx.fillStyle = "#0b0f14";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    while (fontSize > 8) {
      ctx.font = `${fontSize}px Arial`;

      const words = machine.type.split(" ");
      const lineHeight = fontSize * 1.15;

      let lines = [];
      let currentLine = words[0] || "";

      for (let i = 1; i < words.length; i++) {
        const testLine = `${currentLine} ${words[i]}`;
        if (ctx.measureText(testLine).width <= maxTextWidth) {
          currentLine = testLine;
        } else {
          lines.push(currentLine);
          currentLine = words[i];
        }
      }

      if (currentLine) {
        lines.push(currentLine);
      }

      const widestLine = Math.max(...lines.map(line => ctx.measureText(line).width), 0);
      const totalHeight = lines.length * lineHeight;

      const singleWordTooWide =
        words.length === 1 && ctx.measureText(machine.type).width > maxTextWidth;

      if (!singleWordTooWide && widestLine <= maxTextWidth && totalHeight <= maxTextHeight) {
        break;
      }

      if (words.length === 1 && ctx.measureText(machine.type).width <= maxTextWidth) {
        break;
      }

      fontSize -= 1;
    }

    ctx.font = `${fontSize}px Arial`;

        // ===== label content =====
    let labelText = machine.recipeName || machine.type;

    if (machine.recipeName) {
      labelText = `${machine.recipeName}\n${machine.type}`;
    }

    // ===== draw main label =====
    drawWrappedMachineLabel(
      ctx,
      labelText,
      screenPos.x + widthPx / 2,
      screenPos.y + heightPx / 2,
      maxTextWidth,
      maxTextHeight,
      fontSize
    );

    // ===== optional tiny block position tag =====
    if (machine.blockPosition && state.camera.zoom > 12) {
      ctx.fillStyle = "#ffffffcc";
      ctx.font = "10px Arial";
      ctx.textAlign = "right";
      ctx.textBaseline = "bottom";

      ctx.fillText(
        `${machine.blockPosition.row},${machine.blockPosition.col}`,
        screenPos.x + widthPx - 3,
        screenPos.y + heightPx - 3
      );

      ctx.textAlign = "start";
      ctx.textBaseline = "alphabetic";
    }
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
    }
  }


function drawMarquee() {
  if (!state.marqueeRect) return;

  const { x, y, width, height } = state.marqueeRect;

  ctx.save();
  ctx.fillStyle = "rgba(47, 129, 247, 0.18)";
  ctx.strokeStyle = "rgba(47, 129, 247, 0.95)";
  ctx.lineWidth = 1.5;
  ctx.fillRect(x, y, width, height);
  ctx.strokeRect(x, y, width, height);
  ctx.restore();
}

function draw() {
  const rect = canvas.getBoundingClientRect();

  ctx.fillStyle = "#2b2b2b";
  ctx.fillRect(0, 0, rect.width, rect.height);

  if (state.viewMode === "summary") {
    drawSummaryView();
    return;
  }

  drawGrid();
  drawOrigin();
  drawMachines();
  drawMarquee();
}
function drawSummaryView() {
  if (!state.lastImportedRows || state.lastImportedRows.length === 0) {
    ctx.fillStyle = "#e8eef5";
    ctx.font = "18px Arial";
    ctx.fillText("No imported factory summary yet.", 40, 50);

    ctx.fillStyle = "#9fb0c2";
    ctx.font = "14px Arial";
    ctx.fillText("Import a .sfmd or parser JSON file first.", 40, 80);
    return;
  }

  ctx.fillStyle = "#e8eef5";
  ctx.font = "bold 20px Arial";
  ctx.fillText("Factory Summary", 40, 50);

  ctx.fillStyle = "#9fb0c2";
  ctx.font = "14px Arial";
  ctx.fillText(`${state.lastImportedRows.length} recipe blocks`, 40, 78);

  let x = 40;
  let y = 120;
  const lineHeight = 22;
  const colWidth = 420;
  const bottomMargin = 40;
  const maxHeight = canvas.getBoundingClientRect().height - bottomMargin;

  for (const row of state.lastImportedRows) {
    ctx.fillStyle = "#e8eef5";
    ctx.font = "bold 14px Arial";
    ctx.fillText(row.recipeName, x, y);

    ctx.fillStyle = "#9fb0c2";
    ctx.font = "13px Arial";
    ctx.fillText(
      `${row.machineName} × ${row.roundedMachines} | ${row.block.rows} × ${row.block.cols} | ${row.block.width.toFixed(1)}m × ${row.block.length.toFixed(1)}m`,
      x,
      y + lineHeight
    );

    y += lineHeight * 3;

    if (y > maxHeight) {
      y = 120;
      x += colWidth;
    }
  }
}
function hitTestMachine(screenX, screenY) {
  const world = screenToWorld(screenX, screenY);

  for (let i = state.machines.length - 1; i >= 0; i--) {
    const machine = state.machines[i];
    const footprint = getMachineFootprint(machine);

    const inside =
      world.x >= machine.x &&
      world.x <= machine.x + footprint.width &&
      world.y >= machine.y &&
      world.y <= machine.y + footprint.length;

    if (inside) {
      return machine;
    }
  }

  return null;
}

function normalizeRect(x1, y1, x2, y2) {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1)
  };
}

function screenRectToWorldRect(rect) {
  const topLeft = screenToWorld(rect.x, rect.y);
  const bottomRight = screenToWorld(rect.x + rect.width, rect.y + rect.height);

  return {
    left: Math.min(topLeft.x, bottomRight.x),
    top: Math.min(topLeft.y, bottomRight.y),
    right: Math.max(topLeft.x, bottomRight.x),
    bottom: Math.max(topLeft.y, bottomRight.y)
  };
}

function machineIntersectsWorldRect(machine, worldRect) {
  const bounds = getMachineBounds(machine);
  return rectanglesOverlap(bounds, worldRect);
}

function getSelectionGroupBounds(machines) {
  if (machines.length === 0) return null;

  const boundsList = machines.map(machine => getMachineBounds(machine));

  return {
    left: Math.min(...boundsList.map(b => b.left)),
    top: Math.min(...boundsList.map(b => b.top)),
    right: Math.max(...boundsList.map(b => b.right)),
    bottom: Math.max(...boundsList.map(b => b.bottom))
  };
}

function getBoundsCenter(bounds) {
  return {
    x: (bounds.left + bounds.right) / 2,
    y: (bounds.top + bounds.bottom) / 2
  };
}

function rotatePointClockwiseAround(x, y, centerX, centerY) {
  const dx = x - centerX;
  const dy = y - centerY;

  return {
    x: centerX - dy,
    y: centerY + dx
  };
}

function buildGroupRotationProposals(machines, rotationStep = 90) {
  if (machines.length === 0) return [];

  const groupBounds = getSelectionGroupBounds(machines);
  if (!groupBounds) return [];

  const groupCenter = getBoundsCenter(groupBounds);

  return machines.map(machine => {
    const currentBounds = getMachineBounds(machine);
    const currentCenter = {
      x: currentBounds.left + currentBounds.width / 2,
      y: currentBounds.top + currentBounds.length / 2
    };

    const rotatedCenter = rotatePointClockwiseAround(
      currentCenter.x,
      currentCenter.y,
      groupCenter.x,
      groupCenter.y
    );

    const newRotation = (machine.rotation + rotationStep) % 360;
    const rotated = newRotation % 180 !== 0;
    const newWidth = rotated ? machine.length : machine.width;
    const newLength = rotated ? machine.width : machine.length;

    return {
      machine,
      x: snap(rotatedCenter.x - newWidth / 2),
      y: snap(rotatedCenter.y - newLength / 2),
      rotation: newRotation
    };
  });
}

function canApplyMachineProposals(proposals, ignoreIds = []) {
  for (const proposal of proposals) {
    if (
      wouldMachineOverlap(
        proposal.machine,
        proposal.x,
        proposal.y,
        proposal.rotation,
        ignoreIds
      )
    ) {
      return false;
    }
  }

  for (let i = 0; i < proposals.length; i++) {
    for (let j = i + 1; j < proposals.length; j++) {
      const a = proposals[i];
      const b = proposals[j];

      const aRects = getMachineOccupiedRects(a.machine, a.x, a.y, a.rotation);
      const bRects = getMachineOccupiedRects(b.machine, b.x, b.y, b.rotation);

      if (rectSetsOverlap(aRects, bRects)) {
        return false;
      }
    }
  }

  return true;
}

function copySelectedMachines() {
  const selected = getSelectedMachines();
  if (selected.length === 0) return;

  const groupBounds = getSelectionGroupBounds(selected);
  if (!groupBounds) return;

  state.clipboard = selected.map(machine => ({
    type: machine.type,
    width: machine.width,
    length: machine.length,
    rotation: machine.rotation,
    color: machine.color,
    isGroup: Boolean(machine.isGroup),

    recipeName: machine.recipeName || null,
    blockId: machine.blockId || null,
    blockIndex: machine.blockIndex ?? null,
    blockRows: machine.blockRows ?? null,
    blockCols: machine.blockCols ?? null,
    blockCount: machine.blockCount ?? null,
    blockMachineType: machine.blockMachineType || null,
    exactMachines: machine.exactMachines ?? null,
    blockPosition: machine.blockPosition || null,

    offsetX: machine.x - groupBounds.left,
    offsetY: machine.y - groupBounds.top
  }));
}

function cutSelectedMachines() {
  const selectedIds = [...state.selectedMachineIds];
  if (selectedIds.length === 0) return;

  copySelectedMachines();
  state.machines = state.machines.filter(machine => !selectedIds.includes(machine.id));
  clearSelection();
  updateSelectedInfo();
  draw();
}

function canPasteClipboardAt(anchorX, anchorY) {
  const previewMachines = state.clipboard.map(item => ({
    id: crypto.randomUUID(),
    type: item.type,
    x: snap(anchorX + item.offsetX),
    y: snap(anchorY + item.offsetY),
    width: item.width,
    length: item.length,
    rotation: item.rotation,
    color: item.color,
    isGroup: item.isGroup,

    recipeName: item.recipeName,
    blockId: item.blockId,
    blockIndex: item.blockIndex,
    blockRows: item.blockRows,
    blockCols: item.blockCols,
    blockCount: item.blockCount,
    blockMachineType: item.blockMachineType,
    exactMachines: item.exactMachines,
    blockPosition: item.blockPosition
  }));

  for (const previewMachine of previewMachines) {
    for (const existing of state.machines) {
      if (
        rectSetsOverlap(
          getMachineOccupiedRects(previewMachine),
          getMachineOccupiedRects(existing)
        )
      ) {
        return false;
      }
    }
  }

  for (let i = 0; i < previewMachines.length; i++) {
    for (let j = i + 1; j < previewMachines.length; j++) {
      if (
        rectSetsOverlap(
          getMachineOccupiedRects(previewMachines[i]),
          getMachineOccupiedRects(previewMachines[j])
        )
      ) {
        return false;
      }
    }
  }

  return true;
}

function findOpenPastePlacement(originX, originY, maxRadius = 40) {
  const start = snapPosition(originX, originY);

  if (canPasteClipboardAt(start.x, start.y)) {
    return start;
  }

  for (let radius = 1; radius <= maxRadius; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        const onRing = Math.abs(dx) === radius || Math.abs(dy) === radius;
        if (!onRing) continue;

        const testX = snap(start.x + dx * SNAP_SIZE);
        const testY = snap(start.y + dy * SNAP_SIZE);

        if (canPasteClipboardAt(testX, testY)) {
          return { x: testX, y: testY };
        }
      }
    }
  }

  return null;
}

function pasteClipboard() {
  if (state.clipboard.length === 0) return;

  const rect = canvas.getBoundingClientRect();
  const centerWorld = screenToWorld(rect.width / 2, rect.height / 2);
  const anchor = findOpenPastePlacement(centerWorld.x, centerWorld.y);

  if (!anchor) return;

  const newMachines = state.clipboard.map(item => ({
    id: crypto.randomUUID(),
    type: item.type,
    x: snap(anchor.x + item.offsetX),
    y: snap(anchor.y + item.offsetY),
    width: item.width,
    length: item.length,
    rotation: item.rotation,
    color: item.color,
    isGroup: item.isGroup,

    recipeName: item.recipeName,
    blockId: item.blockId,
    blockIndex: item.blockIndex,
    blockRows: item.blockRows,
    blockCols: item.blockCols,
    blockCount: item.blockCount,
    blockMachineType: item.blockMachineType,
    exactMachines: item.exactMachines,
    blockPosition: item.blockPosition
  }));

  state.machines.push(...newMachines);
  setSelection(newMachines.map(machine => machine.id));
  updateSelectedInfo();
  draw();
}
function escapeHtml(str) {
  if (str === null || str === undefined) return "";

  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
function deleteSelectedMachines() {
  if (state.selectedMachineIds.length === 0) return;

  state.machines = state.machines.filter(
    machine => !state.selectedMachineIds.includes(machine.id)
  );
  clearSelection();
  updateSelectedInfo();
  draw();
}

canvas.addEventListener("contextmenu", event => {
  event.preventDefault();
});

if (exportSummaryPdfBtn) {
  exportSummaryPdfBtn.addEventListener("click", () => {
    exportSummaryPdf();
  });
}

canvas.addEventListener(
  "wheel",
  event => {
    event.preventDefault();

    const rect = canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;

    const beforeZoom = screenToWorld(mouseX, mouseY);

    const zoomFactor = event.deltaY < 0 ? 1.1 : 0.9;
    state.camera.zoom *= zoomFactor;
    state.camera.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, state.camera.zoom));

    const afterZoom = screenToWorld(mouseX, mouseY);

    state.camera.x += (afterZoom.x - beforeZoom.x) * state.camera.zoom;
    state.camera.y += (afterZoom.y - beforeZoom.y) * state.camera.zoom;

    draw();
  },
  { passive: false }
);

canvas.addEventListener("mousedown", event => {
  const rect = canvas.getBoundingClientRect();
  const mouseX = event.clientX - rect.left;
  const mouseY = event.clientY - rect.top;

  state.dragStartScreen = { x: mouseX, y: mouseY };

  const hitMachine = hitTestMachine(mouseX, mouseY);

  if (event.button === 1) {
    state.dragMode = "pan";
    state.isDragging = false;
    return;
  }

  if (event.button === 2) {
    state.dragMode = "marquee";
    state.marqueeRect = {
      x: mouseX,
      y: mouseY,
      width: 0,
      height: 0
    };
    draw();
    return;
  }

  if (event.button === 0 && hitMachine) {
    if (!isMachineSelected(hitMachine.id)) {
      setSelection([hitMachine.id]);
    }

    const selectedMachines = getSelectedMachines();
    state.machineDragOffsets = selectedMachines.map(machine => {
      const world = screenToWorld(mouseX, mouseY);
      return {
        id: machine.id,
        offsetX: world.x - machine.x,
        offsetY: world.y - machine.y,
        startX: machine.x,
        startY: machine.y
      };
    });

    state.dragMode = "machine";
    updateSelectedInfo();
    draw();
    return;
  }

  if (event.button === 0) {
    clearSelection();
    updateSelectedInfo();
    state.dragMode = "pan";
    state.isDragging = false;
    draw();
  }
});

canvas.addEventListener("mousemove", event => {
  const rect = canvas.getBoundingClientRect();
  const mouseX = event.clientX - rect.left;
  const mouseY = event.clientY - rect.top;

  if (state.dragMode === "pan") {
    const dx = mouseX - state.dragStartScreen.x;
    const dy = mouseY - state.dragStartScreen.y;

    if (!state.isDragging && Math.abs(dx) < 2 && Math.abs(dy) < 2) {
      return;
    }

    state.isDragging = true;

    state.camera.x += dx;
    state.camera.y += dy;

    state.dragStartScreen = { x: mouseX, y: mouseY };
    draw();
    return;
  }

  if (state.dragMode === "marquee") {
    state.marqueeRect = normalizeRect(
      state.dragStartScreen.x,
      state.dragStartScreen.y,
      mouseX,
      mouseY
    );
    draw();
    return;
  }

  if (state.dragMode === "machine") {
    const selectedMachines = getSelectedMachines();
    if (selectedMachines.length === 0) return;

    const world = screenToWorld(mouseX, mouseY);
    const primaryOffset = state.machineDragOffsets[0];
    if (!primaryOffset) return;

    const targetPrimaryX = snap(world.x - primaryOffset.offsetX);
    const targetPrimaryY = snap(world.y - primaryOffset.offsetY);

    const deltaX = targetPrimaryX - primaryOffset.startX;
    const deltaY = targetPrimaryY - primaryOffset.startY;

    const ignoreIds = selectedMachines.map(machine => machine.id);

    function buildProposedPositions(testDeltaX, testDeltaY) {
      const proposals = [];

      for (const machine of selectedMachines) {
        const dragInfo = state.machineDragOffsets.find(item => item.id === machine.id);
        if (!dragInfo) return null;

        const newX = snap(dragInfo.startX + testDeltaX);
        const newY = snap(dragInfo.startY + testDeltaY);

        if (wouldMachineOverlap(machine, newX, newY, machine.rotation, ignoreIds)) {
          return null;
        }

        proposals.push({ machine, x: newX, y: newY });
      }

      for (let i = 0; i < proposals.length; i++) {
        for (let j = i + 1; j < proposals.length; j++) {
          const a = proposals[i];
          const b = proposals[j];

          const aRects = getMachineOccupiedRects(a.machine, a.x, a.y, a.machine.rotation);
          const bRects = getMachineOccupiedRects(b.machine, b.x, b.y, b.machine.rotation);

          if (rectSetsOverlap(aRects, bRects)) {
            return null;
          }
        }
      }

      return proposals;
    }

    const proposedPositions = buildProposedPositions(deltaX, deltaY);
    if (!proposedPositions) {
      return;
    }

    for (const proposed of proposedPositions) {
      proposed.machine.x = proposed.x;
      proposed.machine.y = proposed.y;
    }

    updateSelectedInfo();
    draw();
  }
});

window.addEventListener("mouseup", () => {
  if (state.dragMode === "marquee" && state.marqueeRect) {
    const worldRect = screenRectToWorldRect(state.marqueeRect);
    const hits = state.machines
      .filter(machine => machineIntersectsWorldRect(machine, worldRect))
      .map(machine => machine.id);

    setSelection(hits);
    state.marqueeRect = null;
    updateSelectedInfo();
    draw();
    state.dragMode = null;
    state.isDragging = false;
    return;
  }

  state.dragMode = null;
  state.marqueeRect = null;
});

window.addEventListener("keydown", event => {
  const isMac = navigator.platform.toUpperCase().includes("MAC");
  const modKey = isMac ? event.metaKey : event.ctrlKey;

  if (modKey && event.key.toLowerCase() === "c") {
    event.preventDefault();
    copySelectedMachines();
    return;
  }

  if (modKey && event.key.toLowerCase() === "x") {
    event.preventDefault();
    cutSelectedMachines();
    return;
  }

  if (modKey && event.key.toLowerCase() === "v") {
    event.preventDefault();
    pasteClipboard();
    return;
  }

  const selected = getSelectedMachines();

  if (selected.length === 0) return;

  if (event.key.toLowerCase() === "r") {
    event.preventDefault();

    const ignoreIds = selected.map(machine => machine.id);
    const proposals = buildGroupRotationProposals(selected, 90);

    if (!canApplyMachineProposals(proposals, ignoreIds)) {
      return;
    }

    for (const proposal of proposals) {
      proposal.machine.x = proposal.x;
      proposal.machine.y = proposal.y;
      proposal.machine.rotation = proposal.rotation;
    }

    updateSelectedInfo();
    draw();
    return;
  }

  if (event.key === "Delete" || event.key === "Backspace") {
    deleteSelectedMachines();
  }
});
window.getPlannerState = function () {
  return JSON.parse(JSON.stringify({
    camera: state.camera,
    machines: state.machines,
    selectedMachineIds: state.selectedMachineIds,
    clipboard: state.clipboard,
    viewMode: state.viewMode,
    lastImportedRows: state.lastImportedRows
  }));
};
window.addEventListener("resize", resizeCanvas);

loadMachineCatalog().then(() => {
  renderRecipePalette();
  resizeCanvas();
  updateSelectedInfo();
  updateViewModeUI();
});
function exportLayoutPng() {
  if (!state.machines || state.machines.length === 0) {
    alert("There is no layout to export yet.");
    return;
  }

  const exportCanvas = document.createElement("canvas");
  const exportCtx = exportCanvas.getContext("2d");

  const boundsList = state.machines.map(machine => getMachineBounds(machine));

  const minX = Math.min(...boundsList.map(b => b.left));
  const minY = Math.min(...boundsList.map(b => b.top));
  const maxX = Math.max(...boundsList.map(b => b.right));
  const maxY = Math.max(...boundsList.map(b => b.bottom));

  const padding = 4;
  const scale = 20;

  const worldLeft = minX - padding;
  const worldTop = minY - padding;
  const worldRight = maxX + padding;
  const worldBottom = maxY + padding;

  const worldWidth = worldRight - worldLeft;
  const worldHeight = worldBottom - worldTop;

  exportCanvas.width = Math.ceil(worldWidth * scale);
  exportCanvas.height = Math.ceil(worldHeight * scale);
  function exportWorldToScreen(wx, wy) {
  return {
    x: (wx - worldLeft) * scale,
    y: (wy - worldTop) * scale
  };
}



  exportCtx.clearRect(0, 0, exportCanvas.width, exportCanvas.height);

  // ===== background =====
  exportCtx.fillStyle = "#2b2b2b";
  exportCtx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);

  // ===== grid =====
  const minorStep = SNAP_SIZE;
  const foundationStep = FOUNDATION_SIZE;

  if (scale >= 12) {
    exportCtx.strokeStyle = "#1f2a33";
    exportCtx.lineWidth = 1;

    const startXMinor = Math.floor(worldLeft / minorStep) * minorStep;
    const endXMinor = Math.ceil(worldRight / minorStep) * minorStep;
    const startYMinor = Math.floor(worldTop / minorStep) * minorStep;
    const endYMinor = Math.ceil(worldBottom / minorStep) * minorStep;

    for (let x = startXMinor; x <= endXMinor; x += minorStep) {
      const sx = exportWorldToScreen(x, 0).x;
      exportCtx.beginPath();
      exportCtx.moveTo(sx, 0);
      exportCtx.lineTo(sx, exportCanvas.height);
      exportCtx.stroke();
    }

    for (let y = startYMinor; y <= endYMinor; y += minorStep) {
      const sy = exportWorldToScreen(0, y).y;
      exportCtx.beginPath();
      exportCtx.moveTo(0, sy);
      exportCtx.lineTo(exportCanvas.width, sy);
      exportCtx.stroke();
    }
  }

  exportCtx.strokeStyle = "#3a4a57";
  exportCtx.lineWidth = 1;

  const startXFoundation = Math.floor(worldLeft / foundationStep) * foundationStep;
  const endXFoundation = Math.ceil(worldRight / foundationStep) * foundationStep;
  const startYFoundation = Math.floor(worldTop / foundationStep) * foundationStep;
  const endYFoundation = Math.ceil(worldBottom / foundationStep) * foundationStep;

  for (let x = startXFoundation; x <= endXFoundation; x += foundationStep) {
    const sx = exportWorldToScreen(x, 0).x;
    exportCtx.beginPath();
    exportCtx.moveTo(sx, 0);
    exportCtx.lineTo(sx, exportCanvas.height);
    exportCtx.stroke();
  }

  for (let y = startYFoundation; y <= endYFoundation; y += foundationStep) {
    const sy = exportWorldToScreen(0, y).y;
    exportCtx.beginPath();
    exportCtx.moveTo(0, sy);
    exportCtx.lineTo(exportCanvas.width, sy);
    exportCtx.stroke();
  }

  // ===== machines =====
  for (const machine of state.machines) {
    const footprint = getMachineFootprint(machine);
    const screenPos = exportWorldToScreen(machine.x, machine.y);

    const widthPx = footprint.width * scale;
    const heightPx = footprint.length * scale;

    exportCtx.fillStyle = machine.color || "#3a3f47";
    exportCtx.fillRect(screenPos.x, screenPos.y, widthPx, heightPx);

    const buffers = getMachineBufferRects(machine);

    if (buffers.input) {
      const topLeft = exportWorldToScreen(buffers.input.left, buffers.input.top);
      const bufferWidthPx = (buffers.input.right - buffers.input.left) * scale;
      const bufferHeightPx = (buffers.input.bottom - buffers.input.top) * scale;

      exportCtx.fillStyle = "rgba(80, 200, 120, 0.22)";
      exportCtx.strokeStyle = "rgba(80, 200, 120, 0.55)";
      exportCtx.lineWidth = 1;
      exportCtx.fillRect(topLeft.x, topLeft.y, bufferWidthPx, bufferHeightPx);
      exportCtx.strokeRect(topLeft.x, topLeft.y, bufferWidthPx, bufferHeightPx);
    }

    if (buffers.output) {
      const topLeft = exportWorldToScreen(buffers.output.left, buffers.output.top);
      const bufferWidthPx = (buffers.output.right - buffers.output.left) * scale;
      const bufferHeightPx = (buffers.output.bottom - buffers.output.top) * scale;

      exportCtx.fillStyle = "rgba(255, 215, 0, 0.18)";
      exportCtx.strokeStyle = "rgba(255, 215, 0, 0.45)";
      exportCtx.lineWidth = 1;
      exportCtx.fillRect(topLeft.x, topLeft.y, bufferWidthPx, bufferHeightPx);
      exportCtx.strokeRect(topLeft.x, topLeft.y, bufferWidthPx, bufferHeightPx);
    }

    exportCtx.strokeStyle = "#0b0f14";
    exportCtx.lineWidth = 2;
    exportCtx.strokeRect(screenPos.x, screenPos.y, widthPx, heightPx);

    const labelText = machine.recipeName || machine.type || "";
    if (labelText) {
      exportCtx.fillStyle = "#0b0f14";
      exportCtx.font = "14px Arial";
      exportCtx.textAlign = "center";
      exportCtx.textBaseline = "middle";

      drawWrappedMachineLabel(
        exportCtx,
        labelText,
        screenPos.x + widthPx / 2,
        screenPos.y + heightPx / 2,
        Math.max(16, widthPx - 12),
        Math.max(16, heightPx - 12),
        14
      );

      exportCtx.textAlign = "start";
      exportCtx.textBaseline = "alphabetic";
    }

    if (machine.blockPosition) {
      exportCtx.fillStyle = "#ffffffcc";
      exportCtx.font = "10px Arial";
      exportCtx.textAlign = "right";
      exportCtx.textBaseline = "bottom";

      exportCtx.fillText(
        `${machine.blockPosition.row},${machine.blockPosition.col}`,
        screenPos.x + widthPx - 3,
        screenPos.y + heightPx - 3
      );

      exportCtx.textAlign = "start";
      exportCtx.textBaseline = "alphabetic";
    }
  }

  const link = document.createElement("a");
  link.href = exportCanvas.toDataURL("image/png");
  link.download = "planner_layout.png";
  link.click();
}

window.exportLayoutPng = exportLayoutPng;