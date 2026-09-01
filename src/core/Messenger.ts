// The single channel to the UI. All services send messages through this class
// instead of directly via figma.ui.postMessage — this centralizes UI communication (SRP).
export class Messenger {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  post(message: any): void {
    figma.ui.postMessage(message);
  }

  progress(message: string): void {
    this.post({ type: "progress", message: message });
  }

  error(message: string): void {
    this.post({ type: "error", message: message });
  }
}
