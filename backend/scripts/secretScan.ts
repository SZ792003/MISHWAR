import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(process.cwd(), '..');
const ignoredDirs = new Set(['.git', '.codex', 'node_modules', 'build', 'dist', 'dist-build', '.dart_tool', '.gradle', 'ios/Pods']);
const ignoredFiles = new Set(['package-lock.json', 'pubspec.lock']);
const maxFileBytes = 1024 * 1024;

const suspiciousFileNames = [
  'serviceAccountKey.json',
  'service-account.json',
  'google-services.json',
  'GoogleService-Info.plist',
  'key.properties',
  '.env.production',
  '.env.prod',
  'AuthKey_'
];

const contentPatterns: Array<{ name: string; regex: RegExp }> = [
  { name: 'private key', regex: /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/ },
  { name: 'firebase service account', regex: /"type"\s*:\s*"service_account"/ },
  { name: 'hardcoded API secret', regex: /(api|client|webhook|payment|firebase|apple)[_-]?(secret|key)\s*[:=]\s*["'][A-Za-z0-9_\-+/=]{24,}["']/i },
  { name: 'keystore password', regex: /(storePassword|keyPassword)\s*=\s*["'][^"']{8,}["']/i }
];

const findings: string[] = [];

const shouldIgnoreDir = (fullPath: string, name: string): boolean => {
  if (ignoredDirs.has(name)) return true;
  const normalized = fullPath.replace(/\\/g, '/');
  return normalized.includes('/ios/Pods/') || normalized.includes('/android/.gradle/');
};

const scanFile = (fullPath: string): void => {
  const relativePath = path.relative(repoRoot, fullPath).replace(/\\/g, '/');
  const baseName = path.basename(fullPath);
  if (ignoredFiles.has(baseName)) return;
  if (relativePath.startsWith('docs/') || baseName.endsWith('.example') || baseName === '.env.example') return;
  if (suspiciousFileNames.some((name) => baseName === name || baseName.startsWith(name))) {
    findings.push(`${relativePath}: suspicious secret-bearing filename`);
  }
  const stat = fs.statSync(fullPath);
  if (stat.size > maxFileBytes) return;
  const ext = path.extname(fullPath).toLowerCase();
  const readable = ['.ts', '.js', '.json', '.yaml', '.yml', '.env', '.properties', '.plist', '.md', '.txt', '.xml', '.gradle', '.kts', '.dart'].includes(ext) || baseName.startsWith('.env');
  if (!readable) return;
  const content = fs.readFileSync(fullPath, 'utf8');
  for (const pattern of contentPatterns) {
    if (pattern.regex.test(content)) findings.push(`${relativePath}: ${pattern.name}`);
  }
};

const walk = (dir: string): void => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!shouldIgnoreDir(fullPath, entry.name)) walk(fullPath);
      continue;
    }
    if (entry.isFile()) scanFile(fullPath);
  }
};

walk(repoRoot);

if (findings.length > 0) {
  console.error('Secret scan failed. Review these paths without printing secret values:');
  findings.forEach((finding) => console.error(`- ${finding}`));
  process.exit(1);
}

console.log('Secret scan passed');
