// The part of `bun:test` this package's tests use, for running them on Node
// where Bun isn't installed (npm run test:node). Under Bun the real one is used.
import { inspect, isDeepStrictEqual } from "node:util"

const tests = []
const afters = []
const befores = []
let scheduled = false

function add(name, fn, skip = false) {
  tests.push({ name, fn, skip })
  if (!scheduled) {
    scheduled = true
    setTimeout(run, 0)
  }
}

export function test(name, fn) {
  add(name, fn)
}
test.skip = (name, fn) => add(name, fn, true)
test.skipIf = (cond) => (cond ? test.skip : test)
test.if = (cond) => (cond ? test : test.skip)
export const it = test

export function describe(_name, fn) {
  fn()
}

export function beforeEach(fn) {
  befores.push(fn)
}

export function afterEach(fn) {
  afters.push(fn)
}

// Bun's toEqual takes a property set to undefined for one left out.
function bare(v) {
  if (Array.isArray(v)) return v.map(bare)
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    const o = {}
    for (const [k, x] of Object.entries(v)) if (x !== undefined) o[k] = bare(x)
    return o
  }
  return v
}

const show = (v) => inspect(v, { depth: 6, breakLength: 120 })

export function expect(actual) {
  const matchers = (negate) => {
    const check = (ok, what) => {
      if (negate ? ok : !ok) throw new Error(`expected ${show(actual)} ${negate ? "not " : ""}${what}`)
    }
    return {
      toBe: (e) => check(Object.is(actual, e), `to be ${show(e)}`),
      toEqual: (e) => check(isDeepStrictEqual(bare(actual), bare(e)), `to equal ${show(e)}`),
      toContain: (e) => check((typeof actual === "string" || Array.isArray(actual)) && actual.includes(e), `to contain ${show(e)}`),
      toMatch: (re) => check(typeof actual === "string" && (re instanceof RegExp ? re.test(actual) : actual.includes(re)), `to match ${show(re)}`),
      toHaveLength: (n) => check(actual?.length === n, `to have length ${n}`),
      toBeUndefined: () => check(actual === undefined, "to be undefined"),
      toBeDefined: () => check(actual !== undefined, "to be defined"),
      toBeNull: () => check(actual === null, "to be null"),
      toBeTruthy: () => check(!!actual, "to be truthy"),
      toBeFalsy: () => check(!actual, "to be falsy"),
      toBeGreaterThan: (n) => check(actual > n, `to be greater than ${n}`),
      toBeLessThan: (n) => check(actual < n, `to be less than ${n}`),
    }
  }
  return Object.assign(matchers(false), { not: matchers(true) })
}

async function run() {
  let pass = 0
  let fail = 0
  let skip = 0
  for (const t of tests) {
    if (t.skip) {
      skip++
      console.log(`  skip  ${t.name}`)
      continue
    }
    const start = Date.now()
    try {
      for (const b of befores) await b()
      await t.fn()
      pass++
      console.log(`  pass  ${t.name} (${Date.now() - start}ms)`)
    } catch (e) {
      fail++
      console.log(`  FAIL  ${t.name}\n        ${String(e?.stack ?? e).split("\n").slice(0, 6).join("\n        ")}`)
    } finally {
      for (const a of afters) {
        try {
          await a()
        } catch (e) {
          fail++
          console.log(`  FAIL  afterEach of ${t.name}: ${e?.message ?? e}`)
        }
      }
    }
  }
  console.log(`\n${pass} pass, ${fail} fail${skip ? `, ${skip} skipped` : ""}, ${tests.length} total`)
  process.exitCode = fail ? 1 : 0
}
