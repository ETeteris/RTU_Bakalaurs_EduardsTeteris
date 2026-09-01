import { Messenger } from "../core/Messenger";
import { extractAllColors, detachAllInstances, applyColorMap } from "../utils/nodes";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Frame recoloring (execute-prompt). Reads the colors, asks the UI to call the
// backend, then applies the colorMap to a duplicate.
export class RestyleService {
  constructor(private messenger: Messenger) {}

  async handleExecutePrompt(prompt: string): Promise<void> {
    const selection = figma.currentPage.selection;

    if (selection.length === 0) {
      this.messenger.post({ type: "execute-error", message: "Please select a frame first." });
      return;
    }

    const selectedNode = selection[0] as any;

    if (selectedNode.type !== "FRAME" && selectedNode.type !== "COMPONENT") {
      this.messenger.post({ type: "execute-error", message: "Please select a frame or component." });
      return;
    }

    this.messenger.progress("Reading colors from frame...");
    const colorSet = new Set<string>();
    extractAllColors(selectedNode, colorSet);
    const colors = Array.from(colorSet);
    this.messenger.progress("Found " + colors.length + " unique colors");

    // The UI performs the fetch, because the main thread cannot make network requests.
    this.messenger.post({
      type: "do-fetch-execute-prompt",
      prompt: prompt,
      colors: colors,
      frameName: selectedNode.name,
      frameId: selectedNode.id,
    });
  }

  async applyExecutePromptResult(data: any, frameId: string): Promise<void> {
    if (data.action === "restyle_duplicate" && data.colorMap) {
      const sourceNode = await figma.getNodeByIdAsync(frameId) as any;
      if (!sourceNode) {
        this.messenger.post({ type: "execute-error", message: "Could not find the selected frame." });
        return;
      }

      this.messenger.progress("Applying color changes to duplicate...");

      const duplicate = sourceNode.clone();
      duplicate.name = data.newFrameName || (sourceNode.name + " - restyled");
      duplicate.x = sourceNode.x + sourceNode.width + 120;
      duplicate.y = sourceNode.y;
      figma.currentPage.appendChild(duplicate);

      // Instances have locked inner properties — detach so the colors become writable.
      detachAllInstances(duplicate);
      applyColorMap(duplicate, data.colorMap);

      figma.currentPage.selection = [duplicate];
      figma.viewport.scrollAndZoomIntoView([duplicate]);

      this.messenger.progress("Created \"" + duplicate.name + "\"");
      this.messenger.post({ type: "execute-success", message: data.description || "Done! New frame created." });

    } else if (data.action === "unsupported") {
      this.messenger.post({ type: "execute-response", message: data.description });
    } else {
      this.messenger.post({ type: "execute-error", message: "Unexpected response from backend." });
    }
  }
}
