"use client";

import { useEffect, useState } from "react";

/**
 * Database Reset Handler
 *
 * This component runs early in the app lifecycle and checks for a special
 * URL parameter (?reset=true) to force a database reset. This is a last-resort
 * recovery mechanism when the database is so corrupted that the normal
 * "Clear Data & Reload" button doesn't work.
 *
 * Usage: Navigate to https://your-app.com/?reset=true
 *
 * The reset happens BEFORE IndexedDB is opened by any other part of the app,
 * which helps avoid the "blocked" issue that occurs when trying to delete
 * a database that has active connections.
 */
export function DatabaseResetHandler() {
  const [isResetting, setIsResetting] = useState(false);

  useEffect(() => {
    // Check for reset parameter in URL
    const params = new URLSearchParams(window.location.search);
    if (params.get("reset") !== "true") {
      return;
    }

    // Start reset process
    setIsResetting(true);
    console.log("Database reset requested via URL parameter");

    const performReset = async () => {
      // Clear localStorage first (synchronous, always works)
      try {
        localStorage.clear();
        sessionStorage.clear();
        console.log("Cleared localStorage and sessionStorage");
      } catch (e) {
        console.warn("Failed to clear storage:", e);
      }

      // Delete all TradeBlocks IndexedDB databases
      const dbsToDelete = ["TradeBlocksDB", "tradeblocks-cache"];

      for (const dbName of dbsToDelete) {
        try {
          await new Promise<void>((resolve) => {
            const req = indexedDB.deleteDatabase(dbName);

            const timeout = setTimeout(() => {
              console.warn(`Deletion of ${dbName} timed out`);
              resolve();
            }, 5000);

            req.onsuccess = () => {
              clearTimeout(timeout);
              console.log(`Successfully deleted ${dbName}`);
              resolve();
            };
            req.onerror = () => {
              clearTimeout(timeout);
              console.warn(`Failed to delete ${dbName}:`, req.error);
              resolve();
            };
            req.onblocked = () => {
              clearTimeout(timeout);
              console.warn(`Deletion of ${dbName} blocked - will complete after reload`);
              resolve();
            };
          });
        } catch (e) {
          console.warn(`Error deleting ${dbName}:`, e);
        }
      }

      // Remove the reset parameter and reload
      const newUrl = new URL(window.location.href);
      newUrl.searchParams.delete("reset");

      // Small delay to let any pending deletions propagate
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Replace history state so back button doesn't trigger reset again
      window.history.replaceState({}, "", newUrl.toString());
      window.location.reload();
    };

    performReset();
  }, []);

  // Show a simple overlay during reset to prevent any other interactions
  if (isResetting) {
    return (
      <div className="fixed inset-0 z-[9999] bg-background flex items-center justify-center">
        <div className="text-center space-y-4">
          <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-lg font-medium">Resetting database...</p>
          <p className="text-sm text-muted-foreground">This will only take a moment</p>
        </div>
      </div>
    );
  }

  return null;
}
