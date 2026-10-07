// Simulate the unsupported runtime version through Node's real preload seam.
// Real Node 16 module-loading behavior is exercised in the packaged smoke.
Object.defineProperty(process.versions, "node", { value: "16.20.2" });
