(() => {
  "use strict";

  // Diagnostic-only V2 skeleton:
  // This file intentionally does NOT draw layout, run solver logic,
  // import/place machines, or mutate planner state.

  const CATEGORY_RECIPE = "recognized recipe / production recipe";
  const CATEGORY_MULTI = "recognized multi-machine/helper node";
  const CATEGORY_MACHINE = "recognized non-layout machine";
  const CATEGORY_SKIPPED = "skipped resource/extractor/source node";
  const CATEGORY_UNKNOWN = "unknown/unrecognized node";

  const CATEGORIES = [
    CATEGORY_RECIPE,
    CATEGORY_MULTI,
    CATEGORY_MACHINE,
    CATEGORY_SKIPPED,
    CATEGORY_UNKNOWN
  ];

  const SOURCE_EXTRACTOR_NAMES = new Set([
    "miner",
    "miner mk.1",
    "miner mk.2",
    "miner mk.3",
    "water extractor",
    "oil extractor",
    "resource well extractor"
  ]);

  const SOURCE_RESOURCE_NODE_NAMES = new Set([
    "iron ore",
    "limestone",
    "copper ore",
    "caterium ore",
    "sulfur",
    "raw quartz",
    "sam",
    "coal",
    "bauxite",
    "uranium",
    "water",
    "crude oil",
    "well water",
    "oil well",
    "nitrogen gas"
  ]);

  let gameDataLookups = null;

  function byId(...ids) {
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) {
        return el;
      }
    }
    return null;
  }

  function escapeHtml(value) {
    const str = String(value ?? "");
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function normalizeName(value) {
    return String(value ?? "").trim().toLowerCase();
  }

  function buildLookupMap(items) {
    const map = new Map();
    if (!Array.isArray(items)) {
      return map;
    }

    for (const item of items) {
      const key = normalizeName(item?.Name);
      if (key) {
        map.set(key, item);
      }
    }

    return map;
  }

  async function loadGameDataLookups() {
    const response = await fetch("data/game_data.json");
    if (!response.ok) {
      throw new Error(`Failed to load data/game_data.json (HTTP ${response.status}).`);
    }

    const data = await response.json();
    return {
      recipesByName: buildLookupMap(data?.Recipes),
      multiMachinesByName: buildLookupMap(data?.MultiMachines),
      machinesByName: buildLookupMap(data?.Machines),
      partsByName: buildLookupMap(data?.Parts)
    };
  }

  function createEmptyDiagnostic() {
    const counts = {};
    const nodesByCategory = {};

    for (const category of CATEGORIES) {
      counts[category] = 0;
      nodesByCategory[category] = [];
    }

    return {
      totalNodes: 0,
      counts,
      unknownNodeNames: [],
      nodesByCategory
    };
  }

  function isSourceExtractorName(name) {
    return SOURCE_EXTRACTOR_NAMES.has(normalizeName(name));
  }

  function isSourceResourceName(name) {
    return SOURCE_RESOURCE_NODE_NAMES.has(normalizeName(name));
  }

  function safeArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function summarizeNodeParts(node) {
    const rawParts = safeArray(node?.Parts);

    const inputParts = [];
    const outputParts = [];

    for (const partEntry of rawParts) {
      if (!partEntry || typeof partEntry !== "object") {
        continue;
      }

      const name = partEntry.Name ?? partEntry.Part ?? partEntry.Item ?? "(unnamed part)";
      const amount = partEntry.Amount ?? partEntry.Rate ?? partEntry.Value ?? partEntry.Count ?? null;
      const io = normalizeName(partEntry.IO ?? partEntry.Direction ?? partEntry.Type);

      const summarized = { name, amount };

      if (io === "input" || io === "in") {
        inputParts.push(summarized);
      } else if (io === "output" || io === "out") {
        outputParts.push(summarized);
      } else {
        // If direction is not provided, include in both lists only when explicitly flagged is unavailable.
        // We keep these under output by default so they still appear in diagnostics.
        outputParts.push(summarized);
      }
    }

    return {
      inputParts,
      outputParts,
      inputPartCount: inputParts.length,
      outputPartCount: outputParts.length
    };
  }

  function classifyNode(node, lookups) {
    const nodeName = String(node?.Name ?? "").trim();
    const normalizedNodeName = normalizeName(nodeName);

    const recipe = lookups.recipesByName.get(normalizedNodeName);
    if (recipe) {
      const recipeMachineName = recipe?.Machine ?? node?.Machine ?? null;
      if (isSourceExtractorName(recipeMachineName) || isSourceResourceName(nodeName)) {
        return { category: CATEGORY_SKIPPED, matchedAs: "recipe (source/extractor)", ref: recipe };
      }
      return { category: CATEGORY_RECIPE, matchedAs: "recipe", ref: recipe };
    }

    const multiMachine = lookups.multiMachinesByName.get(normalizedNodeName);
    if (multiMachine) {
      if (isSourceExtractorName(multiMachine?.Name) || isSourceResourceName(nodeName)) {
        return {
          category: CATEGORY_SKIPPED,
          matchedAs: "multi-machine (source/extractor)",
          ref: multiMachine
        };
      }
      return { category: CATEGORY_MULTI, matchedAs: "multi-machine", ref: multiMachine };
    }

    const machine = lookups.machinesByName.get(normalizedNodeName);
    if (machine) {
      if (isSourceExtractorName(machine?.Name) || isSourceResourceName(nodeName)) {
        return { category: CATEGORY_SKIPPED, matchedAs: "machine (source/extractor)", ref: machine };
      }
      return { category: CATEGORY_MACHINE, matchedAs: "machine", ref: machine };
    }

    const part = lookups.partsByName.get(normalizedNodeName);
    if (part) {
      return { category: CATEGORY_SKIPPED, matchedAs: "part/source node", ref: part };
    }

    if (isSourceResourceName(nodeName)) {
      return { category: CATEGORY_SKIPPED, matchedAs: "source/resource name", ref: null };
    }

    return { category: CATEGORY_UNKNOWN, matchedAs: "unknown", ref: null };
  }

  function createNodeDiagnosticEntry(index, node, classification) {
    const nodeName = String(node?.Name ?? "(unnamed node)");
    const partSummary = summarizeNodeParts(node);

    return {
      index,
      name: nodeName,
      matchedAs: classification.matchedAs,
      machine: node?.Machine ?? classification.ref?.Machine ?? null,
      max: node?.Max ?? classification.ref?.DefaultMax ?? null,
      inputPartCount: partSummary.inputPartCount,
      outputPartCount: partSummary.outputPartCount,
      inputParts: partSummary.inputParts,
      outputParts: partSummary.outputParts,
      variants: safeArray(node?.Variants).length ? node.Variants : safeArray(classification.ref?.Machines),
      capacities: safeArray(node?.Capacities).length
        ? node.Capacities
        : safeArray(classification.ref?.Capacities)
    };
  }

  function runSfmdDiagnostic(sfmdJson, lookups) {
    if (!sfmdJson || typeof sfmdJson !== "object") {
      throw new Error("SFMD JSON root is invalid.");
    }

    if (!Array.isArray(sfmdJson.Data)) {
      throw new Error("SFMD file is missing a valid Data array.");
    }

    const diagnostic = createEmptyDiagnostic();
    diagnostic.totalNodes = sfmdJson.Data.length;

    const unknownNamesSet = new Set();

    sfmdJson.Data.forEach((node, index) => {
      const classification = classifyNode(node, lookups);
      const category = classification.category;

      diagnostic.counts[category] += 1;

      const entry = createNodeDiagnosticEntry(index, node, classification);
      diagnostic.nodesByCategory[category].push(entry);

      if (category === CATEGORY_UNKNOWN) {
        unknownNamesSet.add(entry.name);
      }
    });

    diagnostic.unknownNodeNames = [...unknownNamesSet].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" })
    );

    return diagnostic;
  }

  function setSummaryHtml(html) {
    const summaryEl = byId("sfmdDiagnosticSummary");
    if (summaryEl) {
      summaryEl.innerHTML = html;
    }
  }

  function setOutputHtml(html) {
    const outputEl = byId("sfmdDiagnosticOutput");
    if (outputEl) {
      outputEl.innerHTML = html;
    }
  }

  function renderDiagnostic(diagnostic) {
    const summaryRows = [
      `<div><strong>Total nodes:</strong> ${escapeHtml(diagnostic.totalNodes)}</div>`,
      ...CATEGORIES.map((category) =>
        `<div><strong>${escapeHtml(category)}:</strong> ${escapeHtml(diagnostic.counts[category])}</div>`
      ),
      `<div><strong>Unknown node names:</strong> ${escapeHtml(diagnostic.unknownNodeNames.length)}</div>`
    ];

    setSummaryHtml(summaryRows.join(""));

    const jsonText = JSON.stringify(diagnostic, null, 2);
    setOutputHtml(escapeHtml(jsonText));

    console.log("SFMD diagnostic result:", diagnostic);
  }

  function renderError(message) {
    const safeMessage = escapeHtml(message);
    setSummaryHtml(`<div><strong>Error:</strong> ${safeMessage}</div>`);
    setOutputHtml(safeMessage);
    console.error("SFMD diagnostic error:", message);
  }

  function validateFileSelection(file) {
    if (!file) {
      throw new Error("No file selected. Please choose a .sfmd or .json file.");
    }

    const fileName = String(file.name || "");
    const lower = fileName.toLowerCase();
    if (!lower.endsWith(".sfmd") && !lower.endsWith(".json")) {
      throw new Error("Unsupported file type. Please select a .sfmd or .json file.");
    }
  }

  async function parseUploadedSfmd(file) {
    validateFileSelection(file);

    const text = await file.text();
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`Invalid JSON in uploaded file: ${error.message}`);
    }
  }

  async function handleRunDiagnosticClick() {
    try {
      if (!gameDataLookups) {
        throw new Error("Game data is not loaded yet. Please wait and try again.");
      }

      const fileInputEl = byId("importFactoryFile", "factoryFileInput");
      const file = fileInputEl?.files?.[0];
      const sfmdJson = await parseUploadedSfmd(file);
      const diagnostic = runSfmdDiagnostic(sfmdJson, gameDataLookups);

      renderDiagnostic(diagnostic);
    } catch (error) {
      renderError(error?.message ?? String(error));
    }
  }

  function wireUi() {
    const runBtn = byId("runSfmdDiagnosticBtn", "importFactoryBtn");

    if (runBtn) {
      runBtn.addEventListener("click", handleRunDiagnosticClick);
    } else {
      console.warn(
        "Missing #runSfmdDiagnosticBtn (or fallback #importFactoryBtn). SFMD diagnostic trigger is not wired."
      );
    }

    const fileInputEl = byId("importFactoryFile", "factoryFileInput");
    if (!fileInputEl) {
      console.warn(
        "Missing #importFactoryFile (or fallback #factoryFileInput). File uploads will not be available."
      );
    }

    if (!byId("sfmdDiagnosticSummary")) {
      console.warn("Missing #sfmdDiagnosticSummary. Summary output will only be logged to console.");
    }

    if (!byId("sfmdDiagnosticOutput")) {
      console.warn("Missing #sfmdDiagnosticOutput. Detailed output will only be logged to console.");
    }
  }

  async function init() {
    wireUi();

    try {
      gameDataLookups = await loadGameDataLookups();
      setSummaryHtml("<div>Game data loaded. Ready to run SFMD diagnostic.</div>");
    } catch (error) {
      renderError(error?.message ?? "Failed to load data/game_data.json.");
    }
  }

  init();
})();