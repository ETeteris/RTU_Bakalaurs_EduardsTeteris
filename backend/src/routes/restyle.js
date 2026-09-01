const express = require("express");
const { ClaudeApiError } = require("../claude/ClaudeClient");
const { ParseError } = require("../errors");

// POST /api/execute-prompt — frame recoloring.
module.exports = function restyleRoute(service, claude) {
  const router = express.Router();

  router.post("/api/execute-prompt", async (req, res) => {
    try {
      const { prompt, colors, frameName } = req.body;
      if (!prompt) return res.status(400).json({ error: "Prompt is required" });
      if (!claude.isConfigured()) return res.status(500).json({ error: "Claude API key not configured" });

      const result = await service.restyle({ prompt, colors, frameName });
      res.json(result);
    } catch (err) {
      if (err instanceof ClaudeApiError) return res.status(500).json({ error: "Claude API error", message: err.detail });
      if (err instanceof ParseError) return res.status(500).json({ error: "Could not parse response", message: err.snippet });
      res.status(500).json({ error: "Failed to process prompt", message: err.message });
    }
  });

  return router;
};
