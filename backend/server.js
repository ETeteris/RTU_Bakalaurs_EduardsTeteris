const express = require("express");
const axios = require("axios");
require("dotenv").config();
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// Izgriež JS stila komentārus (// rinda un /* bloks */) no JSON virknes.
// Respektē virknes — JSON.parse atsaka, ja "elements" masīvā ir komentāri.
function stripJSONComments(text) {
  let out = "";
  let i = 0;
  let inString = false;
  let stringChar = "";
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\" && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (c === stringChar) {
        inString = false;
        stringChar = "";
      }
      i++;
    } else if (c === '"') {
      inString = true;
      stringChar = c;
      out += c;
      i++;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i + 1 < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// Noņem beigu komatus masīvos un objektos — Claude reizēm tos pievieno.
function stripTrailingCommas(text) {
  return text.replace(/,(\s*[}\]])/g, "$1");
}

// Noturīga JSON parsēšana. Vispirms tīrām markdown/komentārus/beigu komatus,
// ja tieša parsēšana neizdodas — meklējam pirmo balansēto {...} bloku.
function parseClaudeJSON(raw) {
  let text = raw.replace(/^```[a-zA-Z]*\s*/m, "").replace(/\s*```\s*$/m, "").trim();
  text = stripTrailingCommas(stripJSONComments(text));
  try { return JSON.parse(text); } catch (_) {}
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const start = text.indexOf("{", searchFrom);
    if (start === -1) return null;
    let depth = 0;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) return null;
    try { return JSON.parse(text.substring(start, end + 1)); } catch (_) {
      searchFrom = end + 1;
    }
  }
  return null;
}

app.get("/", (req, res) => {
  res.json({ message: "Figma Plugin Backend is running" });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ── Rāmja pārkrāsošana ──────────────────────────────────────────────────────
app.post("/api/execute-prompt", async (req, res) => {
  try {
    const { prompt, colors, frameName } = req.body;
    if (!prompt) return res.status(400).json({ error: "Prompt is required" });
    if (!process.env.CLAUDE_API_KEY) return res.status(500).json({ error: "Claude API key not configured" });

    const systemPrompt = `You are a Figma design assistant that executes design operations by returning structured JSON.

When the user asks to restyle a frame (dark mode, light mode, high contrast, colorblind-friendly, sepia, etc.), return:
{
  "action": "restyle_duplicate",
  "newFrameName": "<descriptive name>",
  "description": "<one sentence describing what you did>",
  "colorMap": {
    "#original_hex": "#new_hex",
    ...
  }
}

Rules for colorMap:
- Include ALL provided colors as keys
- Dark mode: light backgrounds → dark (#0F172A, #1E293B), dark text → light (#F8FAFC, #E2E8F0)
- High contrast: maximize contrast between all colors
- Colorblind-friendly: replace red/green with blue/orange alternatives

If the request is not a color restyling, return:
{
  "action": "unsupported",
  "description": "I can only restyle colors. Try: dark mode, high contrast, sepia, colorblind-friendly."
}

Return ONLY valid JSON.`;

    const userMessage = `Frame: "${frameName}"\nColors: ${(colors || []).join(", ")}\nRequest: ${prompt}`;

    let response;
    try {
      response = await axios.post(
        "https://api.anthropic.com/v1/messages",
        { model: "claude-sonnet-4-6", max_tokens: 1024, system: systemPrompt, messages: [{ role: "user", content: userMessage }] },
        { headers: { "x-api-key": process.env.CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" } }
      );
    } catch (apiError) {
      const detail = apiError.response?.data?.error?.message || apiError.message;
      return res.status(500).json({ error: "Claude API error", message: detail });
    }

    const raw = response.data.content[0].text.trim();
    const result = parseClaudeJSON(raw);
    if (!result) return res.status(500).json({ error: "Could not parse response", message: raw.substring(0, 200) });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "Failed to process prompt", message: error.message });
  }
});

// ── Komponenšu kategorizācija + krāsu palete ────────────────────────────────
app.post("/api/generate-library", async (req, res) => {
  try {
    const { components, frameName, colors } = req.body;
    if (!components || components.length === 0) return res.status(400).json({ error: "No components provided" });
    if (!process.env.CLAUDE_API_KEY) return res.status(500).json({ error: "Claude API key not configured" });

    // Limits, lai uzvedne nepāraug.
    const capped = components.slice(0, 150);
    const componentsList = capped.map((c) => `- "${c.name}" (${c.width}x${c.height})`).join("\n");

    const prompt = `You are organizing a Figma component library from the frame "${frameName}".

For each component, do two things:
1. Group it into a logical category
2. Suggest a cleaner, more descriptive name using the format "Category / Variant" (e.g. "Button / Primary", "Input / Text Field", "Card / Product")

Return ONLY valid JSON in this exact format:
{
  "category_name": [
    { "name": "original_name", "betterName": "Category / Variant", "width": 100, "height": 50 },
    ...
  ]
}

Components to organize:
${componentsList}

Use categories like: buttons, inputs, cards, navigation, headers, icons, forms, modals, etc.
Return ONLY the JSON.`;

    let response;
    try {
      response = await axios.post(
        "https://api.anthropic.com/v1/messages",
        { model: "claude-sonnet-4-6", max_tokens: 8192, messages: [{ role: "user", content: prompt }] },
        { headers: { "x-api-key": process.env.CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" } }
      );
    } catch (apiError) {
      const detail = apiError.response?.data?.error?.message || apiError.message;
      console.error("[generate-library] Claude API error:", detail);
      return res.status(500).json({ error: "Claude API error", message: detail });
    }

    const raw = response.data.content[0].text;
    const library = parseClaudeJSON(raw);
    if (!library) {
      console.error("[generate-library] JSON parse failed. Raw (first 300):", raw.substring(0, 300));
      return res.status(500).json({ error: "Could not parse response", message: raw.substring(0, 200) });
    }

    // Krāsu klasifikācija pa paletes lomām.
    let colorPalette = null;
    if (colors && colors.length > 0) {
      const colorPrompt = `Categorize these hex colors into UI palette roles.
Return ONLY valid JSON, no markdown, no explanation.

{
  "background": ["#hex"],
  "surface": ["#hex"],
  "primary": ["#hex"],
  "secondary": ["#hex"],
  "text": ["#hex"],
  "textSecondary": ["#hex"],
  "border": ["#hex"],
  "accent": ["#hex"]
}

Rules:
- Every color must appear in exactly one category
- Use only the categories that have at least one color
- Light/near-white colors → background or surface
- Dark colors → text
- Saturated/brand colors → primary or secondary
- Muted mid-tones → border or textSecondary

Colors: ${colors.join(", ")}`;

      try {
        const paletteResponse = await axios.post(
          "https://api.anthropic.com/v1/messages",
          { model: "claude-sonnet-4-6", max_tokens: 512, messages: [{ role: "user", content: colorPrompt }] },
          { headers: { "x-api-key": process.env.CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }, timeout: 20000 }
        );
        colorPalette = parseClaudeJSON(paletteResponse.data.content[0].text);
      } catch (_) {
        console.error("[generate-library] Color palette call failed, skipping");
      }
    }

    res.json({ library, colorPalette });
  } catch (error) {
    console.error("[generate-library] Unexpected error:", error.message);
    res.status(500).json({ error: "Failed to generate library", message: error.message });
  }
});

// ── Ekrāna ģenerēšana — trīs soļu pipeline ──────────────────────────────────
// Solis 0: komponenšu atlase no bibliotēkas (tēmas konsekvence).
// Solis 1: sekciju plānošana atlikušajā brīvajā laukā.
// Solis 2: izkārtojuma ģenerēšana sekciju iekšienē (extended thinking).
app.post("/api/generate-screen", async (req, res) => {
  try {
    const { prompt, colors, fonts, palette, categories, libraryComponents, width: reqWidth, height: reqHeight } = req.body;
    if (!prompt) return res.status(400).json({ error: "Prompt is required" });
    if (!process.env.CLAUDE_API_KEY) return res.status(500).json({ error: "Claude API key not configured" });
    const screenWidth  = (reqWidth  && Number.isFinite(reqWidth)  && reqWidth  > 0) ? Math.round(reqWidth)  : 393;
    const screenHeight = (reqHeight && Number.isFinite(reqHeight) && reqHeight > 0) ? Math.round(reqHeight) : 852;
    const colorList = colors && colors.length > 0 ? colors.join(", ") : "#FFFFFF, #000000, #333333";
    const fontList  = fonts  && fonts.length  > 0 ? fonts.join(", ")  : "Inter";

    const paletteStr = palette && typeof palette === "object"
      ? Object.entries(palette).map(([role, hexes]) => `  ${role}: ${hexes.join(", ")}`).join("\n")
      : null;

    const categoriesStr = categories && categories.length > 0 ? categories.join(", ") : null;

    // ── SOLIS 0: Komponenšu atlase ──────────────────────────────────────────
    let selection = [];
    if (libraryComponents && libraryComponents.length > 0) {
      const candidatesList = libraryComponents.slice(0, 60).map(c => {
        const yFrac = (typeof c.yFraction === "number") ? c.yFraction.toFixed(2) : "0.50";
        const cat   = c.category || "uncategorized";
        const w     = c.width  || screenWidth;
        const h     = c.height || 40;
        return `  - "${c.name}" (category: ${cat}, ${w}×${h}, original yFraction=${yFrac})`;
      }).join("\n");

      const selectionSystem = `You decide which components from a Figma library to reuse on a new screen so the screen matches the library's design language. Return ONLY strict valid JSON — no markdown, no explanation, no // or /* */ comments, no trailing commas.

OUTPUT:
{
  "selection": [
    { "name": "<exact name from library>", "x": 0, "y": 0, "reason": "<one short sentence>" }
  ]
}

RULES:
- Use ONLY exact component names from the library list — never invent or rename
- AT MOST ONE top-anchored component (status bar / header / app bar / top nav — yFraction < 0.12). If several look top-anchored, pick the single best fit for the new screen and ignore the rest.
- AT MOST ONE bottom-anchored component (footer / bottom nav / tab bar — yFraction > 0.80). Same rule: pick one.
- Top-anchored components: place at y = round(yFraction * ${screenHeight}) (usually 0)
- Bottom-anchored components: place at y = ${screenHeight} - component.height
- Reusable buttons / inputs / cards / list items: include only if the prompt's screen actually needs them; pick at most 3 to avoid clutter
- Decorative or screen-specific components (charts, hero banners, dashboard widgets, components named after the source screen): only reuse if the prompt explicitly calls for that content
- No two selected components may have overlapping y-ranges
- Do NOT pick two components that play the same role (e.g. two headers, two nav bars) — they will visually stack and look broken
- x defaults to 0 (full-width components); set non-zero only for narrower components you intentionally place off-edge
- y must be an integer in [0, ${screenHeight} - component.height]
- If nothing in the library fits the new screen, return {"selection": []}`;

      const selectionMessage = `New screen prompt: "${prompt}"
Screen size: ${screenWidth}×${screenHeight}

Available library components:
${candidatesList}`;

      try {
        const selResponse = await axios.post(
          "https://api.anthropic.com/v1/messages",
          { model: "claude-sonnet-4-6", max_tokens: 1024, system: selectionSystem, messages: [{ role: "user", content: selectionMessage }] },
          { headers: { "x-api-key": process.env.CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }, timeout: 30000 }
        );
        const selRaw = selResponse.data.content[0].text.trim();
        const selJson = parseClaudeJSON(selRaw);
        if (selJson && Array.isArray(selJson.selection)) {
          // Filtrējam līdz reāli eksistējošiem nosaukumiem un fiksējam x/y robežās.
          const byName = new Map(libraryComponents.map(c => [c.name, c]));
          selection = selJson.selection
            .filter(s => s && byName.has(s.name))
            .map(s => {
              const lib = byName.get(s.name);
              const h   = lib.height || 40;
              const w   = lib.width  || screenWidth;
              let x = Number.isFinite(s.x) ? Math.round(s.x) : 0;
              let y = Number.isFinite(s.y) ? Math.round(s.y) : Math.round((lib.yFraction || 0) * screenHeight);
              x = Math.max(0, Math.min(x, screenWidth  - 1));
              y = Math.max(0, Math.min(y, screenHeight - h));
              return { name: s.name, x, y, width: w, height: h, reason: s.reason || "" };
            });

          // Drošības tīkls: viena augšai, viena apakšai, bez pārklājumiem,
          // bez nosaukumu dublikātiem. yFrakcija ir uzticamāka par Claude izvēlēto y.
          const seenNames = new Set();
          const kept = [];
          let topPicked = false;
          let botPicked = false;
          for (const s of selection.sort((a, b) => a.y - b.y)) {
            if (seenNames.has(s.name)) continue;
            const lib = libraryComponents.find(c => c.name === s.name);
            const yFrac = (lib && typeof lib.yFraction === "number")
              ? lib.yFraction
              : (s.y / screenHeight);
            const isTop = yFrac < 0.12;
            const isBot = yFrac > 0.80;
            if (isTop && topPicked) {
              console.log("[generate-screen] Dropping duplicate top-anchored:", s.name);
              continue;
            }
            if (isBot && botPicked) {
              console.log("[generate-screen] Dropping duplicate bottom-anchored:", s.name);
              continue;
            }
            const overlap = kept.some(k => !(s.y + s.height <= k.y || s.y >= k.y + k.height));
            if (overlap) {
              console.log("[generate-screen] Dropping overlapping:", s.name);
              continue;
            }
            if (isTop) topPicked = true;
            if (isBot) botPicked = true;
            seenNames.add(s.name);
            kept.push(s);
          }
          selection = kept;
        }
        if (selection.length === 0) {
          console.log("[generate-screen] Step 0 selection: none");
        } else {
          console.log("[generate-screen] Step 0 selection:");
          for (const s of selection) {
            console.log(`  - ${s.name} @y=${s.y}` + (s.reason ? ` — ${s.reason}` : ""));
          }
        }
      } catch (apiError) {
        const detail = apiError.response?.data?.error?.message || apiError.message;
        console.error("[generate-screen] Step 0 selection failed (continuing without):", detail);
      }
    }

    const occupiedZones = selection.map(s => ({ name: s.name, y: s.y, height: s.height }));
    const occupiedStr = occupiedZones.length > 0
      ? occupiedZones.map(z => `  - "${z.name}": y=${z.y} to y=${z.y + z.height} (height: ${z.height}px)`).join("\n")
      : null;

    // Lielākais brīvais vertikālais intervāls. Ja gan galvene, gan kājene
    // ir aizņemtas, brīvais laukums ir vidū, nevis tikai virs galvenes.
    function computeFreeRange() {
      if (occupiedZones.length === 0) return { freeTop: 0, freeBottom: screenHeight };
      const sorted = [...occupiedZones].sort((a, b) => a.y - b.y);
      const gaps = [];
      let cursor = 0;
      for (const z of sorted) {
        if (z.y > cursor) gaps.push({ top: cursor, bottom: z.y });
        cursor = Math.max(cursor, z.y + z.height);
      }
      if (cursor < screenHeight) gaps.push({ top: cursor, bottom: screenHeight });
      if (gaps.length === 0) return { freeTop: 0, freeBottom: 0 };
      let largest = gaps[0];
      for (const g of gaps) if (g.bottom - g.top > largest.bottom - largest.top) largest = g;
      return { freeTop: largest.top, freeBottom: largest.bottom };
    }
    const { freeTop, freeBottom } = computeFreeRange();
    const freeHeight = freeBottom - freeTop;

    console.log("[generate-screen] ── Step 1: Design planning ──");
    console.log("[generate-screen] prompt:", prompt);
    console.log("[generate-screen] size:", screenWidth + "x" + screenHeight);
    console.log("[generate-screen] palette:", colorList);
    console.log("[generate-screen] fonts:", fontList);
    console.log("[generate-screen] occupied zones:", occupiedStr || "none");
    console.log("[generate-screen] free range: y=" + freeTop + " to y=" + freeBottom + " (" + freeHeight + "px)");

    // ── SOLIS 1: Dizaina plāna izveide ──────────────────────────────────────
    const planningSystem = `You are a senior UI/UX designer planning a mobile screen layout.
Return ONLY strict valid JSON — no markdown, no explanation, no code fences, no // or /* */ comments, no trailing commas.

{
  "screenName": "Screen Name",
  "background": "#hex",
  "colors": {
    "surface": "#hex",
    "primary": "#hex",
    "primaryText": "#hex",
    "textMain": "#hex",
    "textSub": "#hex",
    "border": "#hex",
    "inputBg": "#hex"
  },
  "fonts": {
    "heading": { "family": "name", "size": 24, "weight": "Bold" },
    "subheading": { "family": "name", "size": 18, "weight": "Medium" },
    "body":    { "family": "name", "size": 14, "weight": "Regular" },
    "button":  { "family": "name", "size": 16, "weight": "Bold" },
    "caption": { "family": "name", "size": 12, "weight": "Regular" }
  },
  "sections": [
    { "name": "Section 1", "y": ${freeTop}, "height": <int>, "content": "brief description" }
  ],
  "margin": 20,
  "notes": "one sentence design intent"
}

Rules:
- Use ONLY the exact hex colors from the palette — do NOT invent any color not in the list
- Use ONLY fonts from the font list provided
- sections[].y and sections[].height must be integers
- Sections must cover y=${freeTop} to y=${freeBottom} exactly — pre-placed library components occupy the rest of the screen
- Sections must not overlap: each section's y must equal the previous section's y + height
- The first section's y must equal ${freeTop}
- The last section must end at y=${freeBottom} (i.e. last section's y + height = ${freeBottom})
- The palette may contain a light beige or off-white canvas color — do NOT use it as a card, button, or input background
- Keep content descriptions brief — this feeds a layout engine that will implement every section${occupiedStr ? `
- PRE-PLACED BY PLUGIN (do NOT plan any section that covers these y-ranges — the plugin has already placed real components there):
${occupiedStr}` : ""}`;

    const planningMessage = `Screen: "${prompt}"
${paletteStr ? `Palette by role:\n${paletteStr}` : `Palette: ${colorList}`}
Fonts: ${fontList}${categoriesStr ? `\nLibrary sections: ${categoriesStr}` : ""}`;

    let planResponse;
    try {
      planResponse = await axios.post(
        "https://api.anthropic.com/v1/messages",
        { model: "claude-sonnet-4-6", max_tokens: 1024, system: planningSystem, messages: [{ role: "user", content: planningMessage }] },
        { headers: { "x-api-key": process.env.CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }, timeout: 60000 }
      );
    } catch (apiError) {
      const detail = apiError.response?.data?.error?.message || apiError.message;
      console.error("[generate-screen] Step 1 API error:", detail);
      return res.status(500).json({ error: "Claude API error (planning)", message: detail });
    }

    const planRaw = planResponse.data.content[0].text.trim();
    const plan = parseClaudeJSON(planRaw);
    if (!plan) {
      console.error("[generate-screen] Step 1 parse failed:", planRaw.substring(0, 300));
      return res.status(500).json({ error: "Could not parse design plan", message: planRaw.substring(0, 200) });
    }

    console.log("[generate-screen] ── Step 1 complete ──");
    console.log("[generate-screen] Screen:", plan.screenName);
    console.log("[generate-screen] Sections:", plan.sections && plan.sections.map(s => s.name).join(", "));
    console.log("[generate-screen] ── Step 2: Layout generation (extended thinking) ──");

    // ── SOLIS 2: Izkārtojuma ģenerēšana ar extended thinking ────────────────
    const executionSystem = `You are a pixel-perfect mobile UI layout engine for a ${screenWidth}×${screenHeight}pt mobile frame.
Convert the design plan into an exact list of rect and text elements.
Return ONLY strict valid JSON — no markdown, no explanation, no code fences, no // line comments, no /* block comments */, no trailing commas. JSON.parse must accept the response on the first try.

OUTPUT SCHEMA:
{
  "frameName": "string",
  "width": ${screenWidth},
  "height": ${screenHeight},
  "backgroundColor": "#hex",
  "elements": [
    { "type": "rect", "name": "string", "x": 0, "y": 0, "width": 390, "height": 56, "color": "#hex", "cornerRadius": 0 },
    { "type": "text", "name": "string", "x": 16, "y": 18, "width": 260, "text": "real text here", "fontSize": 16, "fontWeight": "Bold", "fontFamily": "Inter", "color": "#hex", "textAlign": "LEFT" }
  ]
}

HARD RULES — every single element must satisfy all of these:
1. FRAME BOUNDS: x ≥ 0, y ≥ 0, x+width ≤ ${screenWidth}, y+height ≤ ${screenHeight}
2. SECTION BOUNDS: every element belongs to exactly one section; its y and y+height must fall within that section's y and y+height
3. BUTTONS: the text label rect must have the same x, same width, and a y that centres it vertically inside the button rect; textAlign must be "CENTER"
4. INPUTS: placeholder text x = input rect x + 12, width = input rect width - 24
5. CARDS: card rect has cornerRadius 16; all text inside a card must be within the card's x+16 to x+width-16 horizontal range
6. COLORS: use only hex values that appear in the design plan — no new colors
7. FONTS: use only font families from the plan
8. CONTENT: realistic text only — no "Lorem ipsum", "Text Here", "Label", "Sample", or "Placeholder"
9. LAYERING: backgrounds first, then surfaces and cards, then text and icons on top
10. SPACING: minimum 8pt gap between consecutive text elements within a section
11. OCCUPIED ZONES: The plugin has ALREADY placed real component instances in these y-ranges. Do NOT generate any element whose y range overlaps these zones:
${occupiedStr || "  (none — fill the entire screen)"}

BUILD PROCESS — work one section at a time:
For each section in the plan:
  1. Record sectionTop = section.y and sectionBottom = section.y + section.height
  2. Place a full-width background rect: x=0, y=sectionTop, width=${screenWidth}, height=section.height
  3. Add cards, inputs, buttons — each entirely within [sectionTop, sectionBottom]
  4. Add all text — each entirely within its parent card or the section bounds
  5. Before moving on, verify every element: sectionTop ≤ y AND y+height ≤ sectionBottom`;

    // Sekciju tabula tieši uzvednē, lai Claude nepārrēķina.
    const sectionTable = plan.sections
      ? plan.sections.map(s => `  ${s.name}: y=${s.y}, height=${s.height}, bottom=${s.y + s.height} — ${s.content}`).join("\n")
      : "(no sections in plan)";

    const executionMessage = `Design plan:
${JSON.stringify(plan, null, 2)}

Section boundaries reference (use these exact values — do not drift):
${sectionTable}

Total height check: sections must cover ${freeTop}–${freeBottom}. Background color: ${plan.background || "#FFFFFF"}.

Build the complete screen now, section by section.`;

    let layoutResponse;
    try {
      layoutResponse = await axios.post(
        "https://api.anthropic.com/v1/messages",
        {
          model: "claude-sonnet-4-6",
          max_tokens: 16000,
          thinking: { type: "enabled", budget_tokens: 8000 },
          system: executionSystem,
          messages: [{ role: "user", content: executionMessage }]
        },
        { headers: { "x-api-key": process.env.CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }, timeout: 120000 }
      );
    } catch (apiError) {
      const detail = apiError.response?.data?.error?.message || apiError.message;
      console.error("[generate-screen] Step 2 API error:", detail);
      return res.status(500).json({ error: "Claude API error (layout)", message: detail });
    }

    // Extended thinking atbildē ir thinking bloks + teksta bloks — meklējam tekstu.
    const textBlock = layoutResponse.data.content.find(b => b.type === "text");
    const layoutRaw = textBlock ? textBlock.text.trim() : "";
    console.log("[generate-screen] Step 2 responded, length:", layoutRaw.length, "chars");

    const layout = parseClaudeJSON(layoutRaw);
    if (!layout) {
      console.error("[generate-screen] Step 2 parse failed:", layoutRaw.substring(0, 300));
      return res.status(500).json({ error: "Could not parse layout", message: layoutRaw.substring(0, 200) });
    }

    layout._selection = selection;
    console.log("[generate-screen] ── Done. Elements:", layout.elements && layout.elements.length);
    res.json(layout);

  } catch (error) {
    console.error("[generate-screen] Unexpected error:", error.message);
    res.status(500).json({ error: "Failed to generate screen", message: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
