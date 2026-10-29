#!/usr/bin/env node
import { main } from "./main.js";

const code = await main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write("fatal: " + (error as Error).message + "\n");
  if (process.env.REPROPACK_DEBUG) process.stderr.write(String((error as Error).stack) + "\n");
  return 70;
});

process.exitCode = code;
