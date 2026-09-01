import { rgbToHex, hexToRgb } from "./color";
import { ColorMap } from "../types";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Recursively collect all visible fill and stroke colors in hex format.
export function extractAllColors(node: any, colorSet: Set<string>): void {
  if (node.fills) {
    for (let i = 0; i < node.fills.length; i++) {
      const fill = node.fills[i];
      if (fill.type === "SOLID" && fill.visible !== false) {
        colorSet.add(rgbToHex(fill.color.r, fill.color.g, fill.color.b));
      }
    }
  }
  if (node.strokes) {
    for (let j = 0; j < node.strokes.length; j++) {
      const stroke = node.strokes[j];
      if (stroke.type === "SOLID" && stroke.visible !== false) {
        colorSet.add(rgbToHex(stroke.color.r, stroke.color.g, stroke.color.b));
      }
    }
  }
  if (node.children) {
    for (let k = 0; k < node.children.length; k++) {
      extractAllColors(node.children[k], colorSet);
    }
  }
}

export function collectInstances(node: any, out: any[]): void {
  if (node.type === "INSTANCE") out.push(node);
  if (node.children) {
    for (let i = 0; i < node.children.length; i++) collectInstances(node.children[i], out);
  }
}

// Detach all instances over several passes — one pass is not enough, because
// detaching an outer instance can reveal inner ones that were not accessible before.
export function detachAllInstances(root: any): void {
  for (let pass = 0; pass < 20; pass++) {
    const instances: any[] = [];
    collectInstances(root, instances);
    if (instances.length === 0) break;
    for (let i = 0; i < instances.length; i++) {
      try { instances[i].detachInstance(); } catch (_) {}
    }
  }
}

// Recolor all of a node's fills and strokes per colorMap. Object.assign keeps
// the other fill properties (opacity, blendMode) and changes only the color.
export function applyColorMap(node: any, colorMap: ColorMap): void {
  if (node.fills && node.fills.length > 0) {
    const newFills = [];
    for (let i = 0; i < node.fills.length; i++) {
      const fill = node.fills[i];
      if (fill.type === "SOLID") {
        const hex = rgbToHex(fill.color.r, fill.color.g, fill.color.b);
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
    const newStrokes = [];
    for (let m = 0; m < node.strokes.length; m++) {
      const stroke = node.strokes[m];
      if (stroke.type === "SOLID") {
        const strokeHex = rgbToHex(stroke.color.r, stroke.color.g, stroke.color.b);
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
    for (let n = 0; n < node.children.length; n++) {
      applyColorMap(node.children[n], colorMap);
    }
  }
}
