/** Compile standard decorators before the test runner parses decorated services. */
import ts from 'typescript'

export function standardDecorators() {
  return { name: 'codexy-standard-decorators', enforce: 'pre' as const,
    transform(code: string, id: string) {
      const file = id.split('?')[0]
      if (file === undefined || !/\.[cm]?tsx?$/.test(file) || !/^\s*@[A-Za-z_$][\w$]*/m.test(code)) return
      const result = ts.transpileModule(code, { fileName: file, compilerOptions: {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.ReactJSX, sourceMap: true,
      } })
      return { code: result.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'), map: result.sourceMapText }
    },
  }
}
