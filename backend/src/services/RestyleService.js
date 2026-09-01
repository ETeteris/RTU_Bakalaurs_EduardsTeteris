const restylePrompts = require("../prompts/restyle");
const { parseClaudeJSON } = require("../utils/jsonRepair");
const { ParseError } = require("../errors");

// Orchestrates frame recoloring: builds the prompt, calls Claude, parses colorMap.
class RestyleService {
  constructor(claude) {
    this.claude = claude;
  }

  async restyle({ prompt, colors, frameName }) {
    const system = restylePrompts.buildSystem();
    const user = restylePrompts.buildUser(prompt, colors, frameName);

    const { text } = await this.claude.message({
      system,
      messages: [{ role: "user", content: user }],
      maxTokens: 1024,
    });

    const raw = text.trim();
    const result = parseClaudeJSON(raw);
    if (!result) throw new ParseError("Could not parse response", raw.substring(0, 200));
    return result;
  }
}

module.exports = { RestyleService };
