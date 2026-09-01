const express = require("express");
const { HttpError } = require("../errors");

// POST /api/generate-screen — screen generation (three-step pipeline).
module.exports = function screenRoute(service, claude) {
  const router = express.Router();

  router.post("/api/generate-screen", async (req, res) => {
    try {
      const { prompt } = req.body;
      if (!prompt) return res.status(400).json({ error: "Prompt is required" });
      if (!claude.isConfigured()) return res.status(500).json({ error: "Claude API key not configured" });

      const layout = await service.generate(req.body);
      res.json(layout);
    } catch (err) {
      // Step 1/2 errors arrive as HttpError with the exact label (planning/layout).
      if (err instanceof HttpError) return res.status(500).json({ error: err.error, message: err.detail });
      console.error("[generate-screen] Unexpected error:", err.message);
      res.status(500).json({ error: "Failed to generate screen", message: err.message });
    }
  });

  return router;
};
