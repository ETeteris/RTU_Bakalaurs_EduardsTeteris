/// <reference types="@figma/plugin-typings" />

import { Messenger } from "./core/Messenger";
import { MessageRouter } from "./core/MessageRouter";
import { RestyleService } from "./services/RestyleService";
import { ScreenService } from "./services/ScreenService";
import { JourneyService } from "./services/JourneyService";
import { LibraryService } from "./services/LibraryService";
import { PluginMessage } from "./types";

figma.showUI(__html__, { width: 380, height: 700 });

// ── Composition root: create services and inject their dependencies (DIP) ─────
const messenger = new Messenger();
const screen  = new ScreenService(messenger);
const journey = new JourneyService(messenger, screen);
const library = new LibraryService(messenger);
const restyle = new RestyleService(messenger);

// ── Message router: msg.type -> handler (OCP) ────────────────────────────────
const router = new MessageRouter()
  .on("execute-prompt",          (m) => restyle.handleExecutePrompt(m.prompt))
  .on("execute-prompt-result",   (m) => restyle.applyExecutePromptResult(m.data, m.originalFrame))
  .on("generate-library",        () => library.handleGenerateLibrary())
  .on("generate-library-result", (m) => {
    messenger.progress("Creating Asset Library page...");
    return library.createLibraryComponents(m.data.library, m.data.colorPalette);
  })
  .on("generate-screen",         (m) => screen.handleGenerateScreen(m.prompt, m.screenWidth, m.screenHeight))
  .on("generate-screen-result",  async (m) => {
    // In journey mode, generate silently and continue the journey; otherwise a normal screen.
    if (m.isJourney) {
      const frame = await screen.applyGenerateScreenResult(m.data, true);
      await journey.continueJourney(frame);
    } else {
      await screen.applyGenerateScreenResult(m.data, false);
    }
  })
  .on("generate-journey",        (m) => journey.handleGenerateJourney(m.input, m.screenWidth, m.screenHeight))
  .on("fetch-error",             (m) => messenger.error(m.message));

figma.ui.onmessage = (msg: PluginMessage) => router.dispatch(msg);
