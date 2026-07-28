import { Fragment, type ReactNode } from "react";

type MarkdownBlock =
  | { kind: "code"; language: string; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "quote"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "paragraph"; text: string };

export function SafeMarkdown({ children }: { children: string }) {
  const blocks = parseBlocks(children);
  if (blocks.length === 0) return null;
  return (
    <div className="safe-markdown">
      {blocks.map((block, index) => renderBlock(block, index))}
    </div>
  );
}

function renderBlock(block: MarkdownBlock, key: number) {
  if (block.kind === "code") {
    return (
      <pre key={key} data-language={block.language || undefined}>
        <code>{block.text}</code>
      </pre>
    );
  }
  if (block.kind === "heading") {
    const className = `markdown-heading markdown-heading-${Math.min(block.level, 3)}`;
    return <p className={className} key={key}>{inline(block.text)}</p>;
  }
  if (block.kind === "quote") return <blockquote key={key}>{inline(block.text)}</blockquote>;
  if (block.kind === "list") {
    const List = block.ordered ? "ol" : "ul";
    return <List key={key}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{inline(item)}</li>)}</List>;
  }
  return <p key={key}>{inline(block.text)}</p>;
}

function parseBlocks(markdown: string): MarkdownBlock[] {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = line.match(/^```([\w.+-]*)\s*$/);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ kind: "code", language: fence[1], text: code.join("\n") });
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      index += 1;
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      blocks.push({ kind: "quote", text: quote[1] });
      index += 1;
      continue;
    }
    const list = line.match(/^(\s*)([-*+]|\d+\.)\s+(.+)$/);
    if (list) {
      const ordered = /\d+\./.test(list[2]);
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].match(/^(\s*)([-*+]|\d+\.)\s+(.+)$/);
        if (!item || /\d+\./.test(item[2]) !== ordered) break;
        items.push(item[3]);
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
  }
  return blocks;
}

function isBlockStart(line: string) {
  return /^```|^#{1,6}\s|^>\s?|^(\s*)([-*+]|\d+\.)\s+/.test(line);
}

function inline(value: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^\s)\n]+\))/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) parts.push(value.slice(cursor, start));
    const token = match[0];
    if (token.startsWith("`")) {
      parts.push(<code key={start}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      parts.push(<strong key={start}>{token.slice(2, -2)}</strong>);
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const href = link?.[2] ?? "";
      parts.push(isSafeHref(href)
        ? <a href={href} key={start} rel="noreferrer noopener">{link?.[1]}</a>
        : <Fragment key={start}>{link?.[1] ?? token}</Fragment>);
    }
    cursor = start + token.length;
  }
  if (cursor < value.length) parts.push(value.slice(cursor));
  return parts;
}

function isSafeHref(value: string) {
  return /^(https?:|mailto:|\/(?!\/)|#)/i.test(value);
}
