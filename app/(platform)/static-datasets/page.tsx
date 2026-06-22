"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Plus, Search, Database, Info } from "lucide-react";
import { useStaticDatasetsStore, useBlockStore } from "@tradeblocks/lib/stores";
import { DatasetCard } from "@/components/static-datasets/dataset-card";
import { UploadDialog } from "@/components/static-datasets/upload-dialog";
import { PreviewModal } from "@/components/static-datasets/preview-modal";
import type { StaticDataset, Trade } from "@tradeblocks/lib";
import { getTradesByBlock } from "@tradeblocks/lib";

export default function StaticDatasetsPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [isUploadDialogOpen, setIsUploadDialogOpen] = useState(false);
  const [previewDataset, setPreviewDataset] = useState<StaticDataset | null>(null);
  const [activeBlockTrades, setActiveBlockTrades] = useState<Trade[]>([]);

  const datasets = useStaticDatasetsStore((state) => state.datasets);
  const isInitialized = useStaticDatasetsStore((state) => state.isInitialized);
  const loadDatasets = useStaticDatasetsStore((state) => state.loadDatasets);
  const invalidateMatchStatsForBlock = useStaticDatasetsStore(
    (state) => state.invalidateMatchStatsForBlock,
  );

  const activeBlockId = useBlockStore((state) => state.activeBlockId);
  const blocks = useBlockStore((state) => state.blocks);
  const activeBlock = blocks.find((b) => b.id === activeBlockId);

  // Load datasets on mount
  useEffect(() => {
    if (!isInitialized) {
      loadDatasets();
    }
  }, [isInitialized, loadDatasets]);

  // Load active block trades for match stats
  // Re-fetch when trade count changes (after import/recalculation)
  const activeBlockTradeCount = activeBlock?.tradeLog.rowCount;
  useEffect(() => {
    if (!activeBlockId) {
      setActiveBlockTrades([]);
      return;
    }

    // Invalidate cached match stats for this block since trades may have changed
    invalidateMatchStatsForBlock(activeBlockId);

    const loadTrades = async () => {
      try {
        const trades = await getTradesByBlock(activeBlockId);
        setActiveBlockTrades(trades);
      } catch (err) {
        console.error("Failed to load trades for match stats:", err);
        setActiveBlockTrades([]);
      }
    };

    loadTrades();
  }, [activeBlockId, activeBlockTradeCount, invalidateMatchStatsForBlock]);

  // Filter datasets based on search query
  const filteredDatasets = searchQuery.trim()
    ? datasets.filter(
        (d) =>
          d.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          d.fileName.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : datasets;

  const handlePreview = (dataset: StaticDataset) => {
    setPreviewDataset(dataset);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground w-4 h-4" />
          <Input
            placeholder="Search datasets..."
            className="pl-10"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <Button onClick={() => setIsUploadDialogOpen(true)}>
          <Plus className="w-4 h-4 mr-2" />
          Upload Dataset
        </Button>
      </div>

      {/* Active Block Info */}
      {activeBlock ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 rounded-lg px-4 py-2">
          <Info className="w-4 h-4" />
          <span>
            Preview matching against active block: <strong>{activeBlock.name}</strong> (
            {activeBlock.tradeLog.rowCount} trades)
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/20 rounded-lg px-4 py-2">
          <Info className="w-4 h-4" />
          <span>No active block selected. Activate a block to preview dataset matching.</span>
        </div>
      )}

      {/* Datasets Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Static Datasets</h2>
          <span className="text-sm text-muted-foreground">
            {!isInitialized
              ? "Loading..."
              : searchQuery.trim()
                ? `${filteredDatasets.length} of ${datasets.length} datasets`
                : `${datasets.length} datasets`}
          </span>
        </div>

        {/* Loading State */}
        {!isInitialized && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[1, 2, 3].map((i) => (
              <Card key={i} className="animate-pulse">
                <CardContent className="p-6">
                  <div className="space-y-3">
                    <div className="h-4 bg-muted rounded w-3/4"></div>
                    <div className="h-3 bg-muted rounded w-1/2"></div>
                    <div className="flex gap-2">
                      <div className="h-5 bg-muted rounded w-20"></div>
                      <div className="h-5 bg-muted rounded w-24"></div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Search Empty State */}
        {isInitialized && filteredDatasets.length === 0 && searchQuery.trim() && (
          <div className="text-center py-12">
            <Search className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">No datasets found</h3>
            <p className="text-muted-foreground mb-4">
              No datasets match &quot;{searchQuery}&quot;
            </p>
            <Button variant="outline" onClick={() => setSearchQuery("")}>
              Clear Search
            </Button>
          </div>
        )}

        {/* Empty State */}
        {isInitialized && datasets.length === 0 && (
          <div className="text-center py-12 max-w-md mx-auto">
            <Database className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">No static datasets yet</h3>
            <p className="text-muted-foreground mb-6">
              Upload CSV files with time-series data. Dataset columns will be available as fields in
              the Report Builder, matched to trades by timestamp.
            </p>
            <Button onClick={() => setIsUploadDialogOpen(true)}>
              <Plus className="w-4 h-4 mr-2" />
              Upload First Dataset
            </Button>
          </div>
        )}

        {/* Dataset Grid */}
        {isInitialized && filteredDatasets.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredDatasets.map((dataset) => (
              <DatasetCard
                key={dataset.id}
                dataset={dataset}
                onPreview={handlePreview}
                trades={activeBlockTrades}
                blockId={activeBlockId ?? undefined}
              />
            ))}
          </div>
        )}
      </div>

      {/* Upload Dialog */}
      <UploadDialog open={isUploadDialogOpen} onOpenChange={setIsUploadDialogOpen} />

      {/* Preview Modal */}
      <PreviewModal
        open={!!previewDataset}
        onOpenChange={(open) => !open && setPreviewDataset(null)}
        dataset={previewDataset}
      />
    </div>
  );
}
