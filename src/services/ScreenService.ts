import { Messenger } from "../core/Messenger";
import { rgbToHex, hexToRgb } from "../utils/color";
import { StylesFromLibrary, LibraryComponent, PlacedComponent } from "../types";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Screen generation from Asset Library styles. The class holds its own state of
// components to place (previously a module-level global).
export class ScreenService {
  // Library components to place on the next generated screen.
  private screenPlacedComponents: PlacedComponent[] = [];

  constructor(private messenger: Messenger) {}

  // Reads the Asset Library page and returns everything the backend needs for
  // planning: colors, fonts, palette by role, category names, and components.
  async extractStylesFromLibrary(): Promise<StylesFromLibrary> {
    const libraryPage = figma.root.children.find((p: any) => p.name === "Asset Library") as any;

    if (!libraryPage) {
      this.messenger.progress("No Asset Library page found — generating with default styles");
      return { colors: [], fonts: [], palette: null, categories: [], libraryComponents: [] };
    }

    // In dynamic-page mode the page contents must be loaded explicitly.
    if (libraryPage !== figma.currentPage) {
      await libraryPage.loadAsync();
    }

    // The structured palette is stored in the Color Palette frame's plugin data.
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
        for (let i = 0; i < node.fills.length; i++) {
          const f = node.fills[i];
          if (f.type === "SOLID" && f.visible !== false) {
            colorSet.add(rgbToHex(f.color.r, f.color.g, f.color.b));
          }
        }
      }
      if (node.type === "TEXT" && node.fontName && node.fontName.family) {
        fontSet.add(node.fontName.family);
      }
      if (node.children) {
        for (let ci = 0; ci < node.children.length; ci++) walk(node.children[ci]);
      }
    }

    for (let i = 0; i < libraryPage.children.length; i++) {
      if (libraryPage.children[i].name !== "Color Palette") {
        walk(libraryPage.children[i]);
      }
    }

    const libraryComponents: LibraryComponent[] = [];

    // COMPONENT/COMPONENT_SET/INSTANCE — treated as leaves. Otherwise inner
    // variants (e.g. a status bar inside a header) would appear in the candidate
    // list and Claude might select both, producing overlapping components on the screen.
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

  async handleGenerateScreen(prompt: string, screenWidth?: number, screenHeight?: number): Promise<void> {
    const styles = await this.extractStylesFromLibrary();
    this.messenger.progress(
      "Extracted " + styles.colors.length + " colors, " +
      styles.fonts.length + " fonts, " +
      styles.libraryComponents.length + " library components"
    );

    this.messenger.post({
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

  // Translates the backend's selection list into real library nodes.
  private async resolveSelectedComponents(selection: any): Promise<void> {
    this.screenPlacedComponents = [];
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

    for (let i = 0; i < selection.length; i++) {
      const sel = selection[i];
      if (!sel || typeof sel.name !== "string") continue;
      const node = nameMap.get(sel.name);
      if (!node) {
        this.messenger.progress("Selection skipped (not found): " + sel.name);
        continue;
      }
      this.screenPlacedComponents.push({
        nodeId: node.id,
        name: node.name,
        targetX: typeof sel.x === "number" ? Math.round(sel.x) : 0,
        targetY: typeof sel.y === "number" ? Math.round(sel.y) : 0,
        height: Math.round(node.height),
      });
    }
  }

  // silent=true in Journey mode, so notifications don't flicker between screens.
  async applyGenerateScreenResult(data: any, silent: boolean = false): Promise<any> {
    try {
      if (!data || !data.elements || !Array.isArray(data.elements)) {
        if (!silent) {
          this.messenger.post({ type: "screen-error", message: "Backend returned an invalid layout. Try again or simplify the prompt." });
        }
        return null;
      }

      await this.resolveSelectedComponents(data._selection);
      if (this.screenPlacedComponents.length > 0) {
        this.messenger.progress("Reusing " + this.screenPlacedComponents.length + " library component(s)");
      }

      const screenFrame = figma.createFrame();
      screenFrame.name = data.frameName || "Generated Screen";
      screenFrame.resize(Math.max(1, data.width || 390), Math.max(1, data.height || 844));
      screenFrame.fills = [{ type: "SOLID", color: hexToRgb(data.backgroundColor || "#FFFFFF") }];

      // Place the new frame to the right of existing content.
      let maxRight = 0;
      for (let ci = 0; ci < figma.currentPage.children.length; ci++) {
        const ch = figma.currentPage.children[ci] as any;
        const r = ch.x + ch.width;
        if (r > maxRight) maxRight = r;
      }
      screenFrame.x = maxRight > 0 ? maxRight + 120 : 0;
      screenFrame.y = 0;

      // Fonts must be loaded before creating text nodes.
      const fontsToLoad = new Set<string>();
      fontsToLoad.add("Inter");
      for (let fi = 0; fi < data.elements.length; fi++) {
        if (data.elements[fi].type === "text" && data.elements[fi].fontFamily) {
          fontsToLoad.add(data.elements[fi].fontFamily);
        }
      }
      const fontArr = Array.from(fontsToLoad);
      for (let fj = 0; fj < fontArr.length; fj++) {
        try { await figma.loadFontAsync({ family: fontArr[fj], style: "Regular" }); } catch (_) {}
        try { await figma.loadFontAsync({ family: fontArr[fj], style: "Medium" });  } catch (_) {}
        try { await figma.loadFontAsync({ family: fontArr[fj], style: "Bold" });    } catch (_) {}
      }

      let placed = 0;

      for (let i = 0; i < data.elements.length; i++) {
        const el = data.elements[i];
        try {
          if (el.type === "rect") {
            const rect = figma.createRectangle();
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
            const textNode = figma.createText();
            textNode.name = el.name || "Text";
            textNode.x = el.x || 0;
            textNode.y = el.y || 0;
            const family = el.fontFamily || "Inter";
            const style = el.fontWeight === "Bold" ? "Bold" : (el.fontWeight === "Medium" ? "Medium" : "Regular");
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
          this.messenger.progress("Skipped element: " + (el.name || el.type));
        }
      }

      // Place the selected library components on top.
      if (this.screenPlacedComponents.length > 0) {
        const libPage = figma.root.children.find((p: any) => p.name === "Asset Library") as any;
        if (libPage && libPage !== figma.currentPage) await libPage.loadAsync();
        for (let pi = 0; pi < this.screenPlacedComponents.length; pi++) {
          const pc = this.screenPlacedComponents[pi];
          try {
            const libNode = await figma.getNodeByIdAsync(pc.nodeId) as any;
            if (!libNode) continue;
            // For an INSTANCE library entry, find the original master to preserve
            // variant switching and size flexibility.
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
            // Stretch only full-width components (headers, nav bars).
            if (libNode.width >= screenFrame.width * 0.9) {
              try { inst.resize(screenFrame.width, inst.height); } catch (_) {}
            }
            screenFrame.appendChild(inst);
            this.messenger.progress("Placed: \"" + pc.name + "\" at " + pc.targetX + "," + pc.targetY);
          } catch (_) {}
        }
      }

      if (!silent) {
        figma.currentPage.selection = [screenFrame];
        figma.viewport.scrollAndZoomIntoView([screenFrame]);
        this.messenger.post({
          type: "screen-success",
          message: "Created \"" + screenFrame.name + "\" with " + placed + " elements.",
        });
      }

      return screenFrame;

    } catch (err: any) {
      if (!silent) {
        this.messenger.post({ type: "screen-error", message: "Error building screen: " + (err.message || String(err)) });
      }
      return null;
    }
  }
}
