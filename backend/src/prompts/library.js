// Prompts for organizing the component library and classifying the color palette.

function buildOrganize(frameName, components) {
  // Cap so the prompt does not grow too large.
  const capped = components.slice(0, 150);
  const componentsList = capped.map((c) => `- "${c.name}" (${c.width}x${c.height})`).join("\n");

  return `You are organizing a Figma component library from the frame "${frameName}".

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
}

function buildPalette(colors) {
  return `Categorize these hex colors into UI palette roles.
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
}

module.exports = { buildOrganize, buildPalette };
