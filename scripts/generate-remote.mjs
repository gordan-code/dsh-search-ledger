// 在项目内创建最小分析工作区，使用官方生成器生成外部插件Remote，不改写宿主。
import { mkdirSync, copyFileSync, cpSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { WorkspaceAnalyzer, FaceModelEmitter, writePackageArtifacts } from '@deepseek-ai/dsh-typert-generator'
const root = resolve('.validation/typert'); const target = join(root, 'packages/plugin')
const protocol = join(root, 'packages/protocol')
mkdirSync(target, { recursive: true }); cpSync('src', join(target, 'src'), { recursive: true })
// 生成器用工作区包身份识别装饰器；分析时登记原版发布声明，不改写宿主或伪造协议。
mkdirSync(protocol, { recursive: true })
cpSync('node_modules/@deepseek-ai/dsh-typert-protocol/lib/types', join(protocol, 'src'), { recursive: true })
writeFileSync(join(protocol, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-typert-protocol', type: 'module', exports: { '.': './src/index.d.ts' } }))
writeFileSync(join(protocol, 'tsconfig.host.json'), JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true }, include: ['src/**/*.d.ts'] }))
const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
writeFileSync(join(target, 'package.json'), JSON.stringify(manifest))
for (const name of ['tsconfig.base.json', 'tsconfig.host.json']) copyFileSync(name, join(target, name))
writeFileSync(join(root, 'tsconfig.host.json'), JSON.stringify({ files: [], compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true, strict: true, allowImportingTsExtensions: true, types: ['node'], paths: { '@deepseek-ai/dsh-typert-protocol': [join(protocol, 'src/index.d.ts')] } }, references: [{ path: './packages/plugin/tsconfig.host.json' }, { path: './packages/protocol/tsconfig.host.json' }] }))
const model = new WorkspaceAnalyzer({ root, faces: ['host'], checkDiagnostics: false, packages: [manifest.name] }).analyze()
const artifact = new FaceModelEmitter(model.faces[0]).emit(manifest.name)
if (!artifact.remote) throw new Error('Remote贡献未生成，拒绝打包只有空反射的插件')
writePackageArtifacts(resolve('.'), [{ ...artifact, packageRoot: '.' }])
console.log(`已生成 ${manifest.name} 的严格Host/Remote贡献`)
