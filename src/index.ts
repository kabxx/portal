#!/usr/bin/env node

import { run } from './app.ts'

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
