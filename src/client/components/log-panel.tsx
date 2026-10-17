import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

export function LogPanel({ title, output, status, command, docked = false, children }: {
  title: string; output: string; status?: string; command?: string[]; docked?: boolean; children?: ReactNode;
}) {
  const logs = useRef<HTMLPreElement>(null);
  const [follow, setFollow] = useState(true);
  useLayoutEffect(() => {
    if (follow && logs.current) logs.current.scrollTop = logs.current.scrollHeight;
  }, [output, follow]);
  return <section aria-label={title} className={docked ? "fixed inset-x-0 bottom-0 z-30 flex h-(--download-height) flex-col border-t border-line bg-bg shadow-[0_-8px_24px_#0004]" : "mt-6 overflow-hidden rounded-lg border border-line"}>
    <div className="flex shrink-0 flex-wrap items-center gap-4 border-b border-line bg-panel px-4 py-2.5">
      <h2 className="font-semibold">{title}</h2>
      <span className="text-xs text-muted wrap-anywhere" role="status">{status}</span>
      {children}
      <label className="ml-auto flex-row items-center"><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} /> Follow</label>
    </div>
    {!!command?.length && <p className="border-b border-line px-4 py-2.5 font-mono text-xs text-muted wrap-anywhere">{command.join(" ")}</p>}
    <pre ref={logs} tabIndex={0} aria-label={`${title} output`} onScroll={event => {
      const node = event.currentTarget;
      setFollow(node.scrollHeight - node.scrollTop - node.clientHeight < 24);
    }} className={`m-0 overflow-auto p-4 font-mono text-[13px] leading-relaxed whitespace-pre-wrap wrap-anywhere ${docked ? "min-h-0 flex-1" : "h-[max(300px,53vh)]"}`}>{output}</pre>
    {docked && <p className="note px-4 pb-2">Percentages are for the current file, not the whole model. Cancellation retains completed files and partial downloads; retry without --force to resume.</p>}
  </section>;
}
