// Markdown written by the model must reach Clokio as the HTML its editor
// stores. Before this, a description with **bold** and "- bullets" posted as
// one flat paragraph with the asterisks showing (task #5290, 2026-10-05).
//
// Run by hand:  node test/markdown.mjs   (after npm run build)
import { markdownToHtml } from '../dist/markdown.js';

let fails = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `\n  want: ${JSON.stringify(want)}\n  got:  ${JSON.stringify(got)}`}`);
};

check('paragraphs and line breaks', markdownToHtml('Hello\nworld\n\nSecond'), '<p>Hello<br>world</p><p>Second</p>');
check('bold, code, italic, link',
  markdownToHtml('Test on **stg.shipos.co.il** (branch `duplicate-shipping`) *now* [docs](https://x.io/d)'),
  '<p>Test on <strong>stg.shipos.co.il</strong> (branch <code>duplicate-shipping</code>) <em>now</em> <a href="https://x.io/d">docs</a></p>');
check('numbered then bullet list', markdownToHtml('Steps:\n1. First\n2. Second\n\n- a\n- b\n* c'),
  '<p>Steps:</p><ol><li>First</li><li>Second</li></ol><ul><li>a</li><li>b</li><li>c</li></ul>');
check('heading, fence, quote', markdownToHtml('## Title\n```\nnpm test\n```\n> note'),
  '<h2>Title</h2><pre><code>npm test</code></pre><blockquote><p>note</p></blockquote>');
check('escapes html, keeps @mention text', markdownToHtml('@Anil Pujara please check 2 < 3 & <b>x</b>'),
  '<p>@Anil Pujara please check 2 &lt; 3 &amp; &lt;b&gt;x&lt;/b&gt;</p>');
check('html passes through', markdownToHtml('<p>already <strong>html</strong></p>'), '<p>already <strong>html</strong></p>');
check('empty stays empty', markdownToHtml(''), '');
check('underscores in identifiers are left alone', markdownToHtml('tag shipos_return_exchange on the order'),
  '<p>tag shipos_return_exchange on the order</p>');
check('code protects bold markers', markdownToHtml('run `a**b**c`'), '<p>run <code>a**b**c</code></p>');

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
