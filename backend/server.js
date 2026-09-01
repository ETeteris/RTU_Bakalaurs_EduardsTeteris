const express = require("express");
require("dotenv").config();
const cors = require("cors");

const { ClaudeClient } = require("./src/claude/ClaudeClient");
const { RestyleService } = require("./src/services/RestyleService");
const { LibraryService } = require("./src/services/LibraryService");
const { ScreenGenerator } = require("./src/services/ScreenGenerator");

const healthRoute = require("./src/routes/health");
const restyleRoute = require("./src/routes/restyle");
const libraryRoute = require("./src/routes/library");
const screenRoute = require("./src/routes/screen");

const app = express();
app.use(cors());
app.use(express.json());

// A single Claude client shared by all services (DIP — services don't know about axios).
const claude = new ClaudeClient();

app.use(healthRoute());
app.use(restyleRoute(new RestyleService(claude), claude));
app.use(libraryRoute(new LibraryService(claude), claude));
app.use(screenRoute(new ScreenGenerator(claude), claude));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
