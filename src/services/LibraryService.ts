import { Messenger } from "../core/Messenger";
import { hexToRgb } from "../utils/color";
import { extractAllColors } from "../utils/nodes";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Asset Library generator — scans the selected frame, sends metadata to the
// backend for categorization, then builds the library page with components and
// a color palette. Holds the scan state in instance fields (previously module globals).
export class LibraryService {
  // Source node references from the Generate Library scan — createLibraryComponents()
  // finds the originals after the UI fetch returns.
  private componentReferences: any[] = [];

  private originalFrameHeight = 852;
  private originalFrameAbsY = 0;

  // yFraction for each node by name. Must be computed before the page changes,
  // because absoluteBoundingBox no longer gives correct values afterwards.
  private componentYFracMap = new Map<string, number>();

  constructor(private messenger: Messenger) {}

  private getSelectedFrameOrComponent(): any | null {
    const selection = figma.currentPage.selection;
    if (selection.length === 0) {
      this.messenger.error("Please select a frame first");
      return null;
    }
    const node = selection[0];
    if (node.type !== "FRAME" && node.type !== "COMPONENT") {
      this.messenger.error("Please select a frame or component");
      return null;
    }
    return node;
  }

  // Recursively collect metadata for each descendant of the selected frame.
  private extractComponentsFromFrame(): any[] {
    this.componentReferences = [];
    this.messenger.progress("Reading selection...");

    const selectedNode = this.getSelectedFrameOrComponent();
    if (!selectedNode) return [];

    const components: any[] = [];
    let count = 0;
    const messenger = this.messenger;

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
        if (count % 10 === 0) messenger.progress("Scanned " + count + " layers...");
      }
      if (node.children) {
        for (let i = 0; i < node.children.length; i++) {
          findComponents(node.children[i], path + "/" + node.children[i].name);
        }
      }
    }

    findComponents(selectedNode, selectedNode.name);

    // Deduplicate by name — otherwise repeated layers (e.g. an icon in 20 buttons)
    // are collected many times and Claude receives them all.
    const seenNames = new Set<string>();
    const unique = components.filter(function(c: any) {
      if (seenNames.has(c.name)) return false;
      seenNames.add(c.name);
      return true;
    });

    this.messenger.progress("Found " + unique.length + " unique layers (" + components.length + " total)");

    this.componentReferences = unique;
    return unique;
  }

  async handleGenerateLibrary(): Promise<void> {
    this.messenger.progress("Starting library generation...");
    const components = this.extractComponentsFromFrame();
    if (components.length === 0) return;

    this.messenger.post({ type: "loading", message: "Generating library..." });
    this.messenger.progress("Sending to Claude...");

    const sel = figma.currentPage.selection;
    const selectedNode = sel.length > 0 ? sel[0] : null;
    const frameName = selectedNode ? selectedNode.name : "Unknown Frame";

    // The yFraction computation must happen before the page changes, because
    // absoluteBoundingBox no longer gives correct values afterwards.
    if (selectedNode) {
      this.originalFrameHeight = (selectedNode as any).height || 852;
      const selAbs = (selectedNode as any).absoluteBoundingBox;
      this.originalFrameAbsY = selAbs ? selAbs.y : 0;

      this.componentYFracMap = new Map<string, number>();
      for (let yfi = 0; yfi < components.length; yfi++) {
        const c = components[yfi];
        if (c.nodeRef) {
          const nAbs = (c.nodeRef as any).absoluteBoundingBox;
          const nAbsY = nAbs ? nAbs.y : (c.nodeRef as any).y;
          this.componentYFracMap.set(c.name, (nAbsY - this.originalFrameAbsY) / (this.originalFrameHeight || 852));
        }
      }
    }

    const colorSet = new Set<string>();
    if (selectedNode) extractAllColors(selectedNode as any, colorSet);
    const colors = Array.from(colorSet).slice(0, 30);

    this.messenger.post({
      type: "do-fetch-generate-library",
      components: components.map(function(c: any) {
        return { name: c.name, width: c.width, height: c.height, type: c.type };
      }),
      frameName: frameName,
      colors: colors,
    });
  }

  async createLibraryComponents(library: any, colorPalette?: any): Promise<void> {
    const componentYFracMap = this.componentYFracMap;
    try {
      this.messenger.progress("Finding Asset Library page...");

      let libraryPage = figma.root.children.find((p: any) => p.name === "Asset Library") as any;
      if (!libraryPage) {
        libraryPage = figma.createPage();
        libraryPage.name = "Asset Library";
        libraryPage.backgrounds = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
        this.messenger.progress("Created new Asset Library page");
      } else {
        this.messenger.progress("Adding to existing Asset Library page");
      }

      await figma.setCurrentPageAsync(libraryPage);

      const componentMap = new Map();
      this.componentReferences.forEach(function(comp: any) {
        if (comp.nodeRef) componentMap.set(comp.name, comp.nodeRef);
      });

      // Merge logic with the existing library.
      const startX = 0;

      const existingCategoryFrames = new Map<string, any>();
      for (let ei = 0; ei < libraryPage.children.length; ei++) {
        const ch: any = libraryPage.children[ei];
        if (ch.type === "FRAME" && ch.name !== "Color Palette") {
          existingCategoryFrames.set(ch.name.toLowerCase(), ch);
        }
      }

      const existingPaletteFrame: any =
        libraryPage.children.find((c: any) => c.name === "Color Palette") || null;

      const existingNames = new Set<string>();
      for (let ei2 = 0; ei2 < libraryPage.children.length; ei2++) {
        const existingFrame = libraryPage.children[ei2];
        existingNames.add(existingFrame.name);
        if (existingFrame.children) {
          for (let ei3 = 0; ei3 < existingFrame.children.length; ei3++) {
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

      // New categories go below the existing content.
      let yCategory = 0;
      for (let yi = 0; yi < libraryPage.children.length; yi++) {
        const yc: any = libraryPage.children[yi];
        const b = (yc.y || 0) + (yc.height || 0);
        if (b > yCategory) yCategory = b;
      }
      if (yCategory > 0) yCategory += GAP_CATEGORY;

      let successCount = 0;
      let failedCount  = 0;
      const placedNames = new Set<string>();
      const directComps: Array<{ node: any; displayName: string; category: string }> = [];

      for (const category in library) {
        this.messenger.progress("Building: " + category);
        const items = library[category];

        // Extend existing categories, create new ones.
        const existingFrame = existingCategoryFrames.get(category.toLowerCase());
        let frame: any;
        let isNewFrame: boolean;
        let itemX = PADDING;
        let maxItemHeight = 0;

        if (existingFrame) {
          frame = existingFrame;
          isNewFrame = false;
          // Find where the existing items end, so we append to the right.
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

        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const displayName = item.betterName || item.name;

          if (existingNames.has(displayName) || existingNames.has(item.name) ||
              placedNames.has(displayName) || placedNames.has(item.name)) {
            this.messenger.progress("Skipping duplicate: " + displayName);
            continue;
          }

          const originalNode = componentMap.get(item.name);
          if (!originalNode) continue;

          // Figma does not allow setting a zero or negative size.
          if (!originalNode.width || !originalNode.height ||
              originalNode.width  <= 0 || originalNode.height <= 0 ||
              !isFinite(originalNode.width) || !isFinite(originalNode.height)) {
            this.messenger.progress("Skipping zero-size layer: " + item.name);
            failedCount++;
            continue;
          }

          // If the node is inside a COMPONENT, place the parent component itself
          // directly on the page, preserving its auto-layout and component properties.
          let compAncestor: any = null;
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

          // The node itself is a COMPONENT — on the page, not in a category frame.
          if (originalNode.type === "COMPONENT" || originalNode.type === "COMPONENT_SET") {
            directComps.push({ node: originalNode, displayName, category });
            placedNames.add(displayName);
            placedNames.add(item.name);
            successCount++;
            continue;
          }

          try {
            let assetNode: any;
            if (originalNode.type === "COMPONENT") {
              assetNode = originalNode.clone();
            } else if (originalNode.type === "INSTANCE") {
              // A fresh instance from the original master, not wrapped in a new
              // component. Otherwise variant switching and size flexibility are lost.
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
                // Master unavailable — fall back to wrapping, so at least something is in the library.
                const fallbackCopy = originalNode.clone();
                frame.appendChild(fallbackCopy);
                assetNode = figma.createComponentFromNode(fallbackCopy);
              }
            } else {
              // FRAME/GROUP/etc. — promote to a COMPONENT so it appears in the Assets panel.
              const copy = originalNode.clone();
              frame.appendChild(copy);
              assetNode = figma.createComponentFromNode(copy);
            }

            if (item.betterName) assetNode.name = item.betterName;

            assetNode.x = itemX;
            assetNode.y = PADDING + LABEL_HEIGHT;

            if (assetNode.parent !== frame) frame.appendChild(assetNode);

            // yFraction + category plugin data — Generate Screen reads them back.
            try {
              const yFracForItem = componentYFracMap.has(item.name)
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
            // createComponentFromNode failed — placeholder rectangle.
            failedCount++;
            try {
              const rect = figma.createRectangle();
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
          // Only expand the existing frame, don't move it.
          const newWidth  = Math.max(frame.width,  itemX - GAP_ITEM + PADDING);
          const newHeight = Math.max(frame.height, PADDING + LABEL_HEIGHT + maxItemHeight + PADDING);
          if (newWidth !== frame.width || newHeight !== frame.height) {
            frame.resize(newWidth, newHeight);
          }
        }
      }

      // Components placed directly on the page — split into top/middle/bottom zones
      // by yFraction, so the library is visually organized.
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

      const messenger = this.messenger;
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
        const clone = (entry.node as any).clone();
        if (entry.displayName !== entry.node.name) clone.name = entry.displayName;
        clone.x = startX;
        clone.y = yCategory;
        libraryPage.appendChild(clone);
        yCategory += clone.height + GAP_CATEGORY;
        messenger.progress("Component placed directly: \"" + entry.node.name + "\"");
        clone.setPluginData("yFraction", entry.yFrac.toFixed(4));
        clone.setPluginData("category", entry.category);
      }

      if (topEntries.length > 0) { addZoneLabel("TOP OF SCREEN"); topEntries.forEach(placeEntry); }
      if (midEntries.length > 0) { addZoneLabel("MIDDLE"); midEntries.forEach(placeEntry); }
      if (botEntries.length > 0) { addZoneLabel("BOTTOM OF SCREEN"); botEntries.forEach(placeEntry); }

      // ── Color palette ────────────────────────────────────────────────────────
      // If a palette already exists, merge and update it in place. Otherwise create a new one.
      if (colorPalette && typeof colorPalette === "object") {
        this.messenger.progress(existingPaletteFrame ? "Merging color palette..." : "Building color palette...");

        const SWATCH_SIZE  = 48;
        const SWATCH_GAP   = 10;
        const LABEL_H      = 18;
        const CAT_GAP      = 32;
        const PAD          = 20;

        // Merged palette: existing + new, deduplicated by hex per role.
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
          // Clear and rebuild from the merged data.
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

        let catX = PAD;
        let maxCatH = 0;

        for (const cat in mergedPalette) {
          const hexList: string[] = mergedPalette[cat];
          if (!Array.isArray(hexList) || hexList.length === 0) continue;

          const catLabel = figma.createText();
          try { catLabel.fontName = { family: "Inter", style: "Regular" }; } catch (_) {}
          catLabel.characters = cat.charAt(0).toUpperCase() + cat.slice(1);
          catLabel.fontSize = 10;
          catLabel.fills = [{ type: "SOLID", color: { r: 0.6, g: 0.56, b: 0.5 } }];
          catLabel.x = catX;
          catLabel.y = PAD + LABEL_H + 4;
          paletteFrame.appendChild(catLabel);

          let swatchY = PAD + LABEL_H + 4 + 16;

          for (let si = 0; si < hexList.length; si++) {
            const hex = hexList[si];
            const rgb = hexToRgb(hex);
            const swatch = figma.createRectangle();
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

        // Set the position for a new palette; an existing one stays in place.
        if (!existingPaletteFrame) {
          paletteFrame.x = startX;
          paletteFrame.y = yCategory;
          yCategory += pfH + GAP_CATEGORY;
        }

        // Save the merged palette to plugin data, so Generate Screen can read it back.
        paletteFrame.setPluginData("colorPalette", JSON.stringify(mergedPalette));
      }

      this.messenger.post({
        type: "success",
        message: "Library created! " + successCount + " components." +
          (failedCount > 0 ? " " + failedCount + " used placeholders." : ""),
      });
      this.messenger.progress("Library ready");

    } catch (error) {
      this.messenger.error("Failed to create library: " + (error instanceof Error ? error.message : error));
    }
  }
}
