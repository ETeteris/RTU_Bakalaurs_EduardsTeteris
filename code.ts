/// <reference types="@figma/plugin-typings" />

figma.showUI(__html__, { width: 380, height: 700 });

// Avota mezglu atsauces no Generate Library skenēšanas. Glabā moduļa līmenī,
// lai createLibraryComponents() varētu atrast oriģinālus pēc UI fetch atgriešanās.
let componentReferences: any[] = [];

let originalFrameHeight: number = 852;
let originalFrameAbsY: number   = 0;

// yFrakcijas katram mezglam pēc nosaukuma. Jāaprēķina pirms lapas maiņas, jo
// absoluteBoundingBox pēc tam vairs nedod pareizas vērtības.
let componentYFracMap = new Map<string, number>();

// Bibliotēkas komponentes, ko ievietot nākamajā ģenerētajā ekrānā.
let screenPlacedComponents: Array<{ nodeId: string; name: string; targetX: number; targetY: number; height: number }> = [];

// UX Journey stāvoklis
let journeyScreens: string[]  = [];
let journeyIndex: number      = 0;
let journeyFrameIds: string[] = [];
let journeyScreenWidth: number  = 393;
let journeyScreenHeight: number = 852;

// ── Ziņojumu maršrutētājs ────────────────────────────────────────────────────
figma.ui.onmessage = async (msg: any) => {
  if (msg.type === "execute-prompt") {
    await handleExecutePrompt(msg.prompt);
  }
  if (msg.type === "generate-library") {
    await handleGenerateLibrary();
  }
  if (msg.type === "generate-screen") {
    await handleGenerateScreen(msg.prompt, msg.screenWidth, msg.screenHeight);
  }
  if (msg.type === "generate-journey") {
    await handleGenerateJourney(msg.input, msg.screenWidth, msg.screenHeight);
  }
  if (msg.type === "execute-prompt-result") {
    await applyExecutePromptResult(msg.data, msg.originalFrame);
  }
  if (msg.type === "generate-library-result") {
    postProgress("Creating Asset Library page...");
    await createLibraryComponents(msg.data.library, msg.data.colorPalette);
  }
  if (msg.type === "generate-screen-result") {
    if (msg.isJourney) {
      const frame = await applyGenerateScreenResult(msg.data, true);
      await continueJourney(frame);
    } else {
      await applyGenerateScreenResult(msg.data, false);
    }
  }
  if (msg.type === "fetch-error") {
    figma.ui.postMessage({ type: "error", message: msg.message });
  }
};

function postProgress(message: string) {
  figma.ui.postMessage({ type: "progress", message: message });
}

// ── Krāsu konvertēšana ───────────────────────────────────────────────────────
// Figma glabā krāsas kā 0-1 RGB, Claude vēlas hex.

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (c: number) => Math.round(c * 255).toString(16).padStart(2, "0");
  return "#" + toHex(r) + toHex(g) + toHex(b);
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return { r: 1, g: 1, b: 1 };
  return {
    r: parseInt(result[1], 16) / 255,
    g: parseInt(result[2], 16) / 255,
    b: parseInt(result[3], 16) / 255,
  };
}

// Rekursīvi savāc visas redzamās aizpildījuma un kontūru krāsas hex formātā.
function extractAllColors(node: any, colorSet: Set<string>) {
  if (node.fills) {
    for (var i = 0; i < node.fills.length; i++) {
      var fill = node.fills[i];
      if (fill.type === "SOLID" && fill.visible !== false) {
        colorSet.add(rgbToHex(fill.color.r, fill.color.g, fill.color.b));
      }
    }
  }
  if (node.strokes) {
    for (var j = 0; j < node.strokes.length; j++) {
      var stroke = node.strokes[j];
      if (stroke.type === "SOLID" && stroke.visible !== false) {
        colorSet.add(rgbToHex(stroke.color.r, stroke.color.g, stroke.color.b));
      }
    }
  }
  if (node.children) {
    for (var k = 0; k < node.children.length; k++) {
      extractAllColors(node.children[k], colorSet);
    }
  }
}

function collectInstances(node: any, out: any[]) {
  if (node.type === "INSTANCE") out.push(node);
  if (node.children) {
    for (var i = 0; i < node.children.length; i++) collectInstances(node.children[i], out);
  }
}

// Atvieno visas instances vairākās iterācijās — viena reize nepietiek, jo
// ārējās instances atvienošana var atklāt iekšējās, kas iepriekš nebija pieejamas.
function detachAllInstances(root: any) {
  for (var pass = 0; pass < 20; pass++) {
    var instances: any[] = [];
    collectInstances(root, instances);
    if (instances.length === 0) break;
    for (var i = 0; i < instances.length; i++) {
      try { instances[i].detachInstance(); } catch (_) {}
    }
  }
}

// Pārkrāso visus mezgla aizpildījumus un kontūras pēc colorMap. Object.assign
// saglabā citas fill īpašības (opacity, blendMode), maina tikai color.
function applyColorMap(node: any, colorMap: { [key: string]: string }) {
  if (node.fills && node.fills.length > 0) {
    var newFills = [];
    for (var i = 0; i < node.fills.length; i++) {
      var fill = node.fills[i];
      if (fill.type === "SOLID") {
        var hex = rgbToHex(fill.color.r, fill.color.g, fill.color.b);
        if (colorMap[hex]) {
          newFills.push(Object.assign({}, fill, { color: hexToRgb(colorMap[hex]) }));
        } else {
          newFills.push(fill);
        }
      } else {
        newFills.push(fill);
      }
    }
    try { node.fills = newFills; } catch (_) {}
  }

  if (node.strokes && node.strokes.length > 0) {
    var newStrokes = [];
    for (var m = 0; m < node.strokes.length; m++) {
      var stroke = node.strokes[m];
      if (stroke.type === "SOLID") {
        var strokeHex = rgbToHex(stroke.color.r, stroke.color.g, stroke.color.b);
        if (colorMap[strokeHex]) {
          newStrokes.push(Object.assign({}, stroke, { color: hexToRgb(colorMap[strokeHex]) }));
        } else {
          newStrokes.push(stroke);
        }
      } else {
        newStrokes.push(stroke);
      }
    }
    try { node.strokes = newStrokes; } catch (_) {}
  }

  if (node.children) {
    for (var n = 0; n < node.children.length; n++) {
      applyColorMap(node.children[n], colorMap);
    }
  }
}

// ── Execute prompt (krāsu pārveidošana) ──────────────────────────────────────

async function handleExecutePrompt(prompt: string) {
  const selection = figma.currentPage.selection;

  if (selection.length === 0) {
    figma.ui.postMessage({ type: "execute-error", message: "Please select a frame first." });
    return;
  }

  const selectedNode = selection[0] as any;

  if (selectedNode.type !== "FRAME" && selectedNode.type !== "COMPONENT") {
    figma.ui.postMessage({ type: "execute-error", message: "Please select a frame or component." });
    return;
  }

  postProgress("Reading colors from frame...");
  const colorSet = new Set<string>();
  extractAllColors(selectedNode, colorSet);
  const colors = Array.from(colorSet);
  postProgress("Found " + colors.length + " unique colors");

  // UI veic fetch, jo galvenais pavediens nevar veikt tīkla pieprasījumus.
  figma.ui.postMessage({
    type: "do-fetch-execute-prompt",
    prompt: prompt,
    colors: colors,
    frameName: selectedNode.name,
    frameId: selectedNode.id,
  });
}

async function applyExecutePromptResult(data: any, frameId: string) {
  if (data.action === "restyle_duplicate" && data.colorMap) {
    const sourceNode = await figma.getNodeByIdAsync(frameId) as any;
    if (!sourceNode) {
      figma.ui.postMessage({ type: "execute-error", message: "Could not find the selected frame." });
      return;
    }

    postProgress("Applying color changes to duplicate...");

    const duplicate = sourceNode.clone();
    duplicate.name = data.newFrameName || (sourceNode.name + " - restyled");
    duplicate.x = sourceNode.x + sourceNode.width + 120;
    duplicate.y = sourceNode.y;
    figma.currentPage.appendChild(duplicate);

    // Instances ar slēgtām iekšējām īpašībām — atvienojam, lai krāsas kļūtu pārrakstāmas.
    detachAllInstances(duplicate);
    applyColorMap(duplicate, data.colorMap);

    figma.currentPage.selection = [duplicate];
    figma.viewport.scrollAndZoomIntoView([duplicate]);

    postProgress("Created \"" + duplicate.name + "\"");
    figma.ui.postMessage({ type: "execute-success", message: data.description || "Done! New frame created." });

  } else if (data.action === "unsupported") {
    figma.ui.postMessage({ type: "execute-response", message: data.description });
  } else {
    figma.ui.postMessage({ type: "execute-error", message: "Unexpected response from backend." });
  }
}

// ── Generate Screen ──────────────────────────────────────────────────────────

// Nolasa Asset Library lapu un atgriež visu, ko backend vajag plānošanai:
// krāsas, fontus, paleti pēc lomām, kategoriju nosaukumus un komponentes.
async function extractStylesFromLibrary(): Promise<{
  colors: string[];
  fonts: string[];
  palette: { [role: string]: string[] } | null;
  categories: string[];
  libraryComponents: Array<{ nodeId: string; name: string; category: string; width: number; height: number; yFraction: number; zone: string }>;
}> {
  const libraryPage = figma.root.children.find((p: any) => p.name === "Asset Library") as any;

  if (!libraryPage) {
    postProgress("No Asset Library page found — generating with default styles");
    return { colors: [], fonts: [], palette: null, categories: [], libraryComponents: [] as Array<{ nodeId: string; name: string; category: string; width: number; height: number; yFraction: number; zone: string }> };
  }

  // dynamic-page režīmā lapas saturs jāielādē tiešā veidā.
  if (libraryPage !== figma.currentPage) {
    await libraryPage.loadAsync();
  }

  // Struktūrētā palete glabājas Color Palette rāmja plugin data.
  let palette: { [role: string]: string[] } | null = null;
  const paletteFrame = libraryPage.children.find((c: any) => c.name === "Color Palette") as any;
  if (paletteFrame) {
    try {
      const stored = paletteFrame.getPluginData("colorPalette");
      if (stored) palette = JSON.parse(stored);
    } catch (_) {}
  }

  const categories: string[] = libraryPage.children
    .filter((c: any) => c.name !== "Color Palette" && c.type === "FRAME")
    .map((c: any) => c.name.toLowerCase());

  const colorSet = new Set<string>();
  const fontSet = new Set<string>();

  function walk(node: any) {
    if (node.fills) {
      for (var i = 0; i < node.fills.length; i++) {
        var f = node.fills[i];
        if (f.type === "SOLID" && f.visible !== false) {
          colorSet.add(rgbToHex(f.color.r, f.color.g, f.color.b));
        }
      }
    }
    if (node.type === "TEXT" && node.fontName && node.fontName.family) {
      fontSet.add(node.fontName.family);
    }
    if (node.children) {
      for (var i = 0; i < node.children.length; i++) walk(node.children[i]);
    }
  }

  for (var i = 0; i < libraryPage.children.length; i++) {
    if (libraryPage.children[i].name !== "Color Palette") {
      walk(libraryPage.children[i]);
    }
  }

  const libraryComponents: Array<{ nodeId: string; name: string; category: string; width: number; height: number; yFraction: number; zone: string }> = [];

  // COMPONENT/COMPONENT_SET/INSTANCE — uzskatām par lapām. Citādi iekšējie
  // varianti (piem. statusa josla galvenes iekšienē) parādītos kandidātu sarakstā
  // un Claude varētu atlasīt abas, radot pārklājušās komponentes ekrānā.
  function collectLibComps(node: any, parentCategory: string) {
    const isLeaf =
      node.type === "COMPONENT" ||
      node.type === "COMPONENT_SET" ||
      node.type === "INSTANCE";
    if (isLeaf) {
      const rawY = node.getPluginData("yFraction");
      const yFraction = rawY ? parseFloat(rawY) : 0.5;
      const storedCat = node.getPluginData("category");
      const category = storedCat || parentCategory || "";
      const zone = yFraction < 0.12 ? "top" : yFraction > 0.80 ? "bottom" : "middle";
      libraryComponents.push({
        nodeId: node.id,
        name: node.name,
        category,
        width: Math.round(node.width),
        height: Math.round(node.height),
        yFraction,
        zone,
      });
      return;
    }
    if (node.children) {
      const childCat = (node.type === "FRAME" && node.name !== "Color Palette")
        ? node.name
        : parentCategory;
      node.children.forEach((c: any) => collectLibComps(c, childCat));
    }
  }
  libraryPage.children.forEach((c: any) => {
    if (c.name !== "Color Palette") collectLibComps(c, "");
  });

  return {
    colors:     Array.from(colorSet).slice(0, 20),
    fonts:      Array.from(fontSet).slice(0, 5),
    palette,
    categories,
    libraryComponents,
  };
}

async function handleGenerateScreen(prompt: string, screenWidth?: number, screenHeight?: number) {
  const styles = await extractStylesFromLibrary();
  postProgress(
    "Extracted " + styles.colors.length + " colors, " +
    styles.fonts.length + " fonts, " +
    styles.libraryComponents.length + " library components"
  );

  figma.ui.postMessage({
    type: "do-fetch-generate-screen",
    prompt: prompt,
    colors: styles.colors,
    fonts: styles.fonts,
    palette: styles.palette,
    categories: styles.categories,
    libraryComponents: styles.libraryComponents,
    screenWidth: screenWidth || 393,
    screenHeight: screenHeight || 852,
  });
}

// Backend atlases sarakstu pārtulko uz reāliem bibliotēkas mezgliem.
async function resolveSelectedComponents(selection: any): Promise<void> {
  screenPlacedComponents = [];
  if (!selection || !Array.isArray(selection) || selection.length === 0) return;
  const libPage = figma.root.children.find((p: any) => p.name === "Asset Library") as any;
  if (!libPage) return;
  if (libPage !== figma.currentPage) await libPage.loadAsync();

  const nameMap = new Map<string, any>();
  function index(node: any) {
    if (node.type === "COMPONENT" || node.type === "COMPONENT_SET" || node.type === "INSTANCE") {
      if (!nameMap.has(node.name)) nameMap.set(node.name, node);
      return;
    }
    if (node.children) node.children.forEach((c: any) => index(c));
  }
  libPage.children.forEach((c: any) => index(c));

  for (var i = 0; i < selection.length; i++) {
    const sel = selection[i];
    if (!sel || typeof sel.name !== "string") continue;
    const node = nameMap.get(sel.name);
    if (!node) {
      postProgress("Selection skipped (not found): " + sel.name);
      continue;
    }
    screenPlacedComponents.push({
      nodeId: node.id,
      name: node.name,
      targetX: typeof sel.x === "number" ? Math.round(sel.x) : 0,
      targetY: typeof sel.y === "number" ? Math.round(sel.y) : 0,
      height: Math.round(node.height),
    });
  }
}

// silent=true klusajā režīmā Journey režīmā, lai starp ekrāniem nemirgo paziņojumi.
async function applyGenerateScreenResult(data: any, silent: boolean = false): Promise<any> {
  try {
    if (!data || !data.elements || !Array.isArray(data.elements)) {
      if (!silent) {
        figma.ui.postMessage({ type: "screen-error", message: "Backend returned an invalid layout. Try again or simplify the prompt." });
      }
      return null;
    }

    await resolveSelectedComponents(data._selection);
    if (screenPlacedComponents.length > 0) {
      postProgress("Reusing " + screenPlacedComponents.length + " library component(s)");
    }

    const screenFrame = figma.createFrame();
    screenFrame.name = data.frameName || "Generated Screen";
    screenFrame.resize(Math.max(1, data.width || 390), Math.max(1, data.height || 844));
    screenFrame.fills = [{ type: "SOLID", color: hexToRgb(data.backgroundColor || "#FFFFFF") }];

    // Jaunais rāmis pa labi no esošā satura.
    var maxRight = 0;
    for (var ci = 0; ci < figma.currentPage.children.length; ci++) {
      var ch = figma.currentPage.children[ci] as any;
      var r = ch.x + ch.width;
      if (r > maxRight) maxRight = r;
    }
    screenFrame.x = maxRight > 0 ? maxRight + 120 : 0;
    screenFrame.y = 0;

    // Fontus jāielādē pirms text mezglu izveides.
    const fontsToLoad = new Set<string>();
    fontsToLoad.add("Inter");
    for (var fi = 0; fi < data.elements.length; fi++) {
      if (data.elements[fi].type === "text" && data.elements[fi].fontFamily) {
        fontsToLoad.add(data.elements[fi].fontFamily);
      }
    }
    const fontArr = Array.from(fontsToLoad);
    for (var fj = 0; fj < fontArr.length; fj++) {
      try { await figma.loadFontAsync({ family: fontArr[fj], style: "Regular" }); } catch (_) {}
      try { await figma.loadFontAsync({ family: fontArr[fj], style: "Medium" });  } catch (_) {}
      try { await figma.loadFontAsync({ family: fontArr[fj], style: "Bold" });    } catch (_) {}
    }

    var placed = 0;

    for (var i = 0; i < data.elements.length; i++) {
      var el = data.elements[i];
      try {
        if (el.type === "rect") {
          var rect = figma.createRectangle();
          rect.name = el.name || "Shape";
          rect.x = el.x || 0;
          rect.y = el.y || 0;
          rect.resize(Math.max(1, el.width || 100), Math.max(1, el.height || 40));
          if (el.color) rect.fills = [{ type: "SOLID", color: hexToRgb(el.color) }];
          if (el.cornerRadius) rect.cornerRadius = el.cornerRadius;
          if (el.opacity !== undefined) rect.opacity = el.opacity;
          screenFrame.appendChild(rect);
          placed++;
        } else if (el.type === "text") {
          var textNode = figma.createText();
          textNode.name = el.name || "Text";
          textNode.x = el.x || 0;
          textNode.y = el.y || 0;
          var family = el.fontFamily || "Inter";
          var style = el.fontWeight === "Bold" ? "Bold" : (el.fontWeight === "Medium" ? "Medium" : "Regular");
          try {
            textNode.fontName = { family: family, style: style };
          } catch (_) {
            textNode.fontName = { family: "Inter", style: "Regular" };
          }
          textNode.fontSize = el.fontSize || 14;
          textNode.characters = el.text || "";
          if (el.color) textNode.fills = [{ type: "SOLID", color: hexToRgb(el.color) }];
          if (el.width) textNode.resize(el.width, textNode.height);
          if (el.textAlign === "CENTER") textNode.textAlignHorizontal = "CENTER";
          else if (el.textAlign === "RIGHT")  textNode.textAlignHorizontal = "RIGHT";
          if (el.opacity !== undefined) textNode.opacity = el.opacity;
          screenFrame.appendChild(textNode);
          placed++;
        }
      } catch (_) {
        postProgress("Skipped element: " + (el.name || el.type));
      }
    }

    // Izvietojam atlasītās bibliotēkas komponentes virsū.
    if (screenPlacedComponents.length > 0) {
      const libPage = figma.root.children.find((p: any) => p.name === "Asset Library") as any;
      if (libPage && libPage !== figma.currentPage) await libPage.loadAsync();
      for (var pi = 0; pi < screenPlacedComponents.length; pi++) {
        const pc = screenPlacedComponents[pi];
        try {
          const libNode = await figma.getNodeByIdAsync(pc.nodeId) as any;
          if (!libNode) continue;
          // INSTANCE bibliotēkas ierakstam meklējam oriģinālo masteru, lai
          // saglabātu variantu pārslēgšanu un izmēra elastību.
          let master: any = null;
          if (libNode.type === "COMPONENT" || libNode.type === "COMPONENT_SET") {
            master = libNode;
          } else if (libNode.type === "INSTANCE") {
            try {
              if (typeof libNode.getMainComponentAsync === "function") {
                master = await libNode.getMainComponentAsync();
              }
            } catch (_) {}
            if (!master) {
              try { master = libNode.mainComponent; } catch (_) {}
            }
          }
          if (!master) continue;
          const inst = master.createInstance();
          inst.x = pc.targetX || 0;
          inst.y = pc.targetY;
          // Stiepjam tikai pilna platuma komponentes (galvenes, navi).
          if (libNode.width >= screenFrame.width * 0.9) {
            try { inst.resize(screenFrame.width, inst.height); } catch (_) {}
          }
          screenFrame.appendChild(inst);
          postProgress("Placed: \"" + pc.name + "\" at " + pc.targetX + "," + pc.targetY);
        } catch (_) {}
      }
    }

    if (!silent) {
      figma.currentPage.selection = [screenFrame];
      figma.viewport.scrollAndZoomIntoView([screenFrame]);
      figma.ui.postMessage({
        type: "screen-success",
        message: "Created \"" + screenFrame.name + "\" with " + placed + " elements.",
      });
    }

    return screenFrame;

  } catch (err: any) {
    if (!silent) {
      figma.ui.postMessage({ type: "screen-error", message: "Error building screen: " + (err.message || String(err)) });
    }
    return null;
  }
}

// ── UX Journey ───────────────────────────────────────────────────────────────

async function handleGenerateJourney(input: string, screenWidth?: number, screenHeight?: number) {
  // Atdalītāji: →, komats vai jauna rinda.
  const screens = input
    .split(/[→,\n]+/)
    .map(function(s: string) { return s.trim(); })
    .filter(function(s: string) { return s.length > 0; });

  if (screens.length < 2) {
    figma.ui.postMessage({
      type: "journey-error",
      message: "Enter at least 2 screen names separated by → or commas.",
    });
    return;
  }

  journeyScreens      = screens;
  journeyIndex        = 0;
  journeyFrameIds     = [];
  journeyScreenWidth  = screenWidth  || 393;
  journeyScreenHeight = screenHeight || 852;

  figma.ui.postMessage({
    type: "journey-progress",
    current: 0,
    total: screens.length,
    message: "Starting: " + screens.join(" → "),
  });

  await startNextJourneyScreen();
}

async function startNextJourneyScreen() {
  const screenName = journeyScreens[journeyIndex];
  postProgress("Journey [" + (journeyIndex + 1) + "/" + journeyScreens.length + "]: generating " + screenName);

  const styles = await extractStylesFromLibrary();

  figma.ui.postMessage({
    type: "do-fetch-generate-screen",
    prompt: screenName,
    colors: styles.colors,
    fonts: styles.fonts,
    palette: styles.palette,
    categories: styles.categories,
    libraryComponents: styles.libraryComponents,
    isJourney: true,
    screenWidth: journeyScreenWidth,
    screenHeight: journeyScreenHeight,
  });
}

async function continueJourney(frame: any) {
  if (!frame) {
    figma.ui.postMessage({
      type: "journey-error",
      message: "Failed to generate screen " + (journeyIndex + 1) +
        " (" + (journeyScreens[journeyIndex] || "unknown") + "). Journey stopped.",
    });
    return;
  }

  journeyFrameIds.push(frame.id);
  journeyIndex++;

  figma.ui.postMessage({
    type: "journey-progress",
    current: journeyIndex,
    total: journeyScreens.length,
    message: "✓ " + journeyScreens[journeyIndex - 1],
  });

  if (journeyIndex < journeyScreens.length) {
    await startNextJourneyScreen();
  } else {
    await drawJourneyArrows();
    figma.ui.postMessage({
      type: "journey-complete",
      message: journeyScreens.length + " screens generated.",
    });
  }
}

// Bultiņas un nosaukumu uzraksti starp ģenerētajiem ekrāniem.
async function drawJourneyArrows() {
  try { await figma.loadFontAsync({ family: "Inter", style: "Regular" }); } catch (_) {}
  try { await figma.loadFontAsync({ family: "Inter", style: "Bold" });    } catch (_) {}

  const nodes: any[] = [];

  for (var i = 0; i < journeyFrameIds.length; i++) {
    const frame = await figma.getNodeByIdAsync(journeyFrameIds[i]) as any;
    if (!frame) continue;
    nodes.push(frame);

    try {
      const lbl = figma.createText();
      try { lbl.fontName = { family: "Inter", style: "Bold" };    }
      catch (_) { lbl.fontName = { family: "Inter", style: "Regular" }; }
      lbl.characters = journeyScreens[i];
      lbl.fontSize   = 14;
      lbl.fills      = [{ type: "SOLID", color: { r: 0.18, g: 0.18, b: 0.18 } }];
      lbl.x = Math.round(frame.x + (frame.width - lbl.width) / 2);
      lbl.y = frame.y + frame.height + 16;
      figma.currentPage.appendChild(lbl);
    } catch (_) {}

    if (i < journeyFrameIds.length - 1) {
      const nextFrame = await figma.getNodeByIdAsync(journeyFrameIds[i + 1]) as any;
      if (!nextFrame) continue;
      try {
        const arrow = figma.createText();
        try { arrow.fontName = { family: "Inter", style: "Regular" }; } catch (_) {}
        arrow.characters = "→";
        arrow.fontSize   = 28;
        arrow.fills      = [{ type: "SOLID", color: { r: 0.26, g: 0.49, b: 0.48 } }];
        const gap = nextFrame.x - (frame.x + frame.width);
        arrow.x = Math.round(frame.x + frame.width + gap / 2 - 14);
        arrow.y = Math.round(frame.y + frame.height / 2 - 14);
        figma.currentPage.appendChild(arrow);
      } catch (_) {}
    }
  }

  if (nodes.length > 0) {
    figma.currentPage.selection = nodes;
    figma.viewport.scrollAndZoomIntoView(nodes);
  }
}

// ── Generate Library ─────────────────────────────────────────────────────────

function getSelectedFrameOrComponent(): any | null {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    figma.ui.postMessage({ type: "error", message: "Please select a frame first" });
    return null;
  }
  const node = selection[0];
  if (node.type !== "FRAME" && node.type !== "COMPONENT") {
    figma.ui.postMessage({ type: "error", message: "Please select a frame or component" });
    return null;
  }
  return node;
}

// Rekursīvi savāc metadatus par katru atlasītā rāmja apakšmezglu.
function extractComponentsFromFrame(): any[] {
  componentReferences = [];
  postProgress("Reading selection...");

  const selectedNode = getSelectedFrameOrComponent();
  if (!selectedNode) return [];

  const components: any[] = [];
  var count = 0;

  function findComponents(node: any, path: string) {
    if (node !== selectedNode) {
      count++;
      components.push({
        name: node.name,
        width: node.width,
        height: node.height,
        x: node.x,
        y: node.y,
        type: node.type,
        id: node.id,
        nodeRef: node,
      });
      if (count % 10 === 0) postProgress("Scanned " + count + " layers...");
    }
    if (node.children) {
      for (var i = 0; i < node.children.length; i++) {
        findComponents(node.children[i], path + "/" + node.children[i].name);
      }
    }
  }

  findComponents(selectedNode, selectedNode.name);

  // Dedublikācija pēc nosaukuma — citādi atkārtoti slāņi (piem., ikona 20 pogās)
  // tiek savākti vairākkārt un Claude saņem tos visus.
  var seenNames = new Set<string>();
  var unique = components.filter(function(c: any) {
    if (seenNames.has(c.name)) return false;
    seenNames.add(c.name);
    return true;
  });

  postProgress("Found " + unique.length + " unique layers (" + components.length + " total)");

  componentReferences = unique;
  return unique;
}

async function handleGenerateLibrary() {
  postProgress("Starting library generation...");
  const components = extractComponentsFromFrame();
  if (components.length === 0) return;

  figma.ui.postMessage({ type: "loading", message: "Generating library..." });
  postProgress("Sending to Claude...");

  const sel = figma.currentPage.selection;
  const selectedNode = sel.length > 0 ? sel[0] : null;
  const frameName = selectedNode ? selectedNode.name : "Unknown Frame";

  // yFrakciju aprēķins jāveic pirms lapas maiņas, jo absoluteBoundingBox
  // pēc tam vairs nedos pareizas vērtības.
  if (selectedNode) {
    originalFrameHeight = (selectedNode as any).height || 852;
    const selAbs = (selectedNode as any).absoluteBoundingBox;
    originalFrameAbsY = selAbs ? selAbs.y : 0;

    componentYFracMap = new Map<string, number>();
    for (var yfi = 0; yfi < components.length; yfi++) {
      const c = components[yfi];
      if (c.nodeRef) {
        const nAbs = (c.nodeRef as any).absoluteBoundingBox;
        const nAbsY = nAbs ? nAbs.y : (c.nodeRef as any).y;
        componentYFracMap.set(c.name, (nAbsY - originalFrameAbsY) / (originalFrameHeight || 852));
      }
    }
  }

  const colorSet = new Set<string>();
  if (selectedNode) extractAllColors(selectedNode as any, colorSet);
  const colors = Array.from(colorSet).slice(0, 30);

  figma.ui.postMessage({
    type: "do-fetch-generate-library",
    components: components.map(function(c: any) {
      return { name: c.name, width: c.width, height: c.height, type: c.type };
    }),
    frameName: frameName,
    colors: colors,
  });
}

async function createLibraryComponents(library: any, colorPalette?: any) {
  try {
    postProgress("Finding Asset Library page...");

    let libraryPage = figma.root.children.find((p: any) => p.name === "Asset Library") as any;
    if (!libraryPage) {
      libraryPage = figma.createPage();
      libraryPage.name = "Asset Library";
      libraryPage.backgrounds = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
      postProgress("Created new Asset Library page");
    } else {
      postProgress("Adding to existing Asset Library page");
    }

    await figma.setCurrentPageAsync(libraryPage);

    const componentMap = new Map();
    componentReferences.forEach(function(comp: any) {
      if (comp.nodeRef) componentMap.set(comp.name, comp.nodeRef);
    });

    // Apvienošanas loģika ar esošo bibliotēku.
    const startX = 0;

    const existingCategoryFrames = new Map<string, any>();
    for (var ei = 0; ei < libraryPage.children.length; ei++) {
      const ch: any = libraryPage.children[ei];
      if (ch.type === "FRAME" && ch.name !== "Color Palette") {
        existingCategoryFrames.set(ch.name.toLowerCase(), ch);
      }
    }

    const existingPaletteFrame: any =
      libraryPage.children.find((c: any) => c.name === "Color Palette") || null;

    var existingNames = new Set<string>();
    for (var ei2 = 0; ei2 < libraryPage.children.length; ei2++) {
      var existingFrame = libraryPage.children[ei2];
      existingNames.add(existingFrame.name);
      if (existingFrame.children) {
        for (var ei3 = 0; ei3 < existingFrame.children.length; ei3++) {
          existingNames.add(existingFrame.children[ei3].name);
        }
      }
    }

    const GAP_ITEM     = 24;
    const GAP_CATEGORY = 48;
    const PADDING      = 20;
    const LABEL_HEIGHT = 32;

    try { await figma.loadFontAsync({ family: "Inter", style: "Regular" });   } catch (_) {}
    try { await figma.loadFontAsync({ family: "Inter", style: "Medium" });    } catch (_) {}
    try { await figma.loadFontAsync({ family: "Inter", style: "Bold" });      } catch (_) {}
    try { await figma.loadFontAsync({ family: "Inter", style: "Semi Bold" }); } catch (_) {
      try { await figma.loadFontAsync({ family: "Roboto", style: "Bold" }); } catch (_) {}
    }

    // Jaunās kategorijas stāj zem esošā satura.
    var yCategory = 0;
    for (var yi = 0; yi < libraryPage.children.length; yi++) {
      const yc: any = libraryPage.children[yi];
      const b = (yc.y || 0) + (yc.height || 0);
      if (b > yCategory) yCategory = b;
    }
    if (yCategory > 0) yCategory += GAP_CATEGORY;

    var successCount = 0;
    var failedCount  = 0;
    var placedNames = new Set<string>();
    var directComps: Array<{ node: any; displayName: string; category: string }> = [];

    for (var category in library) {
      postProgress("Building: " + category);
      const items = library[category];

      // Esošās kategorijas papildinām, jaunas izveidojam.
      const existingFrame = existingCategoryFrames.get(category.toLowerCase());
      let frame: any;
      let isNewFrame: boolean;
      var itemX = PADDING;
      var maxItemHeight = 0;

      if (existingFrame) {
        frame = existingFrame;
        isNewFrame = false;
        // Atrodam, kur beidzas esošās vienības, lai pievienotu pa labi.
        for (let ci = 0; ci < frame.children.length; ci++) {
          const ch: any = frame.children[ci];
          const right = ch.x + ch.width;
          if (right + GAP_ITEM > itemX) itemX = right + GAP_ITEM;
          if (ch.y >= PADDING + LABEL_HEIGHT - 4 && ch.height > maxItemHeight) {
            maxItemHeight = ch.height;
          }
        }
      } else {
        frame = figma.createFrame();
        frame.name = category;
        frame.fills = [{ type: "SOLID", color: { r: 0.992, g: 0.973, b: 0.945 } }];

        const label = figma.createText();
        try {
          label.fontName = { family: "Inter", style: "Semi Bold" };
        } catch (_) {
          label.fontName = { family: "Roboto", style: "Bold" };
        }
        label.characters = category.charAt(0).toUpperCase() + category.slice(1);
        label.fontSize = 13;
        label.fills = [{ type: "SOLID", color: { r: 0.48, g: 0.44, b: 0.38 } }];
        label.x = PADDING;
        label.y = PADDING;
        frame.appendChild(label);
        isNewFrame = true;
      }

      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var displayName = item.betterName || item.name;

        if (existingNames.has(displayName) || existingNames.has(item.name) ||
            placedNames.has(displayName) || placedNames.has(item.name)) {
          postProgress("Skipping duplicate: " + displayName);
          continue;
        }

        const originalNode = componentMap.get(item.name);
        if (!originalNode) continue;

        // Figma neļauj iestatīt nullē vai negatīvu izmēru.
        if (!originalNode.width || !originalNode.height ||
            originalNode.width  <= 0 || originalNode.height <= 0 ||
            !isFinite(originalNode.width) || !isFinite(originalNode.height)) {
          postProgress("Skipping zero-size layer: " + item.name);
          failedCount++;
          continue;
        }

        // Ja mezgls atrodas COMPONENT iekšienē, novietojam pašu vecāku komponenti
        // tieši uz lapas, saglabājot tā auto-layout un komponentu īpašības.
        var compAncestor: any = null;
        let scanCur: any = (originalNode as any).parent;
        while (scanCur && scanCur.type !== "PAGE" && scanCur.type !== "DOCUMENT") {
          if (scanCur.type === "COMPONENT") { compAncestor = scanCur; break; }
          scanCur = scanCur.parent;
        }
        if (compAncestor) {
          const ancName = compAncestor.name;
          if (!directComps.some((dc: any) => dc.node.id === compAncestor.id) &&
              !existingNames.has(ancName) && !placedNames.has(ancName)) {
            directComps.push({ node: compAncestor, displayName: ancName, category });
            placedNames.add(ancName);
          }
          continue;
        }

        // Pats mezgls ir COMPONENT — uz lapas, ne kategorijas rāmī.
        if (originalNode.type === "COMPONENT" || originalNode.type === "COMPONENT_SET") {
          directComps.push({ node: originalNode, displayName, category });
          placedNames.add(displayName);
          placedNames.add(item.name);
          successCount++;
          continue;
        }

        try {
          var assetNode: any;
          if (originalNode.type === "COMPONENT") {
            assetNode = originalNode.clone();
          } else if (originalNode.type === "INSTANCE") {
            // Svaiga instance no oriģinālā mastera, nevis wrapped jaunā komponentā.
            // Citādi pazūd variantu pārslēgšana un izmēra elastība.
            let mainComp: any = null;
            try {
              if (typeof originalNode.getMainComponentAsync === "function") {
                mainComp = await originalNode.getMainComponentAsync();
              }
            } catch (_) {}
            if (!mainComp) {
              try { mainComp = originalNode.mainComponent; } catch (_) {}
            }
            if (mainComp) {
              assetNode = mainComp.createInstance();
            } else {
              // Masters nav pieejams — fallback uz wrap, lai vismaz kaut kas ir bibliotēkā.
              var fallbackCopy = originalNode.clone();
              frame.appendChild(fallbackCopy);
              assetNode = figma.createComponentFromNode(fallbackCopy);
            }
          } else {
            // FRAME/GROUP/u.c. — paaugstinām uz COMPONENT, lai parādās Assets panelī.
            var copy = originalNode.clone();
            frame.appendChild(copy);
            assetNode = figma.createComponentFromNode(copy);
          }

          if (item.betterName) assetNode.name = item.betterName;

          assetNode.x = itemX;
          assetNode.y = PADDING + LABEL_HEIGHT;

          if (assetNode.parent !== frame) frame.appendChild(assetNode);

          // yFrakcija + kategorija plugin data — Generate Screen tos lasa atpakaļ.
          try {
            var yFracForItem = componentYFracMap.has(item.name)
              ? componentYFracMap.get(item.name) as number
              : 0.5;
            assetNode.setPluginData("yFraction", yFracForItem.toFixed(4));
            assetNode.setPluginData("category", category);
          } catch (_) {}

          itemX += assetNode.width + GAP_ITEM;
          maxItemHeight = Math.max(maxItemHeight, assetNode.height);
          placedNames.add(displayName);
          successCount++;

        } catch (_) {
          // createComponentFromNode neizdevās — placeholder taisnstūris.
          failedCount++;
          try {
            var rect = figma.createRectangle();
            rect.name = displayName;
            rect.resize(item.width || 100, item.height || 100);
            rect.x = itemX;
            rect.y = PADDING + LABEL_HEIGHT;
            rect.fills = [{ type: "SOLID", color: { r: 0.87, g: 0.83, b: 0.78 } }];
            frame.appendChild(rect);
            itemX += rect.width + GAP_ITEM;
            maxItemHeight = Math.max(maxItemHeight, rect.height);
          } catch (_) {}
        }
      }

      if (isNewFrame) {
        if (frame.children.length <= 1) {
          frame.remove();
          continue;
        }
        const frameWidth  = Math.max(120, itemX - GAP_ITEM + PADDING);
        const frameHeight = Math.max(60, PADDING + LABEL_HEIGHT + maxItemHeight + PADDING);
        frame.resize(frameWidth, frameHeight);
        frame.x = startX;
        frame.y = yCategory;
        yCategory += frameHeight + GAP_CATEGORY;
      } else {
        // Esošo rāmi tikai paplašinām, nepārvietojam.
        const newWidth  = Math.max(frame.width,  itemX - GAP_ITEM + PADDING);
        const newHeight = Math.max(frame.height, PADDING + LABEL_HEIGHT + maxItemHeight + PADDING);
        if (newWidth !== frame.width || newHeight !== frame.height) {
          frame.resize(newWidth, newHeight);
        }
      }
    }

    // Tieši uz lapas novietotās komponentes — sadalām pa top/middle/bottom zonām
    // pēc yFrakcijas, lai bibliotēka būtu vizuāli organizēta.
    interface DCEntry { node: any; displayName: string; category: string; yFrac: number; }
    const dcEntries: DCEntry[] = directComps.map(function(dc: any) {
      const yFrac = componentYFracMap.has(dc.node.name)
        ? componentYFracMap.get(dc.node.name) as number
        : 0;
      return { node: dc.node, displayName: dc.displayName, category: dc.category, yFrac };
    });

    const topEntries = dcEntries.filter(function(e) { return e.yFrac < 0.12; })
                                .sort(function(a, b) { return a.yFrac - b.yFrac; });
    const midEntries = dcEntries.filter(function(e) { return e.yFrac >= 0.12 && e.yFrac <= 0.80; })
                                .sort(function(a, b) { return a.yFrac - b.yFrac; });
    const botEntries = dcEntries.filter(function(e) { return e.yFrac > 0.80; })
                                .sort(function(a, b) { return a.yFrac - b.yFrac; });

    function addZoneLabel(text: string) {
      const zl = figma.createText();
      try { zl.fontName = { family: "Inter", style: "Semi Bold" }; }
      catch (_) { try { zl.fontName = { family: "Inter", style: "Bold" }; } catch (_) {} }
      zl.characters = text;
      zl.fontSize = 11;
      zl.fills = [{ type: "SOLID", color: { r: 0.6, g: 0.55, b: 0.48 } }];
      zl.x = startX;
      zl.y = yCategory;
      libraryPage.appendChild(zl);
      yCategory += zl.height + 8;
    }

    function placeEntry(entry: DCEntry) {
      var clone = (entry.node as any).clone();
      if (entry.displayName !== entry.node.name) clone.name = entry.displayName;
      clone.x = startX;
      clone.y = yCategory;
      libraryPage.appendChild(clone);
      yCategory += clone.height + GAP_CATEGORY;
      postProgress("Component placed directly: \"" + entry.node.name + "\"");
      clone.setPluginData("yFraction", entry.yFrac.toFixed(4));
      clone.setPluginData("category", entry.category);
    }

    if (topEntries.length > 0) { addZoneLabel("TOP OF SCREEN"); topEntries.forEach(placeEntry); }
    if (midEntries.length > 0) { addZoneLabel("MIDDLE"); midEntries.forEach(placeEntry); }
    if (botEntries.length > 0) { addZoneLabel("BOTTOM OF SCREEN"); botEntries.forEach(placeEntry); }

    // ── Krāsu palete ───────────────────────────────────────────────────────────
    // Ja palete jau eksistē, apvienojam un atjaunojam uz vietas. Citādi izveidojam jaunu.
    if (colorPalette && typeof colorPalette === "object") {
      postProgress(existingPaletteFrame ? "Merging color palette..." : "Building color palette...");

      const SWATCH_SIZE  = 48;
      const SWATCH_GAP   = 10;
      const LABEL_H      = 18;
      const CAT_GAP      = 32;
      const PAD          = 20;

      // Apvienotā palete: esošā + jaunā, ar hex dedublikāciju pēc lomas.
      const mergedPalette: { [role: string]: string[] } = {};
      if (existingPaletteFrame) {
        try {
          const stored = existingPaletteFrame.getPluginData("colorPalette");
          if (stored) {
            const parsed = JSON.parse(stored);
            for (const role in parsed) {
              if (Array.isArray(parsed[role])) {
                mergedPalette[role] = parsed[role].map((h: string) => (h || "").toUpperCase());
              }
            }
          }
        } catch (_) {}
      }
      for (const role in colorPalette) {
        if (!Array.isArray(colorPalette[role])) continue;
        if (!mergedPalette[role]) mergedPalette[role] = [];
        const seen = new Set(mergedPalette[role]);
        for (let hi = 0; hi < colorPalette[role].length; hi++) {
          const up = (colorPalette[role][hi] || "").toUpperCase();
          if (up && !seen.has(up)) {
            mergedPalette[role].push(up);
            seen.add(up);
          }
        }
      }

      let paletteFrame: any;
      if (existingPaletteFrame) {
        paletteFrame = existingPaletteFrame;
        // Notīrām un atjaunojam no merged datiem.
        while (paletteFrame.children.length > 0) {
          paletteFrame.children[paletteFrame.children.length - 1].remove();
        }
      } else {
        paletteFrame = figma.createFrame();
        paletteFrame.name  = "Color Palette";
        paletteFrame.fills = [{ type: "SOLID", color: { r: 0.992, g: 0.973, b: 0.945 } }];
      }

      const titleLabel = figma.createText();
      try { titleLabel.fontName = { family: "Inter", style: "Semi Bold" }; } catch (_) { titleLabel.fontName = { family: "Roboto", style: "Bold" }; }
      titleLabel.characters = "Color Palette";
      titleLabel.fontSize = 13;
      titleLabel.fills = [{ type: "SOLID", color: { r: 0.48, g: 0.44, b: 0.38 } }];
      titleLabel.x = PAD;
      titleLabel.y = PAD;
      paletteFrame.appendChild(titleLabel);

      var catX = PAD;
      var maxCatH = 0;

      for (var cat in mergedPalette) {
        var hexList: string[] = mergedPalette[cat];
        if (!Array.isArray(hexList) || hexList.length === 0) continue;

        const catLabel = figma.createText();
        try { catLabel.fontName = { family: "Inter", style: "Regular" }; } catch (_) {}
        catLabel.characters = cat.charAt(0).toUpperCase() + cat.slice(1);
        catLabel.fontSize = 10;
        catLabel.fills = [{ type: "SOLID", color: { r: 0.6, g: 0.56, b: 0.5 } }];
        catLabel.x = catX;
        catLabel.y = PAD + LABEL_H + 4;
        paletteFrame.appendChild(catLabel);

        var swatchY = PAD + LABEL_H + 4 + 16;

        for (var si = 0; si < hexList.length; si++) {
          var hex = hexList[si];
          var rgb = hexToRgb(hex);
          var swatch = figma.createRectangle();
          swatch.name   = hex;
          swatch.resize(SWATCH_SIZE, SWATCH_SIZE);
          swatch.x      = catX;
          swatch.y      = swatchY;
          swatch.fills  = [{ type: "SOLID", color: rgb }];
          swatch.cornerRadius = 8;
          paletteFrame.appendChild(swatch);

          const hexLabel = figma.createText();
          try { hexLabel.fontName = { family: "Inter", style: "Regular" }; } catch (_) {}
          hexLabel.characters = hex.toUpperCase();
          hexLabel.fontSize   = 9;
          hexLabel.fills      = [{ type: "SOLID", color: { r: 0.48, g: 0.44, b: 0.38 } }];
          hexLabel.x = catX;
          hexLabel.y = swatchY + SWATCH_SIZE + 3;
          paletteFrame.appendChild(hexLabel);

          swatchY += SWATCH_SIZE + LABEL_H + SWATCH_GAP;
        }

        maxCatH = Math.max(maxCatH, swatchY - (PAD + LABEL_H + 4 + 16));
        catX += SWATCH_SIZE + CAT_GAP;
      }

      const pfW = Math.max(120, catX - CAT_GAP + PAD);
      const pfH = Math.max(80, PAD + LABEL_H + 4 + 16 + maxCatH + PAD);
      paletteFrame.resize(pfW, pfH);

      // Jaunajai paletei iestatām pozīciju, esošā paliek savā vietā.
      if (!existingPaletteFrame) {
        paletteFrame.x = startX;
        paletteFrame.y = yCategory;
        yCategory += pfH + GAP_CATEGORY;
      }

      // Saglabājam merged paleti plugin data, lai Generate Screen var to lasīt atpakaļ.
      paletteFrame.setPluginData("colorPalette", JSON.stringify(mergedPalette));
    }

    figma.ui.postMessage({
      type: "success",
      message: "Library created! " + successCount + " components." +
        (failedCount > 0 ? " " + failedCount + " used placeholders." : ""),
    });
    postProgress("Library ready");

  } catch (error) {
    figma.ui.postMessage({
      type: "error",
      message: "Failed to create library: " + (error instanceof Error ? error.message : error),
    });
  }
}
