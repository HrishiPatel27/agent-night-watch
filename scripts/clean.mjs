// Removes build output from every package. Cross-platform (no rm -rf).
import { rmSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const packagesDir = join(root, 'packages');
for (const name of readdirSync(packagesDir)) {
  for (const target of ['dist', 'tsconfig.tsbuildinfo']) {
    const p = join(packagesDir, name, target);
    if (existsSync(p)) {
      rmSync(p, { recursive: true, force: true });
      console.log('removed', p);
    }
  }
}
