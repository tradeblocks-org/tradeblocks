import { IconSparkles } from "@tabler/icons-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface PlaceholderItem {
  title: string;
  description: string;
}

interface PagePlaceholderProps {
  title: string;
  description: string;
  badge?: string;
  items?: PlaceholderItem[];
  actionLabel?: string;
  onActionClick?: () => void;
}

export function PagePlaceholder({
  title,
  description,
  badge = "In progress",
  items,
  actionLabel,
  onActionClick,
}: PagePlaceholderProps) {
  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-3xl border border-border/50 bg-card/80 p-6 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[0.65rem]">
                {badge}
              </Badge>
              <span className="flex items-center gap-1 text-muted-foreground">
                <IconSparkles className="size-3.5" />
                Preview
              </span>
            </div>
            <h1 className="text-xl font-semibold leading-tight sm:text-2xl">{title}</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
          </div>
          {actionLabel ? (
            <Button onClick={onActionClick} size="sm" className="self-start">
              {actionLabel}
            </Button>
          ) : null}
        </div>
      </section>
      {items && items.length ? (
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <div
              key={item.title}
              className="rounded-2xl border border-border/50 bg-background/70 p-4 shadow-xs"
            >
              <h3 className="text-base font-semibold text-foreground">{item.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{item.description}</p>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}
