import fs from 'node:fs';
import path from 'node:path';

const distRoot = path.resolve(process.cwd(), 'dist-build');
fs.mkdirSync(distRoot, { recursive: true });
fs.writeFileSync(path.join(distRoot, 'package.json'), `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`);

console.log('Production build metadata prepared');
