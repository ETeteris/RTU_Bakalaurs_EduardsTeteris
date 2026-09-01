const express = require("express");
const { ClaudeApiError } = require("../claude/ClaudeClient");
const { ParseError } = require("../errors");

// POST /api/generate-library — component categorization + color palette.
module.exports = function libraryRoute(service, claude) {
  const router = express.Router();

  router.post("/api/generate-library", async (req, res) => {
    try {
      const { components, frameName, colors } = req.body;
      if (!components || components.length === 0) return res.status(400).json({ error: "No components provided" });
      if (!claude.isConfigured()) return res.status(500).json({ error: "Claude API key not configured" });

      const result = await service.generate({ components, frameName, colors });
      res.json(result);
    } catch (err) {
      if (err instanceof ClaudeApiError) return res.status(500).json({ error: "Claude API error", message: err.detail });
      if (err instanceof ParseError) return res.status(500).json({ error: "Could not parse response", message: err.snippet });
      console.error("[generate-library] Unexpected error:", err.message);
      res.status(500).json({ error: "Failed to generate library", message: err.message });
    }
  });

  return router;
};
