import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Tauri permission manifests contain absolute paths. Cargo can reuse these
// build-script outputs after a project folder (including target/) is copied.
export function findStaleTauriCaches(targetDirectory, targets = []) {
  if (!existsSync(targetDirectory)) return [];
  const profiles = [{ target: null, directory: join(targetDirectory, 'release') }];
  for (const entry of readdirSync(targetDirectory, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== 'release' && (!targets.length || targets.includes(entry.name))) {
      profiles.push({ target: entry.name, directory: join(targetDirectory, entry.name, 'release') });
    }
  }

  const stale = [];
  for (const profile of profiles) {
    const buildDirectory = join(profile.directory, 'build');
    if (!existsSync(buildDirectory)) continue;
    const packages = new Set();
    for (const entry of readdirSync(buildDirectory, { withFileTypes: true })) {
      const match = /^(tauri(?:-[a-z0-9_-]+)?)-[a-f0-9]+$/.exec(entry.name);
      if (!entry.isDirectory() || !match) continue;
      const outputDirectory = join(buildDirectory, entry.name);
      const rootOutput = join(outputDirectory, 'root-output');
      if (!existsSync(rootOutput)) continue;
      const recordedPath = readFileSync(rootOutput, 'utf8').trim();
      if (recordedPath && resolve(recordedPath) !== resolve(outputDirectory, 'out')) {
        packages.add(match[1]);
      }
    }
    if (packages.size) stale.push({ target: profile.target, packages: [...packages].sort() });
  }
  return stale;
}

function prepareTauriCache() {
  const nativeDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../src-tauri');
  const metadata = spawnSync('cargo', ['metadata', '--no-deps', '--format-version', '1', '--offline', '--locked'], {
    cwd: nativeDirectory, encoding: 'utf8',
  });
  if (metadata.error) throw metadata.error;
  if (metadata.status !== 0) throw new Error(metadata.stderr || 'Unable to read Cargo metadata');
  const targetDirectory = JSON.parse(metadata.stdout).target_directory;
  const stale = findStaleTauriCaches(targetDirectory, process.argv.slice(2));
  for (const { target, packages } of stale) {
    console.log(`Refreshing relocated Tauri cache (${target || 'host'}): ${packages.join(', ')}`);
    const args = ['clean', '--release', '--offline', '--locked', '--target-dir', targetDirectory];
    if (target) args.push('--target', target);
    for (const name of packages) args.push('--package', name);
    const result = spawnSync('cargo', args, { cwd: nativeDirectory, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Cargo cache cleanup failed (${result.status})`);
  }
  if (!stale.length) console.log('Tauri build cache paths are current.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    prepareTauriCache();
  } catch (error) {
    console.error(`Unable to prepare Tauri build cache: ${error.message}`);
    process.exitCode = 1;
  }
}
