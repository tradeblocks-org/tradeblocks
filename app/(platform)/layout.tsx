import type { CSSProperties, ReactNode } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";

const providerStyle = {
  "--sidebar-width": "min(22rem, calc(100vw - 4rem))",
  "--header-height": "4.5rem",
} as CSSProperties;

export default function PlatformLayout({ children }: { children: ReactNode }) {
  return (
    <SidebarProvider style={providerStyle}>
      <AppSidebar variant="inset" />
      <SidebarInset>
        <SiteHeader />
        <div className="flex flex-1 flex-col bg-gradient-to-b from-background via-background to-muted/20">
          <main className="flex-1">
            <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-4 sm:p-6 lg:p-8">
              {children}
            </div>
          </main>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
