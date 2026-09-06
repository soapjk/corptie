import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdir, realpath } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const app = await realpath(resolve(process.argv[2]));
assert.equal(process.execPath, join(app, 'Contents/Helpers/node'));
const backend = join(app, 'Contents/Resources/backend');
const require = createRequire(join(backend, 'package.json'));
const db = new DatabaseSync(':memory:');
assert.equal(db.prepare('SELECT 42 AS answer').get().answer, 42);
db.close();
const native = require('./native/corptie_native.node');
assert.equal(typeof native.inspectTreeOpenat, 'function');
assert.equal(typeof native.safeDeleteTreeOpenat, 'function');

// Actually allocate a PTY: importing node-pty alone can miss helper/ABI failures.
const pty = require('node-pty').spawn('/bin/echo', ['corptie-pty-ok'], {
  cwd: '/tmp', env: { PATH: '/usr/bin:/bin', TERM: 'xterm' },
});
await new Promise((accept, reject) => {
  let output = '';
  const timer = setTimeout(() => { pty.kill(); reject(new Error('PTY timeout')); }, 5000);
  pty.onData(data => { output += data; });
  pty.onExit(({ exitCode }) => {
    clearTimeout(timer);
    try { assert.equal(exitCode, 0); assert.match(output, /corptie-pty-ok/); accept(); }
    catch (error) { reject(error); }
  });
});

async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await realpath(path);
      assert.ok(target.startsWith(app + sep), `External symlink: ${path}`);
    } else if (entry.isDirectory()) {
      await inspect(path);
    } else if (entry.isFile()) {
      const type = execFileSync('/usr/bin/file', ['-b', path], { encoding: 'utf8' });
      if (!type.includes('Mach-O')) continue;
      execFileSync('/usr/bin/codesign', ['--verify', '--strict', path]);
      const commands = execFileSync('/usr/bin/otool', ['-l', path], { encoding: 'utf8' });
      for (const match of commands.matchAll(/cmd LC_RPATH\n\s*cmdsize \d+\n\s*path (.+) \(offset \d+\)/g)) {
        const rpath = match[1];
        assert.ok(rpath.startsWith('/usr/lib/') || rpath.startsWith('/System/Library/')
          || rpath === '@loader_path' || rpath.startsWith('@loader_path/')
          || rpath === '@executable_path' || rpath.startsWith('@executable_path/'),
        `External runtime search path: ${path}: ${rpath}`);
      }
      const libraries = execFileSync('/usr/bin/otool', ['-L', path], { encoding: 'utf8' });
      for (const line of libraries.split('\n').slice(1)) {
        const dependency = line.trim().split(' (')[0];
        if (!dependency) continue;
        assert.ok(dependency.startsWith('/usr/lib/') || dependency.startsWith('/System/Library/')
          || dependency.startsWith('@'), `External library dependency: ${path}: ${dependency}`);
      }
    }
  }
}
await inspect(app);
console.log(`Bundled runtime passed: ${process.version}; sqlite, native safety module, PTY, signatures, library paths and symlinks`);
