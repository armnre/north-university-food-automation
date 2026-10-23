#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * اسکن مخزن برای اطمینان از عدم وجود:
 *  - کلید خصوصی، توکن، فایل .env واقعی یا فایل کلید رمزنگاری
 *  - هرگونه آدرس IPv4 عمومی یا خصوصی واقعی (به‌جز 127.0.0.1، 0.0.0.0 و رنج‌های مستندات RFC 5737)
 *  - نام دامنه‌های واقعی سرور/دانشگاه (مانند *.ir / *.ac.ir یا هر URL خارج از فهرست مجاز)
 *  - وابستگی‌های خارجی غیرمجاز در فرانت‌اند (Google Fonts / تصاویر بیرونی)
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

const SKIP_IP_AND_HOST_SCAN = new Set(['scripts/check-no-secrets.mjs', 'package-lock.json']);

/** تنها IPv4های مجاز در کد و مستندات: loopback، bind-all و رنج‌های مستند RFC 5737. */
function isAllowedIpv4(ip) {
  if (ip === '127.0.0.1' || ip === '0.0.0.0') return true;
  if (ip.startsWith('192.0.2.')) return true; // TEST-NET-1 (RFC 5737)
  if (ip.startsWith('198.51.100.')) return true; // TEST-NET-2 (RFC 5737)
  if (ip.startsWith('203.0.113.')) return true; // TEST-NET-3 (RFC 5737)
  return false;
}

/** تنها دامنه‌های مجاز در URLها و نمونه‌های پیکربندی. */
const ALLOWED_EXACT_HOSTS = new Set([
  '127.0.0.1',
  '0.0.0.0',
  'localhost',
  '[::1]',
  'example.com',
  'example.org',
  'example.edu',
  'example.net',
  'api.zarinpal.com',
  'www.zarinpal.com',
  'sandbox.zarinpal.com',
  'api.kavenegar.com',
  'nodejs.org',
  'deb.nodesource.com',
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'registry.npmjs.org',
  'ui.shadcn.com',
  'json.schemastore.org',
  'www.w3.org',
]);

function isAllowedHost(rawHost) {
  const host = rawHost.toLowerCase().replace(/\.$/, '');
  if (!host || !host.includes('.') || host.includes('${') || host.includes('<') || host.includes('>')) return true;
  if (ALLOWED_EXACT_HOSTS.has(host)) return true;
  if (
    host.endsWith('.example') ||
    host.endsWith('.example.com') ||
    host.endsWith('.example.org') ||
    host.endsWith('.example.edu') ||
    host.endsWith('.example.net') ||
    host.endsWith('.localhost') ||
    host.endsWith('.invalid') ||
    host.endsWith('.test')
  ) {
    return true;
  }
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) {
    return isAllowedIpv4(host);
  }
  return false;
}

const CONTENT_PATTERNS = [
  { re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/, reason: 'کلید خصوصی PEM شناسایی شد' },
  { re: /\bAGE-SECRET-KEY-1[A-Z0-9]{50,}\b/, reason: 'کلید خصوصی age (AGE-SECRET-KEY) شناسایی شد' },
  { re: /\bghp_[A-Za-z0-9]{30,}\b/, reason: 'توکن شخصی GitHub (ghp_) شناسایی شد' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/, reason: 'توکن GitHub PAT شناسایی شد' },
  { re: /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/, reason: 'کلید API سرویس پرداخت شناسایی شد' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, reason: 'کلید AWS شناسایی شد' },
  {
    re: /\beyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/,
    reason: 'توکن JWT هاردکدشده شناسایی شد',
  },
];

const IPV4_CANDIDATE_RE = /(?<![\d./])((?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})(?![\d.])/g;
const REAL_IR_DOMAIN_RE = /\b(?:[a-zA-Z0-9-]+\.)+(?:ac\.ir|ir)\b/g;
const URL_HOST_RE = /\b(?:https?|postgres(?:ql)?):\/\/(?:[^/\s:@]+@)?([a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\])(?::\d+|\b)/g;

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
    if (rule.re.test(content)) {
      findings.push(`${relPath}: ${rule.reason}`);
    }
  }

  if (!SKIP_IP_AND_HOST_SCAN.has(relPath)) {
    const disallowedIps = new Set();
    for (const match of content.matchAll(IPV4_CANDIDATE_RE)) {
      const ip = match[1];
      if (!isAllowedIpv4(ip)) disallowedIps.add(ip);
    }
    for (const ip of disallowedIps) {
      findings.push(`${relPath}: آدرس IPv4 غیرمجاز شناسایی شد (${ip}) — از 127.0.0.1، <SERVER_IP> یا رنج مستند RFC 5737 استفاده کنید`);
    }

    const disallowedDomains = new Set();
    for (const match of content.matchAll(REAL_IR_DOMAIN_RE)) {
      disallowedDomains.add(match[0]);
    }
    for (const match of content.matchAll(URL_HOST_RE)) {
      const host = match[1];
      if (!isAllowedHost(host)) disallowedDomains.add(host);
    }
    for (const host of disallowedDomains) {
      findings.push(`${relPath}: دامنه/hostname واقعی غیرمجاز شناسایی شد (${host}) — از <YOUR_DOMAIN> یا *.example.edu استفاده کنید`);
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

console.info(
  `[secrets:check] بررسی ${files.length} فایل با موفقیت انجام شد؛ هیچ راز، کلید خصوصی، IP عمومی یا دامنهٔ واقعی غیرمجازی یافت نشد.`,
);
