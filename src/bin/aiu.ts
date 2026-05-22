#!/usr/bin/env node

import { runAiuCli } from "../cli.js";

process.exitCode = await runAiuCli(process.argv.slice(2));
