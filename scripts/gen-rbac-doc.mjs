import { writeFileSync, readFileSync } from 'node:fs';
import { renderRbacMarkdown } from '../packages/shared/dist/index.js';
const out = new URL('../docs/RBAC.md', import.meta.url);
const md = renderRbacMarkdown();
if (process.argv.includes('--check')) {
  if (readFileSync(out, 'utf8') !== md) { console.error('docs/RBAC.md is out of date — run npm run docs:rbac'); process.exit(1); }
  console.log('docs/RBAC.md is up to date');
} else { writeFileSync(out, md); console.log('docs/RBAC.md written'); }
