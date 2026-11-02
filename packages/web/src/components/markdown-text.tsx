import Markdown from "react-markdown";

const prose =
  "flex flex-col gap-2 text-sm [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2 [&_code]:text-xs [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5";

/** Markdown with the UI's prose style (evidence, a task's Result). */
export function MarkdownText({ children }: { children: string }) {
  return (
    <div className={prose}>
      <Markdown>{children}</Markdown>
    </div>
  );
}
