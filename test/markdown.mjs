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

// A double quote inside a link URL must not escape the href attribute: with
// raw quotes, a spaceless payload produced a live onmouseover attribute
// (browsers recover from `href="x"onmouseover="y"` as two attributes).
check('a quote in a URL cannot inject an attribute',
  markdownToHtml('[x](https://e.com/"onmouseover="alert(1))'),
  '<p><a href="https://e.com/&quot;onmouseover=&quot;alert(1">x</a>)</p>');
check('quotes in prose are escaped', markdownToHtml('say "hi"'), '<p>say &quot;hi&quot;</p>');

// Images (task #5296): a /tasks/media/ url from clokio_upload_task_media and
// https urls embed; any other scheme or path stays escaped text.
check('media-proxy image embeds',
  markdownToHtml('The design:\n![login screen](/tasks/media/tasks/org-1/42/media/a.png)'),
  '<p>The design:<br><img src="/tasks/media/tasks/org-1/42/media/a.png" alt="login screen"></p>');
check('https image embeds', markdownToHtml('![x](https://x.io/a.png)'), '<p><img src="https://x.io/a.png" alt="x"></p>');
check('non-media relative path stays text', markdownToHtml('![x](/etc/passwd)'), '<p>![x](/etc/passwd)</p>');
check('image before link is not eaten by the link rule',
  markdownToHtml('![a](https://x.io/a.png) and [b](https://x.io/b)'),
  '<p><img src="https://x.io/a.png" alt="a"> and <a href="https://x.io/b">b</a></p>');

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
