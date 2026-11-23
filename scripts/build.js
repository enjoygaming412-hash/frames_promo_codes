import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const problems = [];

// 1. Server modules must parse. Modules with side effects (the HTTP entrypoint)
//    are syntax-checked only, so the build never starts a server or creates a database.
const importedModules = ['server/app.js', 'server/store.js', 'server/time.js', 'server/auth.js', 'server/ratelimit.js'];
const syntaxOnlyModules = ['server/index.js'];

for (const file of importedModules) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) {
    problems.push(`missing ${file}`);
    continue;
  }
  try {
    await import(full);
  } catch (error) {
    problems.push(`${file} failed to load: ${error.message}`);
  }
}

for (const file of syntaxOnlyModules) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) {
    problems.push(`missing ${file}`);
    continue;
  }
  try {
    execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' });
  } catch (error) {
    problems.push(`${file} has a syntax error: ${error.stderr?.toString() || error.message}`);
  }
}

// 2. Browser scripts must be valid JavaScript.
for (const file of ['public/app.js', 'public/admin.js']) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) {
    problems.push(`missing ${file}`);
    continue;
  }
  try {
    execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' });
  } catch (error) {
    problems.push(`${file} has a syntax error: ${error.stderr?.toString() || error.message}`);
  }
}

// 3. Required pages and the site title.
const requiredPages = ['public/index.html', 'public/admin.html', 'public/styles.css', 'public/404.html'];
for (const page of requiredPages) {
  if (!fs.existsSync(path.join(root, page))) problems.push(`missing ${page}`);
}
const indexHtml = fs.existsSync(path.join(root, 'public/index.html'))
  ? fs.readFileSync(path.join(root, 'public/index.html'), 'utf8')
  : '';
if (!indexHtml.includes('FRAMES BASEMENT REWARDS')) problems.push('index.html is missing the site title');
if (!indexHtml.includes('CLAIM REWARD')) problems.push('index.html is missing the CLAIM REWARD button');

// 4. No real secret material may ship to the browser.
//    Naming an environment variable in admin-facing help text is fine; a hash,
//    a stored credential or server environment access is not.
const secretMarkers = [
  { needle: 'scrypt$', label: 'a password hash' },
  { needle: 'admin_password_hash', label: 'the stored admin password hash' },
  { needle: 'process.env', label: 'server environment access' },
  { needle: 'SESSION_COOKIE', label: 'the server session cookie name constant' },
];
for (const file of fs.readdirSync(path.join(root, 'public'))) {
  const full = path.join(root, 'public', file);
  if (!fs.statSync(full).isFile()) continue;
  const content = fs.readFileSync(full, 'utf8');
  for (const marker of secretMarkers) {
    if (content.includes(marker.needle)) {
      problems.push(`${file} leaks ${marker.label} (${marker.needle})`);
    }
  }
}

if (problems.length > 0) {
  console.error('Build checks failed:');
  for (const problem of problems) console.error(` - ${problem}`);
  process.exit(1);
}

console.log('Build checks passed: server modules load, browser scripts parse, pages present, no secrets in public assets.');
