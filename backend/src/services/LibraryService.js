const libraryPrompts = require("../prompts/library");
const { parseClaudeJSON } = require("../utils/jsonRepair");
const { ParseError } = require("../errors");

// Orchestrates library generation: (1) categorizes components, (2) optionally
// classifies colors into palette roles (a failure here is skipped).
class LibraryService {
  constructor(claude) {
    this.claude = claude;
  }

  async generate({ components, frameName, colors }) {
    const organizePrompt = libraryPrompts.buildOrganize(frameName, components);

    let text;
    try {
      ({ text } = await this.claude.message({
        messages: [{ role: "user", content: organizePrompt }],
        maxTokens: 8192,
      }));
    } catch (apiError) {
      console.error("[generate-library] Claude API error:", apiError.detail || apiError.message);
      throw apiError;
    }

    const library = parseClaudeJSON(text);
    if (!library) {
      console.error("[generate-library] JSON parse failed. Raw (first 300):", text.substring(0, 300));
      throw new ParseError("Could not parse response", text.substring(0, 200));
    }

    // Classify colors into palette roles.
    let colorPalette = null;
    if (colors && colors.length > 0) {
      const colorPrompt = libraryPrompts.buildPalette(colors);
      try {
        const { text: paletteText } = await this.claude.message({
          messages: [{ role: "user", content: colorPrompt }],
          maxTokens: 512,
          timeout: 20000,
        });
        colorPalette = parseClaudeJSON(paletteText);
      } catch (_) {
        console.error("[generate-library] Color palette call failed, skipping");
      }
    }

    return { library, colorPalette };
  }
}

module.exports = { LibraryService };
