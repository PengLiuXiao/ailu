import esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const production = process.argv.includes('production');
const watch = process.argv.includes('--watch');
const distributionLegalFiles = [
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  ...(await fs.readdir('LICENSES'))
    .filter(file => file.endsWith('.txt'))
    .sort()
    .map(file => path.posix.join('LICENSES', file)),
];
const distributionLegalText = (await Promise.all(distributionLegalFiles.map(async (file) => {
  const contents = (await fs.readFile(file, 'utf8')).trimEnd().replaceAll('*/', '* /');
  return `===== BEGIN ${file} =====\n${contents}\n===== END ${file} =====`;
}))).join('\n\n');

const rawTextPlugin = {
  name: 'raw-text',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, args => ({
      path: path.resolve(args.resolveDir, args.path.slice(0, -4)),
      namespace: 'raw-text',
    }));
    build.onLoad({ filter: /.*/, namespace: 'raw-text' }, async args => ({
      contents: await fs.readFile(args.path, 'utf8'),
      loader: 'text',
    }));
  },
};

const context = await esbuild.context({
  banner: {
    js: `/*! Ailu for Obsidian distribution licenses\n${distributionLegalText}\n*/`,
  },
  bundle: true,
  entryPoints: ['src/main.ts'],
  external: [
    'obsidian',
    'electron',
    '@codemirror/autocomplete',
    '@codemirror/collab',
    '@codemirror/commands',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/view',
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/lr'
  ],
  format: 'cjs',
  logLevel: 'info',
  loader: {
    '.png': 'dataurl',
  },
  minify: production,
  outfile: 'main.js',
  platform: 'node',
  plugins: [rawTextPlugin],
  sourcemap: production ? false : 'inline',
  target: 'es2022',
});

if (watch) {
  await context.watch();
  process.stdout.write('Watching Ailu sources...\n');
} else {
  await context.rebuild();
  await context.dispose();
}
