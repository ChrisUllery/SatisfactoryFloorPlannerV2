const canvas = document.getElementById("plannerCanvas");
const ctx = canvas.getContext("2d");

const newLayoutBtn = document.getElementById("newLayoutBtn");
const fitViewBtn = document.getElementById("fitViewBtn");
const importFactoryBtn = document.getElementById("importFactoryBtn");
const factoryFileInput = document.getElementById("factoryFileInput");
const statusText = document.getElementById("statusText");

const GRID_SIZE = 8;

const state = {
  camera: {
    x: 0,
    y: 0,
    zoom: 24
  },
  machines: [],
  appReady: false
};

function setStatus(message) {
  statusText.textContent = message;
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;

  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  draw();
}

function worldToScreen(worldX, worldY) {
  return {
    x: worldX * state.camera.zoom + state.camera.x,
    y: worldY * state.camera.zoom + state.camera.y
  };
}

function screenToWorld(screenX, screenY) {
  return {
    x: (screenX - state.camera.x) / state.camera.zoom,
    y: (screenY - state.camera.y) / state.camera.zoom
  };
}

function centerCameraOnOrigin() {
  const rect = canvas.getBoundingClientRect();

  state.camera.x = rect.width / 2;
  state.camera.y = rect.height / 2;
  state.camera.zoom = 24;

  draw();
}

function drawBackground() {
  const rect = canvas.getBoundingClientRect();

  ctx.fillStyle = "#080b10";
  ctx.fillRect(0, 0, rect.width, rect.height);
}

function drawGrid() {
  const rect = canvas.getBoundingClientRect();

  const topLeft = screenToWorld(0, 0);
  const bottomRight = screenToWorld(rect.width, rect.height);

  const startX = Math.floor(topLeft.x / GRID_SIZE) * GRID_SIZE;
  const endX = Math.ceil(bottomRight.x / GRID_SIZE) * GRID_SIZE;

  const startY = Math.floor(topLeft.y / GRID_SIZE) * GRID_SIZE;
  const endY = Math.ceil(bottomRight.y / GRID_SIZE) * GRID_SIZE;

  ctx.lineWidth = 1;
  ctx.strokeStyle = "#1f2937";

  for (let x = startX; x <= endX; x += GRID_SIZE) {
    const screen = worldToScreen(x, 0);

    ctx.beginPath();
    ctx.moveTo(screen.x, 0);
    ctx.lineTo(screen.x, rect.height);
    ctx.stroke();
  }

  for (let y = startY; y <= endY; y += GRID_SIZE) {
    const screen = worldToScreen(0, y);

    ctx.beginPath();
    ctx.moveTo(0, screen.y);
    ctx.lineTo(rect.width, screen.y);
    ctx.stroke();
  }
}

function drawOriginMarker() {
  const origin = worldToScreen(0, 0);

  ctx.strokeStyle = "#f97316";
  ctx.lineWidth = 2;

  ctx.beginPath();
  ctx.moveTo(origin.x - 12, origin.y);
  ctx.lineTo(origin.x + 12, origin.y);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(origin.x, origin.y - 12);
  ctx.lineTo(origin.x, origin.y + 12);
  ctx.stroke();
}

function drawEmptyStateMessage() {
  const rect = canvas.getBoundingClientRect();

  ctx.fillStyle = "#9da7b3";
  ctx.font = "16px Arial";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ctx.fillText(
    "Blank planner canvas — import and machine placement coming next.",
    rect.width / 2,
    40
  );

  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
}

function drawMachines() {
  for (const machine of state.machines) {
    const screen = worldToScreen(machine.x, machine.y);

    ctx.fillStyle = machine.color || "#2f81f7";
    ctx.fillRect(
      screen.x,
      screen.y,
      machine.width * state.camera.zoom,
      machine.length * state.camera.zoom
    );
  }
}

function draw() {
  drawBackground();
  drawGrid();
  drawOriginMarker();
  drawMachines();

  if (state.machines.length === 0) {
    drawEmptyStateMessage();
  }
}

function resetLayout() {
  state.machines = [];
  centerCameraOnOrigin();
  setStatus("New blank layout created.");
}

function handleImportClick() {
  const file = factoryFileInput.files?.[0];

  if (!file) {
    setStatus("Choose a .sfmd or .json file first.");
    return;
  }

  setStatus(`Import selected: ${file.name}. Import parser not wired yet.`);
}

function init() {
  state.appReady = true;

  resizeCanvas();
  centerCameraOnOrigin();

  newLayoutBtn.addEventListener("click", resetLayout);
  fitViewBtn.addEventListener("click", centerCameraOnOrigin);
  importFactoryBtn.addEventListener("click", handleImportClick);

  window.addEventListener("resize", resizeCanvas);

  setStatus("Ready. Blank V2 shell loaded.");
}

init();