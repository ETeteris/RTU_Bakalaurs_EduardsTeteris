// Shared interfaces for the plugin. Figma nodes are kept as `any` (as in the
// original code) because the Figma API types are broad and dynamic.

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export type ColorMap = { [hex: string]: string };

// A library component sent to the backend for selection.
export interface LibraryComponent {
  nodeId: string;
  name: string;
  category: string;
  width: number;
  height: number;
  yFraction: number;
  zone: string;
}

// A selected component returned by the backend, to be placed on the screen.
export interface PlacedComponent {
  nodeId: string;
  name: string;
  targetX: number;
  targetY: number;
  height: number;
}

// Styles read from the Asset Library page for Generate Screen.
export interface StylesFromLibrary {
  colors: string[];
  fonts: string[];
  palette: { [role: string]: string[] } | null;
  categories: string[];
  libraryComponents: LibraryComponent[];
}

// Incoming messages from the UI. Each handler takes what it needs.
export interface PluginMessage {
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}
