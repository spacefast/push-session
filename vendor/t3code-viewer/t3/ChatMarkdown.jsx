// Directly vendored from T3 Code's apps/web/src/components/ChatMarkdown.tsx and
// apps/web/src/components/chat/MarkdownTable.tsx. App-only editor, preview,
// state, math, and highlighter integrations are intentionally outside this static
// viewer boundary. The rendering component and plugin model remain T3 Code's;
// see ../LICENSE and ../NOTICE.md.
import { Children, isValidElement, useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

const CHAT_MARKDOWN_SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    "*": (defaultSchema.attributes?.["*"] ?? []).filter((attribute) => attribute !== "title"),
    code: [...(defaultSchema.attributes?.code ?? []), "dataCodeMeta"],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "file"],
  },
};

const FENCE_TITLE_ATTR_REGEX = /(?:^|\s)(?:title|file(?:name)?)=(?:"([^"]+)"|'([^']+)'|(\S+))/i;
const FENCE_FILENAME_TOKEN_REGEX = /^[\w@][\w@./-]*\.[A-Za-z0-9]+$/;

function extractFenceTitle(meta) {
  if (!meta) return null;
  const match = FENCE_TITLE_ATTR_REGEX.exec(meta);
  const title = match?.[1] ?? match?.[2] ?? match?.[3];
  if (title) return title;
  return meta.split(/\s+/).find((candidate) => FENCE_FILENAME_TOKEN_REGEX.test(candidate)) ?? null;
}

function remarkPreserveCodeMeta() {
  return (tree) => {
    const visit = (node) => {
      if (node.type === "code" && typeof node.meta === "string" && node.meta.trim()) {
        node.data = {
          ...node.data,
          hProperties: { ...node.data?.hProperties, dataCodeMeta: node.meta.trim() },
        };
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

function nodeToPlainText(node) {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeToPlainText).join("");
  if (isValidElement(node)) return nodeToPlainText(node.props.children);
  return "";
}

function extractPreCodeMeta(node) {
  const codeNode = node?.children?.find((child) => child?.type === "element" && child.tagName === "code");
  const meta = codeNode?.properties?.dataCodeMeta ?? codeNode?.data?.meta;
  return typeof meta === "string" && meta.trim() ? meta.trim() : undefined;
}

function CopyCodeButton({ text, label = "Copy code" }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="copy-button small"
      type="button"
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      onClick={() => Promise.resolve(typeof text === "function" ? text() : text).then((value) => navigator.clipboard.writeText(value)).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_000);
      })}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

function serializeTableToMarkdown(table) {
  const rows = [...table.rows].map((row) => [...row.cells].map((cell) => cell.textContent.trim().replace(/\|/g, "\\|").replace(/\s+/g, " ")));
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const line = (cells) => `| ${Array.from({ length: width }, (_, index) => cells[index] ?? "").join(" | ")} |`;
  return [line(rows[0]), line(Array.from({ length: width }, () => "---")), ...rows.slice(1).map(line)].join("\n");
}

// MarkdownTable: the table fits its lane, wide content scrolls inside a
// container, and a copy action sits under it.
function MarkdownTable({ children, node: _node, ...props }) {
  const containerRef = useRef(null);
  return (
    <div ref={containerRef} className="chat-markdown-table-container">
      <div className="chat-markdown-table-scroll"><table {...props}>{children}</table></div>
      <div className="chat-markdown-table-actions">
        <CopyCodeButton label="Copy table" text={() => serializeTableToMarkdown(containerRef.current?.querySelector("table") ?? { rows: [] })} />
      </div>
    </div>
  );
}

export default function ChatMarkdown({ text, lineBreaks = false, className = "" }) {
  const remarkPlugins = lineBreaks
    ? [remarkGfm, remarkBreaks, remarkPreserveCodeMeta]
    : [remarkGfm, remarkPreserveCodeMeta];
  return (
    <div className={`chat-markdown ${className}`.trim()}>
      <ReactMarkdown
        urlTransform={defaultUrlTransform}
        remarkPlugins={remarkPlugins}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, CHAT_MARKDOWN_SANITIZE_SCHEMA]]}
        components={{
          a: ({ href, children, ...props }) => (
            <a {...props} href={href} target="_blank" rel="noreferrer">{children}</a>
          ),
          table: MarkdownTable,
          pre: ({ children, node }) => {
            const code = Children.toArray(children).map(nodeToPlainText).join("");
            const title = extractFenceTitle(extractPreCodeMeta(node));
            return (
              <div className="code-shell">
                {title ? <div className="code-title">{title}</div> : null}
                <pre>{children}</pre>
                <CopyCodeButton text={code} />
              </div>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
