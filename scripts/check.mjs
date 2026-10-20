import { node } from './run.mjs'
node('scripts/generate-remote.mjs')
node('scripts/typecheck.mjs')
node('scripts/test.mjs')
node('scripts/build.mjs')
