/**
 * Markdown → HTML for the text an agent writes INTO Clokio.
 *
 * Clokio stores task descriptions and comments as sanitized HTML (the web
 * editor is TipTap). A model naturally writes Markdown, and the first task
 * created through this server from Claude arrived as one flat paragraph with
 * literal `**` and backticks. Converting here keeps every tool's input
 * natural for the model and correct for Clokio.
 *
 * Deliberately small: paragraphs, line breaks, headings, bullet and numbered
 * lists, fenced code, blockquotes, bold, italic, inline code and links. Text
 * that already starts with an HTML tag is passed through untouched, so a
 * caller that sends HTML keeps working. Everything else is escaped, so a
 * stray `<b>` in prose shows as text rather than becoming markup.
 */

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(text: string): string {
  // Protect inline code first so its contents are never styled or linked.
  const codes: string[] = [];
  let s = text.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = escapeHtml(s);
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]);
}

export function looksLikeHtml(text: string): boolean {
  return /^\s*<(p|div|ul|ol|li|h[1-6]|strong|em|b|i|u|s|br|pre|code|blockquote|a|img|span|table)\b[^>]*>/i.test(text);
}

export function markdownToHtml(input: string | null | undefined): string {
  if (input == null) return '';
  const text = String(input);
  if (!text.trim()) return '';
  if (looksLikeHtml(text)) return text;

  const out: string[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let para: string[] = [];
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null;
  let quote: string[] = [];

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote><p>${quote.map(inline).join('<br>')}</p></blockquote>`);
    quote = [];
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^```/.test(trimmed)) {
      flushAll();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) code.push(lines[i++]);
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (!trimmed) {
      flushAll();
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushAll();
      out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    const quoted = /^>\s?(.*)$/.exec(trimmed);
    if (quoted) {
      flushPara();
      flushList();
      quote.push(quoted[1]);
      continue;
    }
    const bullet = /^[-*+]\s+(.+)$/.exec(trimmed);
    const numbered = /^\d+[.)]\s+(.+)$/.exec(trimmed);
    if (bullet || numbered) {
      flushPara();
      flushQuote();
      const tag = bullet ? 'ul' : 'ol';
      if (!list || list.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push((bullet ?? numbered)![1]);
      continue;
    }
    flushList();
    flushQuote();
    para.push(trimmed);
  }
  flushAll();
  return out.join('');
}
