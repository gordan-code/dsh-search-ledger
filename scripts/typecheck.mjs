import { node } from './run.mjs'
node('node_modules/typescript/bin/tsc', '-p', 'tsconfig.host.json', '--noEmit')
node('node_modules/typescript/bin/tsc', '-p', 'tsconfig.client.json', '--noEmit')
