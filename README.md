# Figma AI Design Assistant

This is a Figma plugin that uses the Anthropic Claude API to help automate several
UI/UX design tasks inside Figma.

The plugin was developed as part of a bachelor's thesis.

Author: Eduards Teteris

Supervisor: Oksana Ņikiforova

## Features

| Feature | Description |
|---|---|
| **Restyle** | Recolors a selected Figma frame based on a text command such as `dark mode`, `high contrast`, or `sepia`. The original frame is left untouched — a restyled duplicate is created instead. |
| **Generate Library** | Reads the selected Figma frame and builds a structured `Asset Library` page with components and a color palette. If a library already exists, it is extended without creating duplicates. |
| **Generate Screen** | Generates a new screen from a text description, reusing components from the `Asset Library` page. |
| **Generate Journey** | Generates several connected screens from a list such as `Login → Dashboard → Settings` and links them with arrows. |

## What is in the project?

The project has two main parts:

1. **Figma plugin**
   Runs inside Figma and creates or transforms elements on the canvas.

2. **Node.js server**
   Runs locally on your machine and forwards requests to the Anthropic Claude API.
   The API key is stored on the server side, not inside the Figma plugin.

Simplified architecture:

```text
Figma plugin  →  Node.js server  →  Claude API
```

## Project file structure

The code is split into small modules by responsibility (OOP / SOLID principles).
Each feature has its own service on both the plugin side and the server side.

```text
.
├── src/                     Figma plugin source code (TypeScript modules)
│   ├── main.ts              Entry point — creates services and registers routes
│   ├── types.ts             Shared interfaces (types)
│   ├── core/
│   │   ├── Messenger.ts     The single channel to the UI (figma.ui.postMessage)
│   │   └── MessageRouter.ts Incoming message router (msg.type → handler)
│   ├── utils/
│   │   ├── color.ts         Color conversion (rgb ↔ hex)
│   │   └── nodes.ts         Node traversal and color replacement
│   └── services/
│       ├── RestyleService.ts    Frame recoloring
│       ├── ScreenService.ts     Screen generation from the Asset Library
│       ├── JourneyService.ts    UX journey (multi-screen) generation
│       └── LibraryService.ts    Asset Library creation and color palette
├── code.js                  Bundled plugin file (what Figma runs; generated)
├── ui.html                  Plugin user interface
├── manifest.json            Figma plugin configuration file
├── tsconfig.json            TypeScript configuration (type checking)
├── eslint.config.js         Linter configuration
├── package.json             Plugin scripts and dependencies
├── backend/
│   ├── server.js            Node.js server entry point (bootstrap only)
│   ├── src/
│   │   ├── claude/ClaudeClient.js   The single place that talks to the Claude API
│   │   ├── errors.js                Error classes (ParseError, HttpError)
│   │   ├── utils/jsonRepair.js      Resilient parsing of Claude JSON responses
│   │   ├── prompts/                 Prompt builders
│   │   │   ├── restyle.js
│   │   │   ├── library.js
│   │   │   └── screen.js
│   │   ├── services/                Business logic for each feature
│   │   │   ├── RestyleService.js
│   │   │   ├── LibraryService.js
│   │   │   └── ScreenGenerator.js   Three-step screen generation pipeline
│   │   └── routes/                  Express routes (API endpoints)
│   │       ├── health.js
│   │       ├── restyle.js
│   │       ├── library.js
│   │       └── screen.js
│   ├── .env                 Claude API key
│   └── package.json         Server dependencies
└── diagrams/                Diagrams for the thesis
```

### How does the source code become the plugin?

Figma runs only one file — `code.js`. That file is **generated** from the `src/`
modules with **esbuild**, which bundles all the `import`/`export` modules into a
single file (Figma cannot load separate modules at runtime).

```text
src/main.ts (+ all modules)  →  npm run build (esbuild)  →  code.js  →  Figma
```

So after any change in the `src/` folder you must run `npm run build` again (or
keep `npm run watch` running) to update `code.js`. The `code.js` file is not stored
in the Git repository — it is regenerated with `npm run build`.

On the server side (`backend/`) Node.js supports modules directly, so no build step
is needed — `server.js` imports the services from `backend/src/` and runs them.

## What is required before running?

Before running the plugin you need:

- **Node.js** installed;
- an **Anthropic Claude API key**;
- access to **Figma**;
- this project downloaded.

You can obtain a Claude API key from the Anthropic Console.

## How to run the project

### 1. Install the project dependencies

In the main project folder run:

```bash
npm install
```

Then install the server dependencies:

```bash
cd backend
npm install
cd ..
```

### 2. Add the Claude API key

In the `backend` folder create a file:

```text
.env
```

Put your Claude API key into the file:

```text
CLAUDE_API_KEY=sk-ant-...
```

Important: the `.env` file must not be published on GitHub or in other public
repositories.

### 3. Build the Figma plugin

In the main project folder run:

```bash
npm run build
```

This command bundles the `src/` modules (starting from `src/main.ts`) into the
`code.js` file that Figma can run.

During development you can also use:

```bash
npm run watch
```

Optional checks:

```bash
npm run typecheck   # TypeScript type checking (no output = OK)
npm run lint        # code style checks
```

### 4. Start the server

Open the `backend` folder:

```bash
cd backend
```

Then start the server:

```bash
npm start
```

The server will run at:

```text
http://localhost:3000
```

Keep the terminal with the running server open while using the plugin.

### 5. Import the plugin into Figma

In Figma do the following:

1. open any Figma file;
2. choose **Plugins → Development → Import plugin from manifest...**;
3. select the project's `manifest.json` file;
4. after importing, run the plugin from **Plugins → Development**.

## How to use the plugin

### Restyle

1. Select a frame in Figma.
2. Enter a command in the plugin, for example:

```text
dark mode
```

or

```text
high contrast
```

3. The plugin creates a new restyled version of the frame next to the original.

### Generate Library

1. Select a frame in Figma.
2. Press **Generate Asset Library** in the plugin.
3. The plugin creates a new `Asset Library` page.
4. Components, categories, and a color palette are placed on this page.

### Generate Screen

1. First create an `Asset Library`.
2. Enter a screen description in the plugin, for example:

```text
login screen
```

or

```text
settings screen
```

3. The plugin generates a new screen reusing the components from the `Asset Library` page.

### Generate Journey

Enter several screen names in the plugin, for example:

```text
Login → Dashboard → Settings
```

The plugin generates several screens and connects them with arrows.

## Important limitations

- Each user needs their own Anthropic Claude API key.
- The Node.js server must be running locally, otherwise the plugin cannot reach the Claude API.
- The generated results are not always fully production-ready, so they should be reviewed and manually adjusted if needed.
- Journey screens are generated separately, so there may be small differences between screens.
- The plugin is a prototype, not a fully finished commercial product.

## License

MIT license.
