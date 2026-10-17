import type { ReactNode } from "react";

export function Header({ page, children }: { page: "Server" | "Models"; children?: ReactNode }) {
  return <header className="flex flex-wrap items-center gap-5 border-b border-line px-4 py-4 sm:px-7">
    <h1 className="text-lg font-semibold">FastFlowLM <span className="ml-2 text-sm font-normal text-muted">{page === "Server" ? "NPU server" : "Model catalog"}</span></h1>
    <nav aria-label="Dashboard" className="flex gap-4">
      {(["Server", "Models"] as const).map(name => <a key={name} href={name === "Server" ? "/" : "/models"} aria-current={page === name ? "page" : undefined} className={page === name ? "underline underline-offset-4" : "text-muted no-underline"}>{name}</a>)}
    </nav>
    {children}
  </header>;
}
