/** Common copy fixtures read the fixed published platform artifact. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'
import type { CommonKey } from '@deepseek-ai/dsh-client-locale/client'

const require = createRequire(import.meta.url)
const filename = require.resolve('@deepseek-ai/dsh-client-locale/client')
const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)

function dictionary(language: 'en' | 'zh'): Record<CommonKey, string> {
  let entries: Record<string, string> | undefined
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && new RegExp(`^${language}(?:\\$\\d+)?$`).test(node.name.text)
      && node.initializer !== undefined && ts.isObjectLiteralExpression(node.initializer)) {
      const fields: Record<string, string> = {}
      for (const field of node.initializer.properties) {
        if (!ts.isPropertyAssignment(field) || (!ts.isStringLiteral(field.name) && !ts.isIdentifier(field.name))
          || !ts.isStringLiteral(field.initializer)) throw new TypeError(`Unsupported ${language} common dictionary`)
        fields[field.name.text] = field.initializer.text
      }
      if ('copy' in fields && 'codeBlock.title' in fields) entries = fields
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (entries === undefined) throw new TypeError(`Missing ${language} common copy in fixed platform artifact`)
  return entries as Record<CommonKey, string>
}

/** Published English common dictionary used in isolated component tests. */
export const commonEn = dictionary('en')
/** Published Chinese common dictionary used in isolated component tests. */
export const commonZh = dictionary('zh')
