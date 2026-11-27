import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const prose =
  "flex flex-col gap-2.5 text-sm leading-relaxed [&_h1]:mt-2 [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:tracking-tight [&_h2]:mt-2 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:tracking-tight [&_h3]:font-semibold [&_a]:text-primary-text [&_a]:underline [&_a]:underline-offset-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border-strong [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_hr]:border-border [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-border-light [&_pre]:bg-surface-secondary/70 [&_pre]:p-3 [&_code]:font-mono [&_code]:text-xs [&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-surface-secondary [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:marker:text-text-muted";

const cell = "border border-border px-3 py-1.5 text-left align-top";

// Wide tables scroll inside their own wrapper and images never exceed the container, so the
// rendered content cannot widen the page. Raw HTML stays disabled (react-markdown default).
const components: Components = {
  table: ({ node: _node, ...props }) => (
    <div className="overflow-x-auto">
      <table {...props} className="border-collapse text-sm tabular-nums" />
    </div>
  ),
  th: ({ node: _node, ...props }) => (
    <th {...props} className={`${cell} bg-surface-secondary font-semibold`} />
  ),
  td: ({ node: _node, ...props }) => <td {...props} className={cell} />,
  img: ({ node: _node, ...props }) => (
    <img {...props} className="h-auto max-w-full" alt={props.alt ?? ""} />
  ),
};

/** Markdown (GFM) with the UI's prose style (evidence, a task's Result). */
export function MarkdownText({ children }: { children: string }) {
  return (
    <div className={prose}>
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </Markdown>
    </div>
  );
}
