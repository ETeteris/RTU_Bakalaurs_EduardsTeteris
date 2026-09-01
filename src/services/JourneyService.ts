import { Messenger } from "../core/Messenger";
import { ScreenService } from "./ScreenService";

/* eslint-disable @typescript-eslint/no-explicit-any */

// UX journey generator — sequentially generates several screens and draws arrows.
// Holds its journey state in instance fields (previously module-level globals).
export class JourneyService {
  private journeyScreens: string[] = [];
  private journeyIndex = 0;
  private journeyFrameIds: string[] = [];
  private journeyScreenWidth = 393;
  private journeyScreenHeight = 852;

  constructor(private messenger: Messenger, private screen: ScreenService) {}

  async handleGenerateJourney(input: string, screenWidth?: number, screenHeight?: number): Promise<void> {
    // Separators: →, comma, or newline.
    const screens = input
      .split(/[→,\n]+/)
      .map(function(s: string) { return s.trim(); })
      .filter(function(s: string) { return s.length > 0; });

    if (screens.length < 2) {
      this.messenger.post({
        type: "journey-error",
        message: "Enter at least 2 screen names separated by → or commas.",
      });
      return;
    }

    this.journeyScreens      = screens;
    this.journeyIndex        = 0;
    this.journeyFrameIds     = [];
    this.journeyScreenWidth  = screenWidth  || 393;
    this.journeyScreenHeight = screenHeight || 852;

    this.messenger.post({
      type: "journey-progress",
      current: 0,
      total: screens.length,
      message: "Starting: " + screens.join(" → "),
    });

    await this.startNextJourneyScreen();
  }

  private async startNextJourneyScreen(): Promise<void> {
    const screenName = this.journeyScreens[this.journeyIndex];
    this.messenger.progress("Journey [" + (this.journeyIndex + 1) + "/" + this.journeyScreens.length + "]: generating " + screenName);

    const styles = await this.screen.extractStylesFromLibrary();

    this.messenger.post({
      type: "do-fetch-generate-screen",
      prompt: screenName,
      colors: styles.colors,
      fonts: styles.fonts,
      palette: styles.palette,
      categories: styles.categories,
      libraryComponents: styles.libraryComponents,
      isJourney: true,
      screenWidth: this.journeyScreenWidth,
      screenHeight: this.journeyScreenHeight,
    });
  }

  async continueJourney(frame: any): Promise<void> {
    if (!frame) {
      this.messenger.post({
        type: "journey-error",
        message: "Failed to generate screen " + (this.journeyIndex + 1) +
          " (" + (this.journeyScreens[this.journeyIndex] || "unknown") + "). Journey stopped.",
      });
      return;
    }

    this.journeyFrameIds.push(frame.id);
    this.journeyIndex++;

    this.messenger.post({
      type: "journey-progress",
      current: this.journeyIndex,
      total: this.journeyScreens.length,
      message: "✓ " + this.journeyScreens[this.journeyIndex - 1],
    });

    if (this.journeyIndex < this.journeyScreens.length) {
      await this.startNextJourneyScreen();
    } else {
      await this.drawJourneyArrows();
      this.messenger.post({
        type: "journey-complete",
        message: this.journeyScreens.length + " screens generated.",
      });
    }
  }

  // Arrows and name labels between the generated screens.
  private async drawJourneyArrows(): Promise<void> {
    try { await figma.loadFontAsync({ family: "Inter", style: "Regular" }); } catch (_) {}
    try { await figma.loadFontAsync({ family: "Inter", style: "Bold" });    } catch (_) {}

    const nodes: any[] = [];

    for (let i = 0; i < this.journeyFrameIds.length; i++) {
      const frame = await figma.getNodeByIdAsync(this.journeyFrameIds[i]) as any;
      if (!frame) continue;
      nodes.push(frame);

      try {
        const lbl = figma.createText();
        try { lbl.fontName = { family: "Inter", style: "Bold" };    }
        catch (_) { lbl.fontName = { family: "Inter", style: "Regular" }; }
        lbl.characters = this.journeyScreens[i];
        lbl.fontSize   = 14;
        lbl.fills      = [{ type: "SOLID", color: { r: 0.18, g: 0.18, b: 0.18 } }];
        lbl.x = Math.round(frame.x + (frame.width - lbl.width) / 2);
        lbl.y = frame.y + frame.height + 16;
        figma.currentPage.appendChild(lbl);
      } catch (_) {}

      if (i < this.journeyFrameIds.length - 1) {
        const nextFrame = await figma.getNodeByIdAsync(this.journeyFrameIds[i + 1]) as any;
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
}
