"use client";

import { useState } from "react";
import {
  endOfMonth,
  endOfYear,
  startOfMonth,
  startOfYear,
  subDays,
  subMonths,
  subYears,
} from "date-fns";
import { DateRange, DropdownNavProps, DropdownProps } from "react-day-picker";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface DateRangePickerProps {
  date: DateRange | undefined;
  onDateChange: (date: DateRange | undefined) => void;
  maxDate?: Date;
}

export function DateRangePicker({ date, onDateChange, maxDate }: DateRangePickerProps) {
  const today = maxDate || new Date();

  const presets = {
    today: {
      from: today,
      to: today,
    },
    yesterday: {
      from: subDays(today, 1),
      to: subDays(today, 1),
    },
    last7Days: {
      from: subDays(today, 6),
      to: today,
    },
    last30Days: {
      from: subDays(today, 29),
      to: today,
    },
    monthToDate: {
      from: startOfMonth(today),
      to: today,
    },
    lastMonth: {
      from: startOfMonth(subMonths(today, 1)),
      to: endOfMonth(subMonths(today, 1)),
    },
    last3Months: {
      from: subMonths(today, 3),
      to: today,
    },
    last6Months: {
      from: subMonths(today, 6),
      to: today,
    },
    yearToDate: {
      from: startOfYear(today),
      to: today,
    },
    lastYear: {
      from: startOfYear(subYears(today, 1)),
      to: endOfYear(subYears(today, 1)),
    },
  };

  const [month, setMonth] = useState(date?.to || today);

  const handlePresetClick = (preset: DateRange) => {
    onDateChange(preset);
    if (preset.to) {
      setMonth(preset.to);
    }
  };

  const handleCalendarChange = (
    _value: string | number,
    _e: React.ChangeEventHandler<HTMLSelectElement>,
  ) => {
    const _event = {
      target: {
        value: String(_value),
      },
    } as React.ChangeEvent<HTMLSelectElement>;
    _e(_event);
  };

  return (
    <div className="rounded-md border">
      <div className="flex max-sm:flex-col">
        <div className="relative py-4 max-sm:order-1 max-sm:border-t sm:w-40">
          <div className="h-full sm:border-e">
            <div className="flex flex-col px-2 gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start font-normal"
                onClick={() => handlePresetClick(presets.today)}
              >
                Today
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start font-normal"
                onClick={() => handlePresetClick(presets.yesterday)}
              >
                Yesterday
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start font-normal"
                onClick={() => handlePresetClick(presets.last7Days)}
              >
                Last 7 days
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start font-normal"
                onClick={() => handlePresetClick(presets.last30Days)}
              >
                Last 30 days
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start font-normal"
                onClick={() => handlePresetClick(presets.monthToDate)}
              >
                Month to date
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start font-normal"
                onClick={() => handlePresetClick(presets.lastMonth)}
              >
                Last month
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start font-normal"
                onClick={() => handlePresetClick(presets.last3Months)}
              >
                Last 3 months
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start font-normal"
                onClick={() => handlePresetClick(presets.last6Months)}
              >
                Last 6 months
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start font-normal"
                onClick={() => handlePresetClick(presets.yearToDate)}
              >
                Year to date
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start font-normal"
                onClick={() => handlePresetClick(presets.lastYear)}
              >
                Last year
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start font-normal"
                onClick={() => {
                  onDateChange(undefined);
                  setMonth(today);
                }}
              >
                All time
              </Button>
            </div>
          </div>
        </div>
        <Calendar
          mode="range"
          selected={date}
          onSelect={(newDate) => {
            onDateChange(newDate);
          }}
          month={month}
          onMonthChange={setMonth}
          className="p-2"
          classNames={{
            month_caption: "mx-0",
          }}
          captionLayout="dropdown"
          defaultMonth={today}
          startMonth={new Date(2000, 0)}
          endMonth={today}
          hideNavigation
          disabled={[{ after: today }]}
          components={{
            DropdownNav: (props: DropdownNavProps) => {
              return <div className="flex w-full items-center gap-2">{props.children}</div>;
            },
            Dropdown: (props: DropdownProps) => {
              return (
                <Select
                  value={String(props.value)}
                  onValueChange={(value) => {
                    if (props.onChange) {
                      handleCalendarChange(value, props.onChange);
                    }
                  }}
                >
                  <SelectTrigger className="h-8 w-fit font-medium first:grow">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="max-h-[min(26rem,var(--radix-select-content-available-height))]">
                    {props.options?.map((option) => (
                      <SelectItem
                        key={option.value}
                        value={String(option.value)}
                        disabled={option.disabled}
                      >
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              );
            },
          }}
        />
      </div>
    </div>
  );
}
