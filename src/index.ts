#!/usr/bin/env node

import { runPortalCli } from './cli-entry.ts'

runPortalCli()
  .then((exitCode) => {
    process.exitCode = exitCode
  })
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
