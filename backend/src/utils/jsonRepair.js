// Resilient JSON parsing of Claude responses. Claude sometimes returns JSON
// wrapped in markdown code fences, with comments, or with trailing commas —
// these helpers clean that up.

// Strips JS-style comments (// line and /* block */) from a JSON string.
// Respects strings — JSON.parse rejects the input if the "elements" array
// contains comments.
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

// Removes trailing commas in arrays and objects — Claude occasionally adds them.
function stripTrailingCommas(text) {
  return text.replace(/,(\s*[}\]])/g, "$1");
}

// Resilient JSON parsing. First strip markdown/comments/trailing commas; if a
// direct parse fails, search for the first balanced {...} block.
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

module.exports = { stripJSONComments, stripTrailingCommas, parseClaudeJSON };
