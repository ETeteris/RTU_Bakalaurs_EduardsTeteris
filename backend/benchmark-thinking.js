// ─────────────────────────────────────────────────────────────────────────────
// Extended thinking A/B tests izkārtojuma ģenerēšanai (Solis 2).
//
// Palaiž IDENTISKU Soļa 2 izsaukumu divos režīmos — ar extended thinking un bez —
// un salīdzina: (a) reālo token patēriņu + izmaksas, (b) robežu pārkāpumu skaitu
// izvadē. Vienīgais mainīgais ir `thinking` lauks; ievade abos gadījumos vienāda.
//
// Lietošana:  node benchmark-thinking.js [atkārtojumu_skaits] [scenārijs]
//             scenārijs: "simple" (login, noklusēti) vai "hard" (blīvs dashboard
//             ar iepriekš ievietotām komponentēm un aizņemtām zonām)
// Prasa backend/.env ar CLAUDE_API_KEY.
// ─────────────────────────────────────────────────────────────────────────────
const axios = require("axios");
require("dotenv").config();

const MODEL          = "claude-sonnet-4-6";
const MAX_TOKENS     = 16000;
const THINK_BUDGET   = 8000;
const RUNS           = Math.max(1, parseInt(process.argv[2], 10) || 3);
const PRICE_IN       = 3  / 1e6;   // $ par ievades tokenu (Sonnet 4.6)
const PRICE_OUT      = 15 / 1e6;   // $ par izvades tokenu (domāšana ietverta)

const SCREEN_W = 393;
const SCREEN_H = 852;
const SCENARIO = (process.argv[3] || "simple").toLowerCase();

const sharedStyle = {
  background: "#FFFFFF",
  colors: {
    surface: "#F1F5F9", primary: "#2563EB", primaryText: "#FFFFFF",
    textMain: "#0F172A", textSub: "#64748B", border: "#CBD5E1", inputBg: "#F8FAFC"
  },
  fonts: {
    heading: { family: "Inter", size: 28, weight: "Bold" },
    subheading: { family: "Inter", size: 18, weight: "Medium" },
    body: { family: "Inter", size: 14, weight: "Regular" },
    button: { family: "Inter", size: 16, weight: "Bold" },
    caption: { family: "Inter", size: 12, weight: "Regular" }
  },
  margin: 20
};

// ── Scenāriji ─────────────────────────────────────────────────────────────────
// SIMPLE: tukšs ekrāns, plašas sekcijas. HARD: blīvs dashboard ar iepriekš
// ievietotām komponentēm (aizņemtas zonas augšā un apakšā), daudz sīku elementu.
const scenarios = {
  simple: {
    occupied: [],
    plan: {
      screenName: "Login", ...sharedStyle,
      sections: [
        { name: "Header",  y: 0,   height: 180, content: "App logo, welcome heading and short subtitle" },
        { name: "Form",    y: 180, height: 320, content: "Email input, password input, forgot-password link" },
        { name: "Actions", y: 500, height: 200, content: "Primary sign-in button and social login buttons" },
        { name: "Footer",  y: 700, height: 152, content: "Sign-up prompt and link" }
      ],
      notes: "Clean centred login screen"
    }
  },
  hard: {
    // Spraudnis jau ievietojis galveni (0–100) un apakšējo navigāciju (782–852).
    occupied: [
      { name: "App Bar",      y: 0,   height: 100 },
      { name: "Bottom Nav",   y: 782, height: 70 }
    ],
    plan: {
      screenName: "Analytics Dashboard", ...sharedStyle,
      sections: [
        { name: "Greeting",    y: 100, height: 70,  content: "Greeting line and date subtitle" },
        { name: "Stat Cards",  y: 170, height: 140, content: "Row of three KPI cards (revenue, users, orders) each with label, big number and delta" },
        { name: "Chart Card",  y: 310, height: 200, content: "Card with chart title, legend row and a bar chart placeholder rect" },
        { name: "Activity",    y: 510, height: 200, content: "Recent activity list: four rows each with avatar rect, title text and timestamp text" },
        { name: "Quick Links", y: 710, height: 72,  content: "Two side-by-side action buttons" }
      ],
      notes: "Dense data dashboard between a fixed app bar and bottom nav"
    }
  }
};

const sel = scenarios[SCENARIO] || scenarios.simple;
const plan = sel.plan;
const occupiedZones = sel.occupied;
const FREE_TOP = plan.sections[0].y;
const FREE_BOTTOM = plan.sections[plan.sections.length - 1].y + plan.sections[plan.sections.length - 1].height;

// Atļautās krāsas validācijai (no plāna).
const allowedColors = new Set(
  [plan.background, ...Object.values(plan.colors)].map(c => c.toLowerCase())
);

const occupiedStr = occupiedZones.length
  ? occupiedZones.map(z => `  - "${z.name}": y=${z.y} to y=${z.y + z.height} (height: ${z.height}px)`).join("\n")
  : null;

// ── Soļa 2 uzvedne — VERBATIM no server.js, lai tests atspoguļo produkciju ────
const executionSystem = `You are a pixel-perfect mobile UI layout engine for a ${SCREEN_W}×${SCREEN_H}pt mobile frame.
Convert the design plan into an exact list of rect and text elements.
Return ONLY strict valid JSON — no markdown, no explanation, no code fences, no // line comments, no /* block comments */, no trailing commas. JSON.parse must accept the response on the first try.

OUTPUT SCHEMA:
{
  "frameName": "string",
  "width": ${SCREEN_W},
  "height": ${SCREEN_H},
  "backgroundColor": "#hex",
  "elements": [
    { "type": "rect", "name": "string", "x": 0, "y": 0, "width": 390, "height": 56, "color": "#hex", "cornerRadius": 0 },
    { "type": "text", "name": "string", "x": 16, "y": 18, "width": 260, "text": "real text here", "fontSize": 16, "fontWeight": "Bold", "fontFamily": "Inter", "color": "#hex", "textAlign": "LEFT" }
  ]
}

HARD RULES — every single element must satisfy all of these:
1. FRAME BOUNDS: x ≥ 0, y ≥ 0, x+width ≤ ${SCREEN_W}, y+height ≤ ${SCREEN_H}
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
  2. Place a full-width background rect: x=0, y=sectionTop, width=${SCREEN_W}, height=section.height
  3. Add cards, inputs, buttons — each entirely within [sectionTop, sectionBottom]
  4. Add all text — each entirely within its parent card or the section bounds
  5. Before moving on, verify every element: sectionTop ≤ y AND y+height ≤ sectionBottom`;

const sectionTable = plan.sections
  .map(s => `  ${s.name}: y=${s.y}, height=${s.height}, bottom=${s.y + s.height} — ${s.content}`)
  .join("\n");

const executionMessage = `Design plan:
${JSON.stringify(plan, null, 2)}

Section boundaries reference (use these exact values — do not drift):
${sectionTable}

Total height check: sections must cover ${FREE_TOP}–${FREE_BOTTOM}. Background color: ${plan.background || "#FFFFFF"}.

Build the complete screen now, section by section.`;

// ── Noturīga JSON parsēšana (kopija no server.js) ─────────────────────────────
function stripJSONComments(text) {
  let out = "", i = 0, inString = false, stringChar = "";
  while (i < text.length) {
    const c = text[i], next = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\" && i + 1 < text.length) { out += text[i + 1]; i += 2; continue; }
      if (c === stringChar) { inString = false; stringChar = ""; }
      i++;
    } else if (c === '"') { inString = true; stringChar = c; out += c; i++; }
    else if (c === "/" && next === "/") { while (i < text.length && text[i] !== "\n") i++; }
    else if (c === "/" && next === "*") { i += 2; while (i + 1 < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i += 2; }
    else { out += c; i++; }
  }
  return out;
}
function stripTrailingCommas(text) { return text.replace(/,(\s*[}\]])/g, "$1"); }
function parseClaudeJSON(raw) {
  let text = raw.replace(/^```[a-zA-Z]*\s*/m, "").replace(/\s*```\s*$/m, "").trim();
  text = stripTrailingCommas(stripJSONComments(text));
  try { return JSON.parse(text); } catch (_) {}
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const start = text.indexOf("{", searchFrom);
    if (start === -1) return null;
    let depth = 0, end = -1;
    for (let i = start; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) return null;
    try { return JSON.parse(text.substring(start, end + 1)); } catch (_) { searchFrom = end + 1; }
  }
  return null;
}

// ── Validators — saskaita objektīvi pārbaudāmos robežu pārkāpumus ─────────────
function validate(layout) {
  const v = { frame: 0, section: 0, occupied: 0, color: 0, badField: 0, total: 0, elements: 0 };
  if (!layout || !Array.isArray(layout.elements)) { v.parseFailed = true; return v; }
  v.elements = layout.elements.length;
  const tol = 1;
  for (const e of layout.elements) {
    const x = e.x, y = e.y, w = e.width, h = e.height ?? (e.fontSize ? e.fontSize * 1.4 : 0);
    // Trūkstoši / nederīgi lauki
    if (![x, y, w].every(Number.isFinite) || w <= 0) { v.badField++; continue; }
    // 1. Kadra robežas
    if (x < 0 || y < 0 || x + w > SCREEN_W + tol || y + h > SCREEN_H + tol) v.frame++;
    // 2. Sekciju robežas — elementam jāietilpst vismaz vienā sekcijā
    const inSection = plan.sections.some(s =>
      y >= s.y - tol && (y + h) <= (s.y + s.height) + tol);
    if (!inSection) v.section++;
    // 11. Aizņemto zonu pārklāšanās — nedrīkst pārklāties ar iepriekš ievietotām komp.
    const overlapsOccupied = occupiedZones.some(z =>
      !(y + h <= z.y + tol || y >= z.y + z.height - tol));
    if (overlapsOccupied) v.occupied++;
    // 6. Krāsas — tikai no plāna
    if (e.color && !allowedColors.has(String(e.color).toLowerCase())) v.color++;
  }
  v.total = v.frame + v.section + v.occupied + v.color + v.badField;
  return v;
}

// ── Viens izsaukums ───────────────────────────────────────────────────────────
async function callStep2(useThinking) {
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: executionSystem,
    messages: [{ role: "user", content: executionMessage }]
  };
  if (useThinking) body.thinking = { type: "enabled", budget_tokens: THINK_BUDGET };

  const t0 = Date.now();
  const resp = await axios.post("https://api.anthropic.com/v1/messages", body, {
    headers: {
      "x-api-key": process.env.CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    timeout: 180000
  });
  const ms = Date.now() - t0;
  const u = resp.data.usage;
  const textBlock = resp.data.content.find(b => b.type === "text");
  const layout = parseClaudeJSON(textBlock ? textBlock.text.trim() : "");
  const cost = u.input_tokens * PRICE_IN + u.output_tokens * PRICE_OUT;
  return {
    input: u.input_tokens, output: u.output_tokens, cost, ms,
    parsed: !!layout, val: validate(layout)
  };
}

function avg(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }

(async () => {
  if (!process.env.CLAUDE_API_KEY) { console.error("Trūkst CLAUDE_API_KEY backend/.env failā"); process.exit(1); }
  console.log(`Scenārijs: ${SCENARIO} (${plan.screenName}) | sekcijas: ${plan.sections.length} | aizņemtās zonas: ${occupiedZones.length}`);
  console.log(`Modelis: ${MODEL} | max_tokens: ${MAX_TOKENS} | budget_tokens: ${THINK_BUDGET}`);
  console.log(`Atkārtojumi katram režīmam: ${RUNS}\n`);

  const results = { think: [], plain: [] };

  for (let i = 1; i <= RUNS; i++) {
    for (const mode of ["think", "plain"]) {
      const useThinking = mode === "think";
      process.stdout.write(`Run ${i}/${RUNS} — ${useThinking ? "AR domāšanu " : "BEZ domāšanas"} ... `);
      try {
        const r = await callStep2(useThinking);
        results[mode].push(r);
        console.log(`in=${r.input} out=${r.output} $${r.cost.toFixed(4)} ${r.ms}ms | parsēts=${r.parsed ? "✓" : "✗"} pārkāpumi=${r.val.total} (kadrs=${r.val.frame}, sekcija=${r.val.section}, zona=${r.val.occupied}, krāsa=${r.val.color}, lauki=${r.val.badField}) elem=${r.val.elements}`);
      } catch (err) {
        console.log("KĻŪDA: " + (err.response?.data?.error?.message || err.message));
      }
    }
  }

  // ── Kopsavilkums ────────────────────────────────────────────────────────────
  function summarize(label, arr) {
    if (arr.length === 0) return console.log(`\n${label}: nav datu`);
    console.log(`\n${label} (n=${arr.length}):`);
    console.log(`  Vid. ievade:    ${avg(arr.map(r => r.input)).toFixed(0)} tok.`);
    console.log(`  Vid. izvade:    ${avg(arr.map(r => r.output)).toFixed(0)} tok.`);
    console.log(`  Vid. izmaksas:  $${avg(arr.map(r => r.cost)).toFixed(4)} / ekrāns`);
    console.log(`  Vid. ilgums:    ${(avg(arr.map(r => r.ms)) / 1000).toFixed(1)} s`);
    console.log(`  Parsēšana ok:   ${arr.filter(r => r.parsed).length}/${arr.length}`);
    console.log(`  Vid. pārkāpumi: ${avg(arr.map(r => r.val.total)).toFixed(2)} (kadrs ${avg(arr.map(r => r.val.frame)).toFixed(2)}, sekcija ${avg(arr.map(r => r.val.section)).toFixed(2)}, zona ${avg(arr.map(r => r.val.occupied)).toFixed(2)}, krāsa ${avg(arr.map(r => r.val.color)).toFixed(2)})`);
    console.log(`  Tīri (0 pārk.): ${arr.filter(r => r.parsed && r.val.total === 0).length}/${arr.length}`);
  }

  console.log("\n══════════════════ KOPSAVILKUMS ══════════════════");
  summarize("AR domāšanu", results.think);
  summarize("BEZ domāšanas", results.plain);

  if (results.think.length && results.plain.length) {
    const ct = avg(results.think.map(r => r.cost));
    const cp = avg(results.plain.map(r => r.cost));
    const vt = avg(results.think.map(r => r.val.total));
    const vp = avg(results.plain.map(r => r.val.total));
    console.log("\n── Starpība ──");
    console.log(`  Izmaksas: domāšana $${ct.toFixed(4)} pret $${cp.toFixed(4)} → ${(ct / cp).toFixed(2)}× (+$${(ct - cp).toFixed(4)}/ekrāns)`);
    console.log(`  Pārkāpumi: domāšana ${vt.toFixed(2)} pret ${vp.toFixed(2)} vid. uz ekrānu`);
  }
})();
