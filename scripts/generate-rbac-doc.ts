import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';
import { renderRbacMarkdown } from '../packages/shared/src/rbac-doc.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const targetPath = resolve(scriptDir, '../docs/RBAC.md');

const config = (await prettier.resolveConfig(targetPath)) ?? {};
const formatted = await prettier.format(renderRbacMarkdown(), { ...config, filepath: targetPath });
writeFileSync(targetPath, formatted, 'utf8');
console.info(`[docs:rbac] فایل ${targetPath} با موفقیت از روی packages/shared/src/permissions.ts بازتولید شد.`);
