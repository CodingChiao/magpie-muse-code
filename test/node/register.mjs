// node --import ./test/node/register.mjs index.test.mjs: `bun:test` resolves to bun-test.mjs.
import { register } from "node:module"

const shim = new URL("./bun-test.mjs", import.meta.url).href

register(
  "data:text/javascript," +
    encodeURIComponent(`
      export async function resolve(specifier, context, next) {
        if (specifier === "bun:test") return { url: ${JSON.stringify(shim)}, shortCircuit: true }
        return next(specifier, context)
      }
    `),
)
