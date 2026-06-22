"use client";

/**
 * Metrics Guide Dialog
 *
 * A help dialog that explains all available metrics in the Report Builder,
 * including descriptions and formulas.
 */

import { HelpCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  REPORT_FIELDS,
  FIELD_CATEGORY_LABELS,
  FIELD_CATEGORY_ORDER,
  FieldCategory,
} from "@tradeblocks/lib";

/**
 * Group fields by category for display
 */
function getFieldsGroupedByCategory() {
  const grouped = new Map<FieldCategory, typeof REPORT_FIELDS>();

  // Initialize in the correct order
  for (const category of FIELD_CATEGORY_ORDER) {
    grouped.set(category, []);
  }

  // Add fields to their categories
  for (const field of REPORT_FIELDS) {
    grouped.get(field.category)?.push(field);
  }

  return grouped;
}

export function MetricsGuideDialog() {
  const fieldsByCategory = getFieldsGroupedByCategory();

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <HelpCircle className="h-4 w-4" />
          Metrics Guide
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Metrics Guide</DialogTitle>
          <DialogDescription>
            Reference for all available metrics in the Report Builder
          </DialogDescription>
        </DialogHeader>

        <div className="overflow-y-auto flex-1 pr-2 -mr-2">
          <div className="space-y-6">
            {Array.from(fieldsByCategory.entries()).map(([category, fields]) => {
              if (fields.length === 0) return null;

              return (
                <div key={category}>
                  <h3 className="text-sm font-semibold text-primary mb-3 sticky top-0 bg-background py-1">
                    {FIELD_CATEGORY_LABELS[category]}
                  </h3>
                  <div className="space-y-3">
                    {fields.map((field) => (
                      <div key={field.field} className="rounded-lg border bg-muted/30 p-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="font-medium text-sm">
                            {field.label}
                            {field.unit && (
                              <span className="text-muted-foreground ml-1">({field.unit})</span>
                            )}
                          </div>
                        </div>
                        {field.description && (
                          <p className="text-sm text-muted-foreground mt-1">{field.description}</p>
                        )}
                        {field.formula && (
                          <div className="mt-2 text-xs font-mono bg-muted px-2 py-1 rounded inline-block">
                            {field.formula}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default MetricsGuideDialog;
