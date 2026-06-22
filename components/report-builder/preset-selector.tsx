"use client";

/**
 * Preset Selector
 *
 * Dropdown for selecting pre-defined report presets.
 */

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ReportPreset, RegimeFilterConfig } from "@tradeblocks/lib";

interface PresetSelectorProps {
  presets: ReportPreset[];
  activeFilter: RegimeFilterConfig | null;
  onSelect: (presetId: string) => void;
}

export function PresetSelector({ presets, activeFilter, onSelect }: PresetSelectorProps) {
  // Determine current preset if any matches the active filter
  const currentPresetId =
    presets.find((p) => {
      if (!activeFilter) return p.filter.criteria.length === 0;

      // Simple match: same number of criteria and same regime IDs
      if (p.filter.criteria.length !== activeFilter.criteria.length) return false;

      return p.filter.criteria.every((pc) =>
        activeFilter.criteria.some(
          (ac) =>
            ac.regimeId === pc.regimeId &&
            ac.selectedBucketIds.length === pc.selectedBucketIds.length &&
            ac.selectedBucketIds.every((id) => pc.selectedBucketIds.includes(id)),
        ),
      );
    })?.id ?? "custom";

  return (
    <Select value={currentPresetId} onValueChange={onSelect}>
      <SelectTrigger className="w-[250px]">
        <SelectValue placeholder="Select a report preset" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="custom" disabled={currentPresetId !== "custom"}>
          Custom Filter
        </SelectItem>
        {presets.map((preset) => (
          <SelectItem key={preset.id} value={preset.id}>
            <div className="flex flex-col">
              <span>{preset.name}</span>
              {preset.description && (
                <span className="text-xs text-muted-foreground">{preset.description}</span>
              )}
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export default PresetSelector;
