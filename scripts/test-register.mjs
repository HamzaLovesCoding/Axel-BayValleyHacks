// Run app regression tests with Node, using the TypeScript compiler already in devDependencies.
import { registerHooks } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve as pathResolve } from "node:path";
import ts from "typescript";
const root = pathToFileURL(`${process.cwd()}/`).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/server") return next("next/server.js", context);
    if (specifier.startsWith("@/")) specifier = pathToFileURL(pathResolve(specifier.slice(2))).href;
    try { return next(specifier, context); }
    catch (error) {
      if (!specifier.startsWith(".") && !specifier.startsWith("file:")) throw error;
      const base = new URL(specifier, context.parentURL ?? root);
      for (const extension of [".ts", ".tsx", ".js"]) {
        if (existsSync(fileURLToPath(base) + extension)) return next(base.href + extension, context);
      }
      throw error;
    }
  },
  load(url, context, next) {
    if (url.startsWith(root) && !url.includes("/node_modules/") && /\.tsx?$/.test(url)) {
      const { outputText } = ts.transpileModule(readFileSync(new URL(url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.ReactJSX },
        fileName: fileURLToPath(url),
      });
      return { format: "module", source: outputText, shortCircuit: true };
    }
    return next(url, context);
  },
});
