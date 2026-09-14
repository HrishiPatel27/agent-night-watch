#!/usr/bin/env node
import { main } from './cli.js';
import { CliError } from './util.js';

main(process.argv.slice(2)).catch((err: unknown) => {
  if (err instanceof CliError) {
    process.stderr.write(`✗ ${err.message}\n`);
    process.exitCode = err.exitCode;
    return;
  }
  const e = err as Error;
  process.stderr.write(`✗ ${e?.stack ?? String(err)}\n`);
  process.exitCode = 1;
});
