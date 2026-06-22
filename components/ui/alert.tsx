import * as React from "react";

import { cn } from "@tradeblocks/lib";

const alertVariants = {
  default: "bg-muted/40 text-foreground",
  destructive: "border-destructive/50 text-destructive dark:border-destructive",
};

type AlertProps = React.HTMLAttributes<HTMLDivElement> & {
  variant?: keyof typeof alertVariants;
};

const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ className, variant = "default", ...props }, ref) => (
    <div
      ref={ref}
      role="alert"
      className={cn(
        "border-border/60 text-sm [&>svg]:text-muted-foreground relative w-full rounded-xl border p-4 shadow-sm",
        alertVariants[variant],
        className,
      )}
      {...props}
    />
  ),
);
Alert.displayName = "Alert";

const AlertTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h5 ref={ref} className={cn("font-semibold tracking-tight", className)} {...props} />
  ),
);
AlertTitle.displayName = "AlertTitle";

const AlertDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
));
AlertDescription.displayName = "AlertDescription";

export { Alert, AlertTitle, AlertDescription };
