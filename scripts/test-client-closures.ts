/** Vitest adapter for the pinned platform's browser-only plugin factories. */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import ts from 'typescript'
import type { Plugin } from 'vite'

const resolvePackage = createRequire(import.meta.url)
const clientImports = new Map<string, Promise<string>>()

async function clientImport(specifier: string): Promise<string> {
  if (!specifier.startsWith('@deepseek-ai/')) return specifier
  let cached = clientImports.get(specifier)
  if (cached !== undefined) return cached
  cached = (async () => {
    // ModuleLoader identifies a plugin by package; ESM names its browser face explicitly.
    if (specifier.split('/').length !== 2) return specifier
    const manifest: { dsh?: { client?: object }; exports?: Record<string, unknown> } = JSON.parse(
      await readFile(resolvePackage.resolve(`${specifier}/package.json`), 'utf8'))
    return manifest.dsh?.client !== undefined && manifest.exports?.['./client'] !== undefined
      ? `${specifier}/client` : specifier
  })()
  clientImports.set(specifier, cached)
  return cached
}

/**
 * Expose a published browser factory to Vitest as ESM without changing its body.
 * @param code - Fixed platform artifact text.
 * @param filename - Artifact location used for parser errors and relative imports.
 * @returns Test-only ESM text, or undefined for ordinary ESM artifacts.
 */
export async function unwrapClientFactory(code: string, filename: string): Promise<string | undefined> {
  if (!code.trimStart().startsWith('window.__ModuleLoader__.load(')) return undefined
  const source = ts.createSourceFile(filename, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const first = source.statements[0]
  if (first === undefined || !ts.isExpressionStatement(first) || !ts.isCallExpression(first.expression)) {
    throw new TypeError(`Unsupported browser factory: ${filename}`)
  }
  const descriptor = first.expression.arguments[0]
  if (descriptor === undefined || !ts.isObjectLiteralExpression(descriptor)) throw new TypeError(`Missing factory descriptor: ${filename}`)
  const property = descriptor.properties.find(item => ts.isPropertyAssignment(item) && item.name.getText(source) === 'factory')
  if (property === undefined || !ts.isPropertyAssignment(property) || !ts.isArrowFunction(property.initializer)
    || !ts.isBlock(property.initializer.body)) throw new TypeError(`Missing browser factory: ${filename}`)
  const factory = property.initializer
  const required = new Set<string>()
  const exported = new Set<string>()
  function scan(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      const argument = node.arguments[0]
      if (argument === undefined || !ts.isStringLiteral(argument)) throw new TypeError(`Dynamic factory dependency: ${filename}`)
      required.add(argument.text)
    }
    ts.forEachChild(node, scan)
  }
  scan(factory.body)
  for (const statement of factory.body.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) continue
    const expression = statement.expression
    if (expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(expression.left)
      && ts.isIdentifier(expression.left.expression) && expression.left.expression.text === 'exports') exported.add(expression.left.name.text)
  }
  if (exported.size === 0) throw new TypeError(`Missing named browser exports: ${filename}`)
  const imports: string[] = []
  const lookup: string[] = []
  let index = 0
  for (const specifier of required) {
    const variable = `__factory_dependency_${index++}`
    imports.push(`import * as ${variable} from ${JSON.stringify(await clientImport(specifier))};`)
    lookup.push(`${JSON.stringify(specifier)}: ${variable}`)
  }
  const declarations = [...exported].map((name, position) => `const __factory_export_${position} = __factory_exports[${JSON.stringify(name)}];\nexport { __factory_export_${position} as ${name} };`)
  return `${imports.join('\n')}\nconst __factory_dependencies = { ${lookup.join(', ')} };\nconst __factory_exports = (${factory.getText(source)})((specifier) => {\n  if (!(specifier in __factory_dependencies)) throw new Error('Unmapped factory dependency: ' + specifier);\n  return __factory_dependencies[specifier];\n});\n${declarations.join('\n')}\n`
}

/**
 * Transform only published platform browser factories during feature tests.
 * @returns A Vite plugin; production browser artifacts retain ModuleLoader.
 */
export function platformClientFactories(): Plugin {
  return {
    name: 'codexy-platform-test-factories',
    enforce: 'pre',
    async load(id) {
      if (!id.includes('/node_modules/@deepseek-ai/') || !id.endsWith('.js')) return undefined
      // Published packages omit .map files. Tests execute the shipped JavaScript.
      const code = await readFile(id, 'utf8')
      return code.replace(/^\/\/# sourceMappingURL=.*(?:\r?\n|$)/gm, '')
    },
    async transform(code, id) {
      if (!id.includes('/node_modules/') || !id.endsWith('.js')) return undefined
      const transformed = await unwrapClientFactory(code, id)
      return transformed === undefined ? undefined : { code: transformed, map: null }
    },
  }
}
