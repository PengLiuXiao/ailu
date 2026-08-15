import { build } from 'esbuild';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const requestedOutputDir = process.argv[2]?.trim();
if (!requestedOutputDir) {
  throw new Error('Usage: node scripts/build-extracted-theme-previews.mjs <output-directory>');
}
const outputDir = path.resolve(requestedOutputDir);

const themes = [
  { id: 'open-design-archive', file: '01-开放设计档案.html', label: '开放设计档案', accent: '#ED6F5C', background: '#EFE7D2' },
  { id: 'vellum-indigo', file: '02-靛蓝羊皮纸.html', label: '靛蓝羊皮纸', accent: '#3F5EA8', background: '#F4F0E6' },
  { id: 'editorial-tri-tone', file: '03-三色编辑部.html', label: '三色编辑部', accent: '#D78FA6', background: '#F7F1E4' },
  { id: 'pink-script', file: '04-黑粉手写体.html', label: '黑粉手写体', accent: '#C92B70', background: '#F7F0F3' },
  { id: 'playful-peach', file: '05-蜜桃玩字.html', label: '蜜桃玩字', accent: '#1A1A1A', background: '#F0C8A0' },
  { id: 'capsule-color', file: '06-彩色胶囊.html', label: '彩色胶囊', accent: '#A06CE8', background: '#F5F5F0' },
];

const entry = `
import { applyExtractedDesignWechatStyles, isExtractedDesignTemplateId } from './src/wechat/extractedDesignThemes.ts';

const root = document.querySelector('#article');
const themeId = document.body.dataset.theme;
if (!(root instanceof HTMLElement) || !isExtractedDesignTemplateId(themeId)) {
  throw new Error('Invalid preview theme');
}
root.innerHTML = \`
  <h1>把复杂经验，写成一篇真正好读的文章</h1>
  <p>一套好模板不应该只负责“换颜色”。它需要同时管理<strong>标题层级、阅读节奏、重点表达</strong>和长文中的视觉停顿，让内容在手机屏幕上依旧清楚。</p>
  <p>这份样张保留了原始设计最鲜明的语言，并把它转换成适合公众号正文的结构。<em>风格鲜明，但不能妨碍阅读。</em></p>
  <h2>01 · 模板真正解决什么</h2>
  <p>当文章包含多个章节、步骤、引用、代码与数据时，视觉系统必须让读者迅速辨认“现在读到哪里”。因此每个模块都不是装饰，而是导航。</p>
  <blockquote>设计不是最后加上去的外衣，而是内容关系被看见的方式。</blockquote>
  <h3>一套稳定的阅读秩序</h3>
  <ol>
    <li>用标题建立章节层级，避免每一级都在抢注意力。</li>
    <li>用列表承接连续行动，让步骤可以快速扫描。</li>
    <li>用引用和表格制造节奏变化，但不打断正文。</li>
  </ol>
  <h2>02 · 细节如何落到实际内容</h2>
  <p>模板会保留源 Markdown 的原生<strong>加粗</strong>与<code>行内代码</code>，不会自动替作者制造新的重点。围栏代码则使用独立区域：</p>
  <pre><code>const readable = hierarchy + rhythm + contrast;
return readable;</code></pre>
  <h3>不同模块的职责</h3>
  <table>
    <thead><tr><th>模块</th><th>主要作用</th></tr></thead>
    <tbody>
      <tr><td>标题</td><td>建立层级与定位</td></tr>
      <tr><td>引用</td><td>暂停、转折与强调</td></tr>
      <tr><td>表格</td><td>对照重复字段</td></tr>
    </tbody>
  </table>
  <hr>
  <p>最终效果应该是：即使拿掉所有说明文字，读者也能凭版式判断结构；即使文章很长，也不会迷失在连续段落里。</p>
\`;
applyExtractedDesignWechatStyles(root, themeId);
`;

const result = await build({
  stdin: {
    contents: entry,
    resolveDir: projectRoot,
    sourcefile: 'extracted-theme-preview-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['safari15'],
  write: false,
});
const bundle = result.outputFiles[0].text;

function previewDocument(theme) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${theme.label} · Ailu</title>
  <style>
    *{box-sizing:border-box}html,body{margin:0;min-height:100%;background:#e9e4da}
    body{padding:34px 16px 60px;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
    .preview-shell{width:min(100%,520px);margin:0 auto;background:${theme.background};box-shadow:0 24px 70px rgba(38,33,26,.16)}
    .preview-label{width:min(100%,520px);margin:0 auto 12px;color:#514b42;font-size:12px;letter-spacing:.12em;text-align:right;opacity:.78}
  </style>
</head>
<body data-theme="${theme.id}">
  <div class="preview-label">${theme.label} / ${theme.id}</div>
  <main class="preview-shell"><article id="article"></article></main>
  <script>${bundle}</script>
</body>
</html>\n`;
}

function indexDocument() {
  const cards = themes.map((theme, index) => `
    <a class="card" href="./${encodeURIComponent(theme.file)}" style="--accent:${theme.accent};--paper:${theme.background}">
      <span class="number">0${index + 1}</span><span class="swatch"></span>
      <strong>${theme.label}</strong><small>${theme.id}</small>
    </a>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>提取后的六套 HTML 模板</title><style>
  *{box-sizing:border-box}body{margin:0;padding:56px 22px 80px;background:#eee9dc;color:#181713;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}.wrap{max-width:920px;margin:auto}h1{margin:0 0 10px;font-family:Didot,"Songti SC",serif;font-size:46px;font-weight:500}p{margin:0 0 34px;color:#665f52}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.card{display:grid;grid-template-columns:42px 52px 1fr;grid-template-rows:auto auto;gap:2px 14px;align-items:center;padding:20px;background:#f8f4e8;border:1px solid #cfc5ad;color:inherit;text-decoration:none}.card:hover{border-color:var(--accent)}.number{grid-row:1/3;font:12px ui-monospace;color:#81796a}.swatch{grid-row:1/3;width:48px;height:48px;background:var(--paper);border:7px solid var(--accent);border-radius:50%}.card strong{font-size:17px}.card small{color:#7a7264;font:11px ui-monospace}@media(max-width:680px){.grid{grid-template-columns:1fr}h1{font-size:36px}}
  </style></head><body><main class="wrap"><h1>六套独立 HTML 模板</h1><p>从 6 个 Open Design 示例中提取，并适配为公众号长文模板。点击任意模板单独打开。</p><section class="grid">${cards}</section></main></body></html>\n`;
}

await fs.mkdir(outputDir, { recursive: true });
await Promise.all(themes.map(theme => fs.writeFile(
  path.join(outputDir, theme.file),
  previewDocument(theme),
  'utf8',
)));
await fs.writeFile(path.join(outputDir, '模板目录.html'), indexDocument(), 'utf8');
