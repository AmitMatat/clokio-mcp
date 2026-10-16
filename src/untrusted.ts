/**
 * The untrusted-content wrapper, shared by the ticket renderers and the
 * attachment renderer (a ticket attachment's text, PDF text and ZIP entry
 * names are customer content too). Lives on its own so attachments.ts and
 * tools/tickets.ts can both import it without an import cycle.
 */

export const UNTRUSTED_OPEN = '<untrusted_customer_content>';
export const UNTRUSTED_CLOSE = '</untrusted_customer_content>';

/**
 * Defuse any attempt to write a wrapper tag (any case, any inner spacing, open
 * or close) by escaping its "<". With no "<" left in front of the tag name, no
 * real wrapper tag can be formed, so the text cannot end the block early or
 * fake a second one.
 */
export function defuse(text: string): string {
  return text.replace(/<(\s*\/?\s*untrusted_customer_content)/gi, '&lt;$1');
}

/** Customer text is DATA: wrapped as a block, with a wrapper tag inside it defused. */
export function wrapUntrusted(text: string): string {
  return `${UNTRUSTED_OPEN}\n${defuse(text)}\n${UNTRUSTED_CLOSE}`;
}

/** The same wrapper for a short value inside a line (a name, a subject, a label). Newlines collapse to spaces. */
export function wrapInline(text: string): string {
  return `${UNTRUSTED_OPEN}${defuse(text.replace(/\s+/g, ' ').trim())}${UNTRUSTED_CLOSE}`;
}
