#!/usr/bin/env node

import { run } from "../src/cli.js";

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nError: ${message}`);
  process.exitCode = 1;
});
