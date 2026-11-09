import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const prose =
  "flex flex-col gap-2 text-sm [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2 [&_code]:text-xs [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5";

const cell = "border border-border px-2 py-1 text-left align-top";

// Wide tables scroll inside their own wrapper and images never exceed the container, so the
// rendered content cannot widen the page. Raw HTML stays disabled (react-markdown default).
const components: Components = {
  table: ({ node: _node, ...props }) => (
    <div className="overflow-x-auto">
      <table {...props} className="border-collapse text-sm" />
    </div>
  ),
  th: ({ node: _node, ...props }) => <th {...props} className={`${cell} bg-muted font-semibold`} />,
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
