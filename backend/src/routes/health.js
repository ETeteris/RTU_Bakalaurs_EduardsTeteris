const express = require("express");

// Health-check routes — the UI polls these to show the backend status.
module.exports = function healthRoute() {
  const router = express.Router();

  router.get("/", (_req, res) => {
    res.json({ message: "Figma Plugin Backend is running" });
  });

  router.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  return router;
};
