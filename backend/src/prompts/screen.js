// Prompts for the three-step screen generation pipeline: (0) component
// selection, (1) design planning, (2) layout generation with extended thinking.

// ── STEP 0: Component selection ─────────────────────────────────────────────
function buildSelectionSystem(screenHeight) {
  return `You decide which components from a Figma library to reuse on a new screen so the screen matches the library's design language. Return ONLY strict valid JSON — no markdown, no explanation, no // or /* */ comments, no trailing commas.

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
}

function buildSelectionMessage(prompt, screenWidth, screenHeight, candidatesList) {
  return `New screen prompt: "${prompt}"
Screen size: ${screenWidth}×${screenHeight}

Available library components:
${candidatesList}`;
}

// ── STEP 1: Design planning ─────────────────────────────────────────────────
function buildPlanningSystem(freeTop, freeBottom, occupiedStr) {
  return `You are a senior UI/UX designer planning a mobile screen layout.
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
}

function buildPlanningMessage(prompt, paletteStr, colorList, fontList, categoriesStr) {
  return `Screen: "${prompt}"
${paletteStr ? `Palette by role:\n${paletteStr}` : `Palette: ${colorList}`}
Fonts: ${fontList}${categoriesStr ? `\nLibrary sections: ${categoriesStr}` : ""}`;
}

// ── STEP 2: Layout generation ───────────────────────────────────────────────
function buildExecutionSystem(screenWidth, screenHeight, occupiedStr) {
  return `You are a pixel-perfect mobile UI layout engine for a ${screenWidth}×${screenHeight}pt mobile frame.
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
}

function buildExecutionMessage(plan, sectionTable, freeTop, freeBottom) {
  return `Design plan:
${JSON.stringify(plan, null, 2)}

Section boundaries reference (use these exact values — do not drift):
${sectionTable}

Total height check: sections must cover ${freeTop}–${freeBottom}. Background color: ${plan.background || "#FFFFFF"}.

Build the complete screen now, section by section.`;
}

module.exports = {
  buildSelectionSystem,
  buildSelectionMessage,
  buildPlanningSystem,
  buildPlanningMessage,
  buildExecutionSystem,
  buildExecutionMessage,
};
