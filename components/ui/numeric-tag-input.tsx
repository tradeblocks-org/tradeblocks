"use client";

/**
 * Numeric Tag Input
 *
 * A tag/chip-based input for entering multiple numeric values.
 * Each value appears as a badge that can be removed individually.
 */

import { useState, useRef, KeyboardEvent } from "react";
import { X, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@tradeblocks/lib";

interface NumericTagInputProps {
  value: number[];
  onChange: (values: number[]) => void;
  placeholder?: string;
  className?: string;
  min?: number;
  max?: number;
}

export function NumericTagInput({
  value,
  onChange,
  placeholder = "Add value...",
  className,
  min,
  max,
}: NumericTagInputProps) {
  const [inputValue, setInputValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const addValue = () => {
    const trimmed = inputValue.trim();
    if (!trimmed) return;

    const num = parseFloat(trimmed);
    if (isNaN(num)) {
      setError("Enter a valid number");
      return;
    }

    if (min !== undefined && num < min) {
      setError(`Value must be at least ${min}`);
      return;
    }

    if (max !== undefined && num > max) {
      setError(`Value must be at most ${max}`);
      return;
    }

    // Check for duplicates
    if (value.includes(num)) {
      setError("Value already exists");
      return;
    }

    // Add and sort
    const newValues = [...value, num].sort((a, b) => a - b);
    onChange(newValues);
    setInputValue("");
    setError(null);
  };

  const removeValue = (index: number) => {
    const newValues = value.filter((_, i) => i !== index);
    onChange(newValues);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addValue();
    } else if (e.key === "Backspace" && inputValue === "" && value.length > 0) {
      // Remove last tag when backspace on empty input
      removeValue(value.length - 1);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
    setError(null);
  };

  return (
    <div className={cn("space-y-2", className)}>
      {/* Tags display */}
      <div
        className="flex flex-wrap gap-1.5 min-h-[32px] p-1.5 rounded-md border bg-background cursor-text"
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((num, index) => (
          <Badge
            key={`${num}-${index}`}
            variant="secondary"
            className="h-6 pl-2 pr-1 gap-1 font-mono text-xs"
          >
            {num}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                removeValue(index);
              }}
              className="ml-0.5 rounded-full hover:bg-muted-foreground/20 p-0.5"
              aria-label={`Remove ${num}`}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}

        {/* Inline input */}
        <div className="flex items-center gap-1 flex-1 min-w-[80px]">
          <Input
            ref={inputRef}
            type="number"
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={value.length === 0 ? placeholder : ""}
            className="h-6 min-w-[60px] border-0 shadow-none focus-visible:ring-0 p-0 text-xs [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          />
          {inputValue && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-5 w-5 shrink-0"
              onClick={addValue}
            >
              <Plus className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>

      {/* Error message or hint */}
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Type a number and press Enter to add. Press Backspace to remove.
        </p>
      )}
    </div>
  );
}

export default NumericTagInput;
