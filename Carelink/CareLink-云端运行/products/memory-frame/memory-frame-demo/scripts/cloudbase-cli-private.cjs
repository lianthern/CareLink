'use strict';
// Private request bodies enter after process creation, never in the OS argv.
// The parent captures all CLI output in private files.
const fs = require('node:fs');
const [cli, ...args] = process.argv.slice(2);
try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  process.argv = [process.execPath, cli, ...args];
  if (input.body !== undefined) process.argv.push('--body', JSON.stringify(input.body));
  require(cli);
} catch {
  process.stderr.write('Private CloudBase invocation failed.\n');
  process.exitCode = 1;
}
