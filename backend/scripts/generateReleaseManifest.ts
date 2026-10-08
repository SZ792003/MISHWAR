import fs from 'node:fs';
import path from 'node:path';

const packageJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')) as { version: string; name: string };

const manifest = {
  service: packageJson.name,
  version: process.env.RELEASE_VERSION || packageJson.version,
  buildNumber: process.env.RELEASE_BUILD_NUMBER || null,
  commit: process.env.RELEASE_COMMIT || process.env.GITHUB_SHA || null,
  environment: process.env.APP_MODE || process.env.APP_ENV || 'development',
  generatedAt: new Date().toISOString(),
  notes: 'Generated release manifest contains no secrets.'
};

const outDir = path.resolve(process.cwd(), 'dist');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Release manifest generated for ${manifest.service} ${manifest.version}`);
