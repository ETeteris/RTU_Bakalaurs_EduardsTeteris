const screenPrompts = require("../prompts/screen");
const { parseClaudeJSON } = require("../utils/jsonRepair");
const { ClaudeApiError } = require("../claude/ClaudeClient");
const { HttpError } = require("../errors");

// Screen generation — a three-step pipeline:
//   Step 0: select components from the library (theme consistency).
//   Step 1: plan the sections in the remaining free area.
//   Step 2: generate the layout inside the sections (extended thinking).
class ScreenGenerator {
  constructor(claude) {
    this.claude = claude;
  }

  async generate(body) {
    const { prompt, colors, fonts, palette, categories, libraryComponents } = body;
    const screenWidth  = (body.width  && Number.isFinite(body.width)  && body.width  > 0) ? Math.round(body.width)  : 393;
    const screenHeight = (body.height && Number.isFinite(body.height) && body.height > 0) ? Math.round(body.height) : 852;
    const colorList = colors && colors.length > 0 ? colors.join(", ") : "#FFFFFF, #000000, #333333";
    const fontList  = fonts  && fonts.length  > 0 ? fonts.join(", ")  : "Inter";

    const paletteStr = palette && typeof palette === "object"
      ? Object.entries(palette).map(([role, hexes]) => `  ${role}: ${hexes.join(", ")}`).join("\n")
      : null;

    const categoriesStr = categories && categories.length > 0 ? categories.join(", ") : null;

    // ── STEP 0 ─────────────────────────────────────────────────────────────────
    const selection = await this.selectComponents(prompt, libraryComponents, screenWidth, screenHeight);

    const occupiedZones = selection.map(s => ({ name: s.name, y: s.y, height: s.height }));
    const occupiedStr = occupiedZones.length > 0
      ? occupiedZones.map(z => `  - "${z.name}": y=${z.y} to y=${z.y + z.height} (height: ${z.height}px)`).join("\n")
      : null;

    const { freeTop, freeBottom } = ScreenGenerator.computeFreeRange(occupiedZones, screenHeight);
    const freeHeight = freeBottom - freeTop;

    console.log("[generate-screen] ── Step 1: Design planning ──");
    console.log("[generate-screen] prompt:", prompt);
    console.log("[generate-screen] size:", screenWidth + "x" + screenHeight);
    console.log("[generate-screen] palette:", colorList);
    console.log("[generate-screen] fonts:", fontList);
    console.log("[generate-screen] occupied zones:", occupiedStr || "none");
    console.log("[generate-screen] free range: y=" + freeTop + " to y=" + freeBottom + " (" + freeHeight + "px)");

    // ── STEP 1 ─────────────────────────────────────────────────────────────────
    const plan = await this.plan({ prompt, freeTop, freeBottom, occupiedStr, paletteStr, colorList, fontList, categoriesStr });

    console.log("[generate-screen] ── Step 1 complete ──");
    console.log("[generate-screen] Screen:", plan.screenName);
    console.log("[generate-screen] Sections:", plan.sections && plan.sections.map(s => s.name).join(", "));
    console.log("[generate-screen] ── Step 2: Layout generation (extended thinking) ──");

    // ── STEP 2 ─────────────────────────────────────────────────────────────────
    const layout = await this.layout({ plan, screenWidth, screenHeight, occupiedStr, freeTop, freeBottom });

    layout._selection = selection;
    console.log("[generate-screen] ── Done. Elements:", layout.elements && layout.elements.length);
    return layout;
  }

  // ── STEP 0: Component selection ───────────────────────────────────────────
  // A failure here is not rethrown — we continue without the selected components.
  async selectComponents(prompt, libraryComponents, screenWidth, screenHeight) {
    let selection = [];
    if (!libraryComponents || libraryComponents.length === 0) return selection;

    const candidatesList = libraryComponents.slice(0, 60).map(c => {
      const yFrac = (typeof c.yFraction === "number") ? c.yFraction.toFixed(2) : "0.50";
      const cat   = c.category || "uncategorized";
      const w     = c.width  || screenWidth;
      const h     = c.height || 40;
      return `  - "${c.name}" (category: ${cat}, ${w}×${h}, original yFraction=${yFrac})`;
    }).join("\n");

    const selectionSystem  = screenPrompts.buildSelectionSystem(screenHeight);
    const selectionMessage = screenPrompts.buildSelectionMessage(prompt, screenWidth, screenHeight, candidatesList);

    try {
      const { text, usage } = await this.claude.message({
        system: selectionSystem,
        messages: [{ role: "user", content: selectionMessage }],
        maxTokens: 1024,
        timeout: 30000,
      });
      if (usage) {
        console.log(`[generate-screen] Step 0 usage: input=${usage.input_tokens}, output=${usage.output_tokens}`);
      }
      const selJson = parseClaudeJSON(text.trim());
      if (selJson && Array.isArray(selJson.selection)) {
        // Filter down to names that really exist and clamp x/y into bounds.
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

        // Safety net: at most one top, at most one bottom, no overlaps, no
        // duplicate names. yFraction is more reliable than the y Claude picked.
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
      const detail = apiError instanceof ClaudeApiError ? apiError.detail : apiError.message;
      console.error("[generate-screen] Step 0 selection failed (continuing without):", detail);
    }

    return selection;
  }

  // ── STEP 1: Build the design plan ─────────────────────────────────────────
  async plan({ prompt, freeTop, freeBottom, occupiedStr, paletteStr, colorList, fontList, categoriesStr }) {
    const planningSystem  = screenPrompts.buildPlanningSystem(freeTop, freeBottom, occupiedStr);
    const planningMessage = screenPrompts.buildPlanningMessage(prompt, paletteStr, colorList, fontList, categoriesStr);

    let result;
    try {
      result = await this.claude.message({
        system: planningSystem,
        messages: [{ role: "user", content: planningMessage }],
        maxTokens: 1024,
        timeout: 60000,
      });
    } catch (apiError) {
      const detail = apiError instanceof ClaudeApiError ? apiError.detail : apiError.message;
      console.error("[generate-screen] Step 1 API error:", detail);
      throw new HttpError("Claude API error (planning)", detail);
    }

    if (result.usage) {
      console.log(`[generate-screen] Step 1 usage: input=${result.usage.input_tokens}, output=${result.usage.output_tokens}`);
    }
    const planRaw = result.text.trim();
    const plan = parseClaudeJSON(planRaw);
    if (!plan) {
      console.error("[generate-screen] Step 1 parse failed:", planRaw.substring(0, 300));
      throw new HttpError("Could not parse design plan", planRaw.substring(0, 200));
    }
    return plan;
  }

  // ── STEP 2: Layout generation with extended thinking ──────────────────────
  async layout({ plan, screenWidth, screenHeight, occupiedStr, freeTop, freeBottom }) {
    const executionSystem = screenPrompts.buildExecutionSystem(screenWidth, screenHeight, occupiedStr);

    // Section table straight into the prompt so Claude does not recompute it.
    const sectionTable = plan.sections
      ? plan.sections.map(s => `  ${s.name}: y=${s.y}, height=${s.height}, bottom=${s.y + s.height} — ${s.content}`).join("\n")
      : "(no sections in plan)";

    const executionMessage = screenPrompts.buildExecutionMessage(plan, sectionTable, freeTop, freeBottom);

    let result;
    try {
      result = await this.claude.message({
        maxTokens: 16000,
        thinking: { type: "enabled", budget_tokens: 8000 },
        system: executionSystem,
        messages: [{ role: "user", content: executionMessage }],
        timeout: 120000,
      });
    } catch (apiError) {
      const detail = apiError instanceof ClaudeApiError ? apiError.detail : apiError.message;
      console.error("[generate-screen] Step 2 API error:", detail);
      throw new HttpError("Claude API error (layout)", detail);
    }

    if (result.usage) {
      const u = result.usage;
      // With extended thinking, output_tokens INCLUDES the thinking tokens.
      const cost = (u.input_tokens * 3 + u.output_tokens * 15) / 1e6;
      console.log(`[generate-screen] Step 2 usage: input=${u.input_tokens}, output=${u.output_tokens} (with thinking), cost≈$${cost.toFixed(4)}`);
    }
    // The extended-thinking response has a thinking block plus a text block — text is the textual one.
    const layoutRaw = result.text.trim();
    console.log("[generate-screen] Step 2 responded, length:", layoutRaw.length, "chars");

    const layout = parseClaudeJSON(layoutRaw);
    if (!layout) {
      console.error("[generate-screen] Step 2 parse failed:", layoutRaw.substring(0, 300));
      throw new HttpError("Could not parse layout", layoutRaw.substring(0, 200));
    }
    return layout;
  }

  // Largest free vertical gap. If both a header and a footer are occupied, the
  // free area is in the middle, not just above the header.
  static computeFreeRange(occupiedZones, screenHeight) {
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
}

module.exports = { ScreenGenerator };
