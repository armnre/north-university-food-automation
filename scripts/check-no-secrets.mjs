#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * اسکن مخزن برای اطمینان از عدم وجود کلید خصوصی، توکن، فایل .env واقعی،
 * آدرس‌های داخلی شبکه یا وابستگی‌های باقی‌ماندهٔ بیرونی در فرانت‌اند.
 */

const root = process.cwd();

function listRepoFiles() {
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
  return Array.from(new Set([...tracked, ...untracked]));
}

const FORBIDDEN_PATH_PATTERNS = [
  { re: /(^|\/)\.env(\..+)?$/, allow: /(^|\/)\.env\.example$/, reason: 'فایل .env واقعی نباید در مخزن باشد' },
  { re: /\.(pem|key|p12|pfx|age)$/i, reason: 'فایل کلید خصوصی/گواهی نباید در مخزن باشد' },
  { re: /(^|\/)secrets\.env$/i, reason: 'فایل secrets.env نباید در مخزن باشد' },
];

const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.xlsx']);

const CONTENT_PATTERNS = [
  { re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/, reason: 'کلید خصوصی PEM شناسایی شد' },
  { re: /\bghp_[A-Za-z0-9]{30,}\b/, reason: 'توکن شخصی GitHub (ghp_) شناسایی شد' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/, reason: 'توکن GitHub PAT شناسایی شد' },
  { re: /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/, reason: 'کلید API سرویس پرداخت شناسایی شد' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, reason: 'کلید AWS شناسایی شد' },
  {
    re: /\beyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/,
    reason: 'توکن JWT هاردکدشده شناسایی شد',
  },
  {
    re: /(?<![\d.])(?:192\.168\.\d{1,3}\.\d{1,3}|10\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})(?![\d.])/,
    reason: 'آدرس IP خصوصی شبکهٔ داخلی شناسایی شد',
    skipFiles: new Set(['scripts/check-no-secrets.mjs', 'package-lock.json']),
    skipPathRe: /(^|\/)test\//,
  },
];

const FRONTEND_EXTERNAL_PATTERNS = [
  { re: /images\.fillout\.com/i, reason: 'لینک تصویر خارجی (fillout) در فرانت‌اند مجاز نیست' },
  { re: /fonts\.googleapis\.com|fonts\.gstatic\.com/i, reason: 'فونت خارجی Google Fonts در فرانت‌اند مجاز نیست' },
];

const findings = [];
const files = listRepoFiles();

for (const relPath of files) {
  for (const rule of FORBIDDEN_PATH_PATTERNS) {
    if (rule.re.test(relPath) && !(rule.allow && rule.allow.test(relPath))) {
      findings.push(`${relPath}: ${rule.reason}`);
    }
  }

  const ext = relPath.slice(relPath.lastIndexOf('.')).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) continue;

  const abs = resolve(root, relPath);
  if (!existsSync(abs)) continue;
  const st = statSync(abs);
  if (!st.isFile() || st.size > 2 * 1024 * 1024) continue;

  const content = readFileSync(abs, 'utf8');

  for (const rule of CONTENT_PATTERNS) {
    if (rule.skipFiles?.has(relPath)) continue;
    if (rule.skipPathRe?.test(relPath)) continue;
    if (rule.re.test(content)) {
      findings.push(`${relPath}: ${rule.reason}`);
    }
  }

  if (relPath.startsWith('apps/web/src/') || relPath === 'apps/web/index.html') {
    for (const rule of FRONTEND_EXTERNAL_PATTERNS) {
      if (rule.re.test(content)) {
        findings.push(`${relPath}: ${rule.reason}`);
      }
    }
  }
}

if (findings.length > 0) {
  console.error('خطای امنیتی — موارد غیرمجاز در مخزن یافت شد:');
  for (const f of findings) console.error(` - ${f}`);
  process.exit(1);
}

console.info(`[secrets:check] بررسی ${files.length} فایل با موفقیت انجام شد؛ هیچ راز، کلید خصوصی یا لینک غیرمجازی یافت نشد.`);
