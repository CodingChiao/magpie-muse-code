// Unit tests for magpie-muse-code
import { test, expect, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MuseAuthPlugin, _internal } from "./index.mjs"

const {
  PROVIDER,
  NPM,
  BASE,
  DEFAULT_MODELS,
  saveCliCredential,
  replaceFile,
  stateOf,
  packOAuthResult,
  rewrite,
  resetOf,
  reset,
} = _internal

const realFetch = globalThis.fetch
const realMuseAuthPath = process.env.MUSE_AUTH_PATH

let calls = []
let routes = []

// serve answers each fetch with the first route whose part is in the URL, each route once.
function serve(routesIn) {
  routes = [...routesIn]
  calls = []
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, init })
    const idx = routes.findIndex(([part]) => url.includes(part))
    if (idx < 0) throw new Error(`no mocked route for ${url}`)
    const r = routes[idx][1]
    routes.splice(idx, 1)
    if (typeof r === "function") return r(init, url)
    if (r instanceof Response) return r
    return Response.json(r.body ?? {}, { status: r.status ?? 200, headers: r.headers })
  }
}

// serveAll answers every fetch with handler(url, init).
function serveAll(handler) {
  calls = []
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, init })
    return handler(url, init)
  }
}

const count = (part) => calls.filter((c) => c.url.includes(part)).length
const authOf = (call) => new Headers(call.init.headers).get("Authorization")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

afterEach(() => {
  globalThis.fetch = realFetch
  reset()
  if (realMuseAuthPath === undefined) delete process.env.MUSE_AUTH_PATH
  else process.env.MUSE_AUTH_PATH = realMuseAuthPath
})

function makeClient(initial = null) {
  let stored = initial
  const saved = []
  return {
    client: {
      app: { log: async () => {} },
      auth: {
        set: async (input) => {
          saved.push(input.body)
          stored = input.body
        },
      },
      tui: { showToast: async () => {} },
      config: { get: async () => ({ data: {} }) },
    },
    saved,
    getAuth: async () => stored,
    seed: (a) => {
      stored = a
    },
  }
}

const SAMPLE_MINTED_BODY = {
  api_key: "LLM|11334867890|secret",
  base_url: "https://api.meta.ai/v1",
  has_payment_method: false,
  require_payment: false,
  is_subs_active: true,
  can_subscribe: false,
  show_subs_upsell: true,
  user_full_name: "Ada Lovelace",
  user_email: "ada@example.com",
  user_avatar_url: null,
  payment_method: null,
  action_url: null,
  subs_tier_id: "27681393394859588",
  subs_tier_name: "Muse Code Everyday Usage",
  is_subs_upgrade_available: true,
  subs_usage: {
    window: {
      used_percent: 12.5,
      window_duration_mins: 300,
      resets_at: 1792186805,
    },
    weekly: {
      used_percent: 45,
      resets_at: 1792368000,
    },
    tier: "27681393394859588",
  },
}

const minted = (apiKey) => ({ ...SAMPLE_MINTED_BODY, api_key: apiKey })

const SAMPLE_MODELS_BODY = {
  object: "list",
  data: [
    {
      id: "muse-wonder-1.0-contributor",
      object: "model",
      created: 1791662410,
      owned_by: "meta",
      metadata: {
        "muse-code": {
          name: "muse-wonder-1.0-contributor",
          family: "avocado",
          release_date: "2026-10-12",
          is_hidden: false,
          attachment: true,
          reasoning: true,
          temperature: false,
          tool_call: true,
          modalities: { input: ["text", "image"], output: ["text"] },
          limit: { context: 1007997, output: 128000 },
          options: {
            reasoningEffort: "high",
            forceReasoning: true,
            include: ["reasoning.encrypted_content"],
            temperature: 0.9,
            top_p: 0.9,
          },
          variants: {
            minimal: { reasoningEffort: "minimal" },
            low: { reasoningEffort: "low" },
            medium: { reasoningEffort: "medium" },
            high: { reasoningEffort: "high" },
            xhigh: { reasoningEffort: "xhigh" },
            max: { reasoningEffort: "max" },
          },
        },
      },
    },
    {
      id: "muse-image-1.0",
      object: "model",
      metadata: {
        "muse-code": {
          name: "Muse Image",
          is_hidden: true,
          modalities: { input: ["text", "image"], output: ["image"] },
        },
      },
    },
  ],
}

// oauthAuth is a stored OAuth sign-in on key apiKey with access token dca:valid_token.
const oauthAuth = (apiKey = "LLM|11334867890|secret", opts) => ({
  ...packOAuthResult(
    {
      apiKey,
      baseUrl: BASE,
      email: "ada@example.com",
      fullName: "Ada",
      tierName: "Muse Code Everyday Usage",
      subsActive: true,
    },
    "dca:valid_token",
    opts,
  ),
  type: "oauth",
})

function post(loader, body = {}) {
  return loader.fetch(`${BASE}/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "muse-spark-1.3", input: [{ role: "user", content: "hi" }], ...body }),
  })
}

// tempCli writes a Muse Code CLI auth.json (as text when given a string) and points MUSE_AUTH_PATH at it.
function tempCli(meta) {
  const dir = mkdtempSync(join(tmpdir(), "muse-test-"))
  const file = join(dir, "auth.json")
  writeFileSync(file, typeof meta === "string" ? meta : JSON.stringify({ schema_version: 1, providers: { meta } }))
  process.env.MUSE_AUTH_PATH = file
  return { dir, file, done: () => rmSync(dir, { recursive: true, force: true }) }
}

// ---- hooks ------------------------------------------------------------------------

test("exports the OpenCode / magpie hook shapes", async () => {
  const { client } = makeClient()
  const hooks = await MuseAuthPlugin({ client })
  expect(hooks.auth.provider).toBe("muse")
  expect(typeof hooks.auth.loader).toBe("function")
  expect(typeof hooks.auth.usage).toBe("function")
  // Meta's sign-in can't be renewed, so there is no auth.refresh for magpie to schedule
  expect(hooks.auth.refresh).toBeUndefined()
  expect(hooks.auth.methods.length).toBe(3)
  for (const m of hooks.auth.methods) {
    expect(["oauth", "api"]).toContain(m.type)
    if (m.type === "oauth") expect(typeof m.authorize).toBe("function")
  }
  expect(typeof hooks.provider.models).toBe("function")
})

test("config declares muse provider with @ai-sdk/openai and default models", async () => {
  const { client } = makeClient()
  const hooks = await MuseAuthPlugin({ client })
  const cfg = {}
  await hooks.config(cfg)
  const p = cfg.provider[PROVIDER]
  expect(p.npm).toBe(NPM)
  expect(p.api).toBe(BASE)
  expect(p.searches).toBe(true)
  expect(Object.keys(p.models)).toEqual(Object.keys(DEFAULT_MODELS))
  expect(p.models["muse-wonder-1.0"].variants.max).toEqual({ reasoningEffort: "max" })
})

test("chat.headers adds the session id to muse requests only", async () => {
  const { client } = makeClient()
  const hooks = await MuseAuthPlugin({ client })
  const out = { headers: {} }
  await hooks["chat.headers"]({ sessionID: "sess_7", model: { providerID: "muse" } }, out)
  expect(out.headers["x-tbh-session-id"]).toBe("sess_7")
  expect(out.headers["x-meta-ai-gateway-session-id"]).toBe("sess_7")
  const other = { headers: {} }
  await hooks["chat.headers"]({ sessionID: "sess_7", model: { providerID: "openai" } }, other)
  expect(other.headers).toEqual({})
})

// ---- signing in -------------------------------------------------------------------

const DEVICE_START = () =>
  Response.json({
    device_code: "dev_123",
    user_code: "ABCD-EFGH",
    verification_uri: "https://auth.meta.com/device",
    verification_uri_complete: "https://auth.meta.com/device?user_code=ABCD-EFGH",
    expires_in: 300,
    interval: 0.01,
  })

test("device code login polls token and mints api_key at /muse-code/key", async () => {
  const { client } = makeClient()
  const hooks = await MuseAuthPlugin({ client })
  serve([
    ["/oidc/device/authorization/", DEVICE_START],
    ["/oidc/device/token/", () => Response.json({ error: "authorization_pending" }, { status: 400 })],
    ["/oidc/device/token/", () => Response.json({ access_token: "dca:token_abc", expires_in: 3600 })],
    ["/muse-code/key", () => Response.json(SAMPLE_MINTED_BODY)],
  ])

  const method = hooks.auth.methods[0]
  const step = await method.authorize()
  expect(step.url).toBe("https://auth.meta.com/device?user_code=ABCD-EFGH")
  expect(step.instructions).toContain("ABCD-EFGH")
  expect(step.method).toBe("auto")

  const res = await step.callback()
  expect(res.type).toBe("success")
  expect(res.access).toBe("LLM|11334867890|secret")
  expect(res.accountId).toBe("ada@example.com")
  expect(res.expires).toBe(0)
  const extra = JSON.parse(res.refresh)
  expect(extra.accessToken).toBe("dca:token_abc")
  expect(extra.apiKey).toBe("LLM|11334867890|secret")
  expect(extra.tierName).toBe("Muse Code Everyday Usage")
})

test("device code login rides out a dropped poll and a server error", async () => {
  const { client } = makeClient()
  const hooks = await MuseAuthPlugin({ client })
  serve([
    ["/oidc/device/authorization/", DEVICE_START],
    [
      "/oidc/device/token/",
      () => {
        throw new TypeError("fetch failed (ECONNRESET)")
      },
    ],
    ["/oidc/device/token/", () => new Response("upstream down", { status: 503 })],
    ["/oidc/device/token/", () => Response.json({ access_token: "dca:token_abc" })],
    ["/muse-code/key", () => Response.json(SAMPLE_MINTED_BODY)],
  ])
  const step = await hooks.auth.methods[0].authorize()
  const res = await step.callback()
  expect(res.type).toBe("success")
  expect(count("/oidc/device/token/")).toBe(3)
})

test("device code login reports a denied request", async () => {
  const { client } = makeClient()
  const hooks = await MuseAuthPlugin({ client })
  serve([
    ["/oidc/device/authorization/", DEVICE_START],
    ["/oidc/device/token/", () => Response.json({ error: "access_denied" }, { status: 400 })],
  ])
  const step = await hooks.auth.methods[0].authorize()
  const res = await step.callback()
  expect(res).toEqual({ type: "failed", error: "Meta sign-in request was denied" })
})

test("key minting says what Meta wants before it issues a key", async () => {
  const { mintKey } = _internal
  const failure = async () => {
    try {
      await mintKey("dca:t")
    } catch (e) {
      return e
    }
  }
  serveAll(() => Response.json({ code: "MODEL_API__ONBOARDING_REQUIRED", detail: "onboard first" }, { status: 400 }))
  const onboarding = await failure()
  expect(onboarding.message).toContain("https://dev.meta.ai")
  expect(onboarding.signIn).toBe("expired")
  // not a token Meta turned away: signing in again after onboarding asks afresh
  expect(onboarding.refused).toBeUndefined()

  serveAll(() => Response.json({ code: 4705002, detail: "no_payg" }, { status: 402 }))
  const payg = await failure()
  expect(payg.message).toContain("subscription")
  expect(payg.signIn).toBeUndefined()

  serveAll(() => Response.json({ require_payment: true, action_url: "https://accountscenter.meta.com/pay" }))
  expect((await failure()).message).toContain("https://accountscenter.meta.com/pay")

  serveAll(() => new Response('{"detail":"bad token"}', { status: 401 }))
  const refused = await failure()
  expect(refused.signIn).toBe("expired")
  expect(refused.refused).toBe(true)
})

test("CLI sign-in reads ~/.config/muse/auth.json and updates rotated api_key", async () => {
  const cli = tempCli({
    mechanism: "oauth",
    access_token: "dca:cli_token",
    obtained_via: "device_code",
    api_key: "LLM|old_key",
    api_base_url: "https://api.meta.ai/v1",
    subs_active: true,
    user_full_name: "Ada Lovelace",
    user_email: "ada@example.com",
  })
  try {
    const { client } = makeClient()
    const hooks = await MuseAuthPlugin({ client })
    serve([["/muse-code/key", () => Response.json(SAMPLE_MINTED_BODY)]])

    const step = await hooks.auth.methods[1].authorize()
    expect(step.instructions).toContain("ada@example.com")
    const out = await step.callback()
    expect(out.type).toBe("success")
    expect(out.access).toBe("LLM|11334867890|secret")
    expect(JSON.parse(out.refresh).useCli).toBe(true)

    // Verify CLI auth.json was also updated with the freshly minted key
    const updatedDoc = JSON.parse(readFileSync(cli.file, "utf8"))
    expect(updatedDoc.providers.meta.api_key).toBe("LLM|11334867890|secret")
  } finally {
    cli.done()
  }
})

test("CLI sign-in with only an API key saves it as a key", async () => {
  const cli = tempCli({ api_key: "LLM|cli_only", user_email: "ada@example.com" })
  try {
    const { client } = makeClient()
    const hooks = await MuseAuthPlugin({ client })
    const step = await hooks.auth.methods[1].authorize()
    const out = await step.callback()
    expect(out.type).toBe("success")
    expect(out.key).toBe("LLM|cli_only")
    expect(out.metadata.email).toBe("ada@example.com")
  } finally {
    cli.done()
  }
})

test("CLI sign-in says where it looked when the CLI isn't signed in", async () => {
  process.env.MUSE_AUTH_PATH = join(tmpdir(), "muse-test-missing", "auth.json")
  const { client } = makeClient()
  const hooks = await MuseAuthPlugin({ client })
  let err
  try {
    await hooks.auth.methods[1].authorize()
  } catch (e) {
    err = e
  }
  expect(String(err?.message)).toContain("muse-test-missing")
})

test("an account Meta names no one for gets a uid from its key", () => {
  const out = packOAuthResult({ apiKey: "LLM|987654321|secret", baseUrl: BASE }, "dca:t")
  expect(out.accountId).toBe("Muse Code")
  expect(out.uid).toBe("987654321")
  const named = packOAuthResult({ apiKey: "LLM|987654321|secret", baseUrl: BASE, email: "ada@example.com" }, "dca:t")
  expect(named.uid).toBeUndefined()
})

// ---- the CLI's auth.json ------------------------------------------------------------

test("saveCliCredential writes only what changed, and only over the same sign-in", () => {
  const compact = JSON.stringify({ providers: { meta: { access_token: "dca:t", api_key: "LLM|same", user_email: "ada@example.com" } } })
  const cli = tempCli(compact)
  try {
    // nothing new: the file is left as it is, byte for byte
    expect(saveCliCredential({ apiKey: "LLM|same", email: "ada@example.com" }, "dca:t", cli.file)).toBe(false)
    expect(readFileSync(cli.file, "utf8")).toBe(compact)
    // the CLI signed in again since: its sign-in is its own
    expect(saveCliCredential({ apiKey: "LLM|new" }, "dca:other", cli.file)).toBe(false)
    // a new key over the same sign-in is written
    expect(saveCliCredential({ apiKey: "LLM|new" }, "dca:t", cli.file)).toBe(true)
    expect(JSON.parse(readFileSync(cli.file, "utf8")).providers.meta.api_key).toBe("LLM|new")
    expect(readdirSync(cli.dir)).toEqual(["auth.json"])
  } finally {
    cli.done()
  }
})

test("replaceFile retries a refused rename and never leaves its temp file", () => {
  const cli = tempCli("{}")
  try {
    const busy = Object.assign(new Error("EBUSY"), { code: "EBUSY" })
    let tries = 0
    const flaky = (from, to) => {
      if (++tries < 3) throw busy
      renameSync(from, to)
    }
    expect(replaceFile(cli.file, '{"a":1}', "{}", flaky)).toBe(true)
    expect(tries).toBe(3)
    expect(readFileSync(cli.file, "utf8")).toBe('{"a":1}')

    const stuck = () => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" })
    }
    expect(replaceFile(cli.file, '{"a":2}', '{"a":1}', stuck)).toBe(false)
    expect(readFileSync(cli.file, "utf8")).toBe('{"a":1}')
    expect(readdirSync(cli.dir)).toEqual(["auth.json"])

    // a file the CLI rewrote meanwhile isn't written over
    expect(replaceFile(cli.file, '{"a":3}', "{}")).toBe(false)
    expect(readFileSync(cli.file, "utf8")).toBe('{"a":1}')
    expect(readdirSync(cli.dir)).toEqual(["auth.json"])
  } finally {
    cli.done()
  }
})

// ---- request rewriting ------------------------------------------------------------

test("rewrite normalizes tool_choice, drops unsupported tools, and cleans input items", () => {
  const raw = JSON.stringify({
    model: "muse-wonder-1.0-contributor",
    prompt_cache_key: "sess_99",
    tool_choice: "required",
    tools: [
      { type: "function", name: "read", parameters: { type: "object", properties: {} } },
      { type: "local_shell" },
      { type: "tool_search" },
    ],
    input: [
      {
        type: "agent_message",
        author: "planner",
        recipient: "coder",
        content: [{ type: "input_text", text: "Fix the bug" }],
      },
      {
        type: "reasoning",
        id: "rs_foreign",
        summary: [],
        content: null,
      },
      {
        type: "reasoning",
        id: "rs_meta",
        encrypted_content: "enc_blob",
        summary: [],
        content: null,
      },
    ],
  })

  const { body, model, sessionId } = rewrite(raw, "https://api.meta.ai/v1/responses")
  expect(model).toBe("muse-wonder-1.0-contributor")
  expect(sessionId).toBe("sess_99")

  const parsed = JSON.parse(body)
  expect(parsed.tool_choice).toBe("auto")
  expect(parsed.tools.map((t) => t.type)).toEqual(["function"])
  expect(parsed.input).toEqual([
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "From planner to coder\n\n" },
        { type: "input_text", text: "Fix the bug" },
      ],
    },
    {
      type: "reasoning",
      id: "rs_meta",
      encrypted_content: "enc_blob",
      summary: [],
    },
  ])
})

test("rewrite strips external_web_access and drops tool_choice none", () => {
  const { body } = rewrite(
    JSON.stringify({
      model: "muse-spark-1.3",
      tool_choice: "none",
      tools: [{ type: "web_search", external_web_access: true }],
      input: [{ role: "user", content: "hi" }],
    }),
    "https://api.meta.ai/v1/responses",
  )
  const parsed = JSON.parse(body)
  expect(parsed.tools).toBeUndefined()
  expect(parsed.tool_choice).toBeUndefined()

  const { body: b2 } = rewrite(
    JSON.stringify({ model: "m", tools: [{ type: "web_search", external_web_access: true }] }),
    "https://api.meta.ai/v1/responses",
  )
  expect(JSON.parse(b2).tools).toEqual([{ type: "web_search" }])
})

test("rewrite sends Codex's freeform tools as function tools, and their history as function calls", () => {
  const { body, customTools } = rewrite(
    JSON.stringify({
      model: "muse-spark-1.3",
      tool_choice: { type: "custom", name: "apply_patch" },
      tools: [
        { type: "function", name: "shell", parameters: { type: "object", properties: {} } },
        {
          type: "custom",
          name: "apply_patch",
          description: "Edit files with a patch.",
          format: { type: "grammar", syntax: "lark", definition: 'start: "*** Begin Patch"' },
        },
      ],
      input: [
        { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "apply_patch", input: "*** Begin Patch", status: "completed" },
        { type: "custom_tool_call_output", call_id: "call_1", output: "Done!" },
      ],
    }),
    "https://api.meta.ai/v1/responses",
  )
  expect([...customTools]).toEqual(["apply_patch"])
  const p = JSON.parse(body)
  expect(p.tool_choice).toBe("auto")
  expect(p.tools.map((t) => [t.type, t.name])).toEqual([
    ["function", "shell"],
    ["function", "apply_patch"],
  ])
  const patch = p.tools[1]
  expect(patch.parameters.required).toEqual(["input"])
  expect(patch.description).toContain("Edit files with a patch.")
  expect(patch.description).toContain('start: "*** Begin Patch"')
  expect(p.input).toEqual([
    {
      type: "function_call",
      call_id: "call_1",
      name: "apply_patch",
      arguments: JSON.stringify({ input: "*** Begin Patch" }),
      status: "completed",
    },
    { type: "function_call_output", call_id: "call_1", output: "Done!" },
  ])
})

test("rewrite fills in the model's default effort and include, keeping what the request says", () => {
  const defaults = (id) => _internal.modelDefaults.get(id)
  const fill = JSON.parse(rewrite(JSON.stringify({ model: "muse-spark-1.3", input: "hi" }), `${BASE}/responses`, defaults).body)
  expect(fill.reasoning).toEqual({ effort: "high" })
  expect(fill.include).toEqual(["reasoning.encrypted_content"])

  const own = rewrite(
    JSON.stringify({ model: "muse-spark-1.3", input: "hi", reasoning: { effort: "low", summary: "auto" }, include: ["reasoning.encrypted_content"] }),
    `${BASE}/responses`,
    defaults,
  )
  expect(JSON.parse(own.body).reasoning).toEqual({ effort: "low", summary: "auto" })

  // a variant stands for the effort it names, here one that differs from its name
  const named = rewrite(JSON.stringify({ model: "x", input: "hi", reasoning: { effort: "fast" } }), `${BASE}/responses`, () => ({
    options: {},
    variants: { fast: { reasoningEffort: "low" } },
  }))
  expect(JSON.parse(named.body).reasoning).toEqual({ effort: "low" })

  // chat completions say it as reasoning_effort; a model without reasoning is left alone
  const chat = rewrite(JSON.stringify({ model: "muse-spark-1.3", messages: [] }), `${BASE}/chat/completions`, defaults)
  expect(JSON.parse(chat.body).reasoning_effort).toBe("high")
  const plain = rewrite(JSON.stringify({ model: "y", input: "hi" }), `${BASE}/responses`, () => ({ reasoning: false, options: { reasoningEffort: "high" } }))
  expect(plain.body).toBe(JSON.stringify({ model: "y", input: "hi" }))
})

// ---- requests ---------------------------------------------------------------------

test("loader signs requests with Muse headers, sets contributor header, and re-mints on 401", async () => {
  const { client, getAuth, saved } = makeClient(oauthAuth("LLM|stale_key"))
  const hooks = await MuseAuthPlugin({ client })

  serve([
    ["/v1/responses", () => new Response('{"error":"expired key"}', { status: 401 })],
    ["/muse-code/key", () => Response.json(SAMPLE_MINTED_BODY)],
    ["/v1/responses", () => Response.json({ id: "resp_ok", status: "completed" })],
  ])

  const loader = await hooks.auth.loader(getAuth)
  const res = await loader.fetch(`${BASE}/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "muse-wonder-1.0-contributor",
      prompt_cache_key: "sess_1",
      input: [{ role: "user", content: "hi" }],
    }),
  })

  expect(res.status).toBe(200)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("renewed")
  expect(calls.length).toBe(3)

  // First attempt used stale key
  const h0 = new Headers(calls[0].init.headers)
  expect(h0.get("Authorization")).toBe("Bearer LLM|stale_key")
  expect(h0.get("x-tbh-contributor-mode")).toBe("1")
  expect(h0.get("x-api-version")).toBe("1.0.0")
  expect(h0.get("x-client-id")).toBe("tbh:cli")
  expect(h0.get("x-tbh-session-id")).toBe("sess_1")

  // Third call (retry after mint) used new key
  expect(authOf(calls[2])).toBe("Bearer LLM|11334867890|secret")
  expect(saved.length).toBeGreaterThan(0)
  expect(saved.at(-1).apiKey).toBe("LLM|11334867890|secret")

  // the model's defaults reach Meta: magpie's gateway knows only the variant names
  const sent = JSON.parse(calls[2].init.body)
  expect(sent.reasoning).toEqual({ effort: "high" })
  expect(sent.include).toEqual(["reasoning.encrypted_content"])
})

test("a pasted dca: token mints its key once, not on every request", async () => {
  const { client, getAuth } = makeClient({ type: "api", key: "dca:pasted_token" })
  const hooks = await MuseAuthPlugin({ client })
  serveAll((url) => (url.includes("/muse-code/key") ? Response.json(SAMPLE_MINTED_BODY) : Response.json({ id: "ok" })))
  const loader = await hooks.auth.loader(getAuth)
  for (let i = 0; i < 3; i++) expect((await post(loader)).status).toBe(200)
  // long after the mint, too
  for (const l of _internal.latest.values()) l.at -= 10 * 60 * 1000
  for (let i = 0; i < 2; i++) expect((await post(loader)).status).toBe(200)
  expect(count("/muse-code/key")).toBe(1)
  expect(count("/v1/responses")).toBe(5)
  expect(authOf(calls.at(-1))).toBe("Bearer LLM|11334867890|secret")
})

test("requests refused one after another on an old key share one new key", async () => {
  const { client, getAuth } = makeClient(oauthAuth("LLM|stale"))
  const hooks = await MuseAuthPlugin({ client })
  let n = 0
  serveAll(async (url, init) => {
    if (url.includes("/muse-code/key")) {
      await sleep(5)
      return Response.json(minted(`LLM|k${++n}`))
    }
    if (authOf({ init }) === "Bearer LLM|stale") {
      await sleep(calls.length * 40) // the refusals arrive one after another
      return new Response("{}", { status: 401 })
    }
    return Response.json({ id: "ok" })
  })
  const loader = await hooks.auth.loader(getAuth)
  const rs = await Promise.all([post(loader), post(loader), post(loader)])
  expect(rs.map((r) => r.status)).toEqual([200, 200, 200])
  expect(count("/muse-code/key")).toBe(1)
})

test("403 re-mints once, then Meta's answer stands without marking the sign-in", async () => {
  const { client, getAuth } = makeClient(oauthAuth("LLM|k0"))
  const hooks = await MuseAuthPlugin({ client })
  serveAll((url) => (url.includes("/muse-code/key") ? Response.json(minted("LLM|k1")) : new Response('{"error":"forbidden"}', { status: 403 })))
  const loader = await hooks.auth.loader(getAuth)
  const first = await post(loader)
  expect(first.status).toBe(403)
  expect(first.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect(await first.text()).toBe('{"error":"forbidden"}')
  expect(count("/muse-code/key")).toBe(1)
  // the key was minted moments ago: a second 403 doesn't mint again
  await post(loader)
  expect(count("/muse-code/key")).toBe(1)
})

test("a key refused right after it was minted marks the sign-in expired", async () => {
  const { client, getAuth } = makeClient(oauthAuth("LLM|k0"))
  const hooks = await MuseAuthPlugin({ client })
  serveAll((url) => (url.includes("/muse-code/key") ? Response.json(minted("LLM|k1")) : new Response("{}", { status: 401 })))
  const loader = await hooks.auth.loader(getAuth)
  const res = await post(loader)
  expect(res.status).toBe(401)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("expired")
  // the next request carries the new key and isn't minted for again
  const again = await post(loader)
  expect(again.headers.get("X-Magpie-Sign-In")).toBe("expired")
  expect(count("/muse-code/key")).toBe(1)
})

test("a refused key whose sign-in Meta turns away too answers 401 expired", async () => {
  const { client, getAuth } = makeClient(oauthAuth("LLM|k0"))
  const hooks = await MuseAuthPlugin({ client })
  serveAll((url) => new Response('{"detail":"token expired"}', { status: 401 }))
  const loader = await hooks.auth.loader(getAuth)
  const res = await post(loader)
  expect(res.status).toBe(401)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("expired")
  expect((await res.json()).error.message).toContain("sign in again")
})

test("a refused key whose new mint can't be reached keeps the sign-in", async () => {
  const { client, getAuth } = makeClient(oauthAuth("LLM|k0"))
  const hooks = await MuseAuthPlugin({ client })
  serveAll((url) => {
    if (url.includes("/muse-code/key")) throw new TypeError("fetch failed")
    return new Response("{}", { status: 401 })
  })
  const loader = await hooks.auth.loader(getAuth)
  const res = await post(loader)
  expect(res.status).toBe(401)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
})

test("a pasted LLM| key that Meta refuses is marked expired without minting", async () => {
  const { client, getAuth } = makeClient({ type: "api", key: "LLM|pasted" })
  const hooks = await MuseAuthPlugin({ client })
  serveAll(() => new Response("{}", { status: 401 }))
  const loader = await hooks.auth.loader(getAuth)
  const res = await post(loader)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("expired")
  expect(count("/muse-code/key")).toBe(0)
})

// sseText is a Responses event stream as Meta sends it.
const sseText = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("")

// sseEvents reads an event stream back: [{event, data}].
const sseEvents = (text) =>
  text
    .split("\n\n")
    .filter((b) => b.trim())
    .map((b) => {
      const lines = b.split("\n")
      return {
        event: lines.find((l) => l.startsWith("event: "))?.slice(7),
        data: JSON.parse(lines.find((l) => l.startsWith("data: ")).slice(6)),
      }
    })

// chunked streams text in pieces of n bytes, splitting events and characters.
function chunked(text, n) {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += n) c.enqueue(bytes.slice(i, i + n))
      c.close()
    },
  })
}

const PATCH = "*** Begin Patch\n*** Add File: 补丁.txt\n+你好\n*** End Patch"
const CODEX_REQUEST = {
  tools: [
    { type: "function", name: "shell", parameters: { type: "object", properties: {} } },
    { type: "custom", name: "apply_patch", description: "Edit files.", format: { type: "text" } },
  ],
}

test("calls to Codex's freeform tools stream back as custom_tool_call", async () => {
  const args = JSON.stringify({ input: PATCH })
  const meta = sseText([
    { type: "response.created", sequence_number: 0, response: { id: "resp_1", output: [] } },
    { type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "apply_patch", arguments: "" } },
    { type: "response.function_call_arguments.delta", sequence_number: 2, item_id: "fc_1", output_index: 0, delta: args.slice(0, 20) },
    { type: "response.function_call_arguments.delta", sequence_number: 3, item_id: "fc_1", output_index: 0, delta: args.slice(20) },
    { type: "response.function_call_arguments.done", sequence_number: 4, item_id: "fc_1", output_index: 0, arguments: args },
    { type: "response.output_item.done", sequence_number: 5, output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "apply_patch", arguments: args, status: "completed" } },
    { type: "response.output_item.done", sequence_number: 6, output_index: 1, item: { type: "function_call", id: "fc_2", call_id: "call_2", name: "shell", arguments: "{}", status: "completed" } },
    { type: "response.output_text.delta", sequence_number: 7, item_id: "msg_1", output_index: 2, delta: "talking about function_call is fine" },
    {
      type: "response.completed",
      sequence_number: 8,
      response: {
        id: "resp_1",
        output: [
          { type: "function_call", id: "fc_1", call_id: "call_1", name: "apply_patch", arguments: args },
          { type: "function_call", id: "fc_2", call_id: "call_2", name: "shell", arguments: "{}" },
        ],
      },
    },
  ])
  const { client, getAuth } = makeClient(oauthAuth())
  const hooks = await MuseAuthPlugin({ client })
  serveAll(() => new Response(chunked(meta, 7), { headers: { "content-type": "text/event-stream" } }))
  const loader = await hooks.auth.loader(getAuth)
  const res = await post(loader, CODEX_REQUEST)
  const evs = sseEvents(await res.text())

  for (const e of evs) expect(e.event).toBe(e.data.type)
  expect(evs.map((e) => e.data.type)).toEqual([
    "response.created",
    "response.output_item.added",
    "response.custom_tool_call_input.done",
    "response.output_item.done",
    "response.output_item.done",
    "response.output_text.delta",
    "response.completed",
  ])
  expect(evs[1].data.item).toEqual({ type: "custom_tool_call", id: "fc_1", call_id: "call_1", name: "apply_patch", input: "" })
  expect(evs[2].data).toEqual({ type: "response.custom_tool_call_input.done", sequence_number: 4, item_id: "fc_1", output_index: 0, input: PATCH })
  expect(evs[3].data.item).toEqual({ type: "custom_tool_call", id: "fc_1", call_id: "call_1", name: "apply_patch", status: "completed", input: PATCH })
  expect(evs[4].data.item.type).toBe("function_call")
  expect(evs[5].data.delta).toBe("talking about function_call is fine")
  expect(evs[6].data.response.output.map((o) => o.type)).toEqual(["custom_tool_call", "function_call"])
  expect(evs[6].data.response.output[0].input).toBe(PATCH)
})

test("calls to Codex's freeform tools come back as custom_tool_call in a whole reply too", async () => {
  const { client, getAuth } = makeClient(oauthAuth())
  const hooks = await MuseAuthPlugin({ client })
  serveAll(() =>
    Response.json({
      id: "resp_1",
      output: [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "apply_patch", arguments: JSON.stringify({ input: PATCH }) }],
    }),
  )
  const loader = await hooks.auth.loader(getAuth)
  const res = await post(loader, CODEX_REQUEST)
  const body = await res.json()
  expect(body.output[0]).toEqual({ type: "custom_tool_call", id: "fc_1", call_id: "call_1", name: "apply_patch", input: PATCH })
})

// ---- models -----------------------------------------------------------------------

test("provider.models fetches /muse-code/models and filters hidden / non-text models", async () => {
  const initialAuth = oauthAuth()
  const { client } = makeClient(initialAuth)
  const hooks = await MuseAuthPlugin({ client })

  serve([["/muse-code/models", () => Response.json(SAMPLE_MODELS_BODY)]])

  const models = await hooks.provider.models({ id: "muse", models: DEFAULT_MODELS }, { auth: initialAuth })
  expect(Object.keys(models)).toEqual(["muse-wonder-1.0-contributor"])
  const m = models["muse-wonder-1.0-contributor"]
  expect(m.limit.context).toBe(1007997)
  expect(m.limit.output).toBe(128000)
  expect(Object.keys(m.variants)).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"])
  expect(_internal.modelDefaults.get("muse-wonder-1.0-contributor").options.reasoningEffort).toBe("high")
})

test("provider.models re-mints a refused key; a 403 that stays isn't a sign-in failure", async () => {
  const initialAuth = oauthAuth("LLM|k0")
  const { client } = makeClient(initialAuth)
  const hooks = await MuseAuthPlugin({ client })

  serve([
    ["/muse-code/models", () => new Response("{}", { status: 401 })],
    ["/muse-code/key", () => Response.json(minted("LLM|k1"))],
    ["/muse-code/models", () => Response.json(SAMPLE_MODELS_BODY)],
  ])
  const models = await hooks.provider.models({ id: "muse", models: DEFAULT_MODELS }, { auth: initialAuth })
  expect(Object.keys(models)).toEqual(["muse-wonder-1.0-contributor"])
  expect(authOf(calls[2])).toBe("Bearer LLM|k1")

  reset()
  serveAll((url) => (url.includes("/muse-code/key") ? Response.json(minted("LLM|k2")) : new Response("{}", { status: 403 })))
  let err
  try {
    await hooks.provider.models({ id: "muse", models: DEFAULT_MODELS }, { auth: initialAuth })
  } catch (e) {
    err = e
  }
  expect(String(err?.message)).toContain("HTTP 403")
  expect(err?.signIn).toBeUndefined()
})

test("provider.models asks Meta for an account's list once in five minutes, a failure once in thirty seconds", async () => {
  const initialAuth = oauthAuth()
  const { client } = makeClient(initialAuth)
  const hooks = await MuseAuthPlugin({ client })
  const list = () => hooks.provider.models({ id: "muse", models: DEFAULT_MODELS }, { auth: initialAuth })

  // magpie's host asks before every request: those share one answer
  serveAll(() => Response.json(SAMPLE_MODELS_BODY))
  await Promise.all([list(), list()])
  expect(Object.keys(await list())).toEqual(["muse-wonder-1.0-contributor"])
  expect(count("/muse-code/models")).toBe(1)
  for (const c of _internal.listed.values()) c.at -= 6 * 60 * 1000
  await list()
  expect(count("/muse-code/models")).toBe(2)

  reset()
  serveAll(() => {
    throw new TypeError("fetch failed")
  })
  for (let i = 0; i < 2; i++) {
    let err
    try {
      await list()
    } catch (e) {
      err = e
    }
    expect(String(err?.message)).toContain("fetch failed")
  }
  expect(count("/muse-code/models")).toBe(1)
})

// ---- usage ------------------------------------------------------------------------

test("auth.usage returns subscription windows from /muse-code/key", async () => {
  const { client, getAuth } = makeClient(oauthAuth())
  const hooks = await MuseAuthPlugin({ client })

  serve([["/muse-code/key", () => Response.json(SAMPLE_MINTED_BODY)]])

  const u = await hooks.auth.usage(getAuth)
  expect(u.plan).toBe("Muse Code Everyday Usage")
  expect(u.user).toBe("ada@example.com")
  expect(u.signIn).toBe("kept")
  expect(u.windows).toEqual([
    {
      name: "5 hours",
      used: 12.5,
      span: 18000,
      resetsAt: new Date(1792186805 * 1000).toISOString(),
    },
    {
      name: "7 days",
      used: 45,
      span: 604800,
      resetsAt: new Date(1792368000 * 1000).toISOString(),
    },
  ])
})

test("usage reads within a minute share one mint", async () => {
  const { client, getAuth } = makeClient(oauthAuth())
  const hooks = await MuseAuthPlugin({ client })
  serveAll(() => Response.json(SAMPLE_MINTED_BODY))
  for (let i = 0; i < 3; i++) expect((await hooks.auth.usage(getAuth)).plan).toBe("Muse Code Everyday Usage")
  expect(count("/muse-code/key")).toBe(1)
})

test("usage leaves the CLI's auth.json alone when nothing changed", async () => {
  const compact = JSON.stringify({
    providers: { meta: { access_token: "dca:valid_token", api_key: "LLM|11334867890|secret", user_email: "ada@example.com" } },
  })
  const cli = tempCli(compact)
  try {
    const { client, getAuth } = makeClient(oauthAuth(undefined, { useCli: true, cliPath: cli.file }))
    const hooks = await MuseAuthPlugin({ client })
    serveAll(() => Response.json(SAMPLE_MINTED_BODY))
    await hooks.auth.usage(getAuth)
    // the profile it doesn't have yet is written once…
    const once = readFileSync(cli.file, "utf8")
    expect(JSON.parse(once).providers.meta.user_full_name).toBe("Ada Lovelace")
    reset()
    await hooks.auth.usage(getAuth)
    // …and not again
    expect(readFileSync(cli.file, "utf8")).toBe(once)
    expect(readdirSync(cli.dir)).toEqual(["auth.json"])
  } finally {
    cli.done()
  }
})

test("usage keeps a sign-in whose token Meta turned away while its key still serves", async () => {
  const { client, getAuth } = makeClient(oauthAuth("LLM|still_valid"))
  const hooks = await MuseAuthPlugin({ client })
  serveAll((url) =>
    url.includes("/muse-code/key") ? new Response('{"detail":"token expired"}', { status: 401 }) : Response.json({ data: [] }),
  )
  const u = await hooks.auth.usage(getAuth)
  expect(u.signIn).toBe("kept")
  expect(u.error).toContain("sign in again")
  const models = calls.find((c) => c.url.includes("/muse-code/models"))
  expect(authOf(models)).toBe("Bearer LLM|still_valid")

  // a turned-away token isn't offered again for a while
  await hooks.auth.usage(getAuth)
  expect(count("/muse-code/key")).toBe(1)
})

test("usage marks the sign-in expired when its key is refused too", async () => {
  const { client, getAuth } = makeClient(oauthAuth("LLM|dead"))
  const hooks = await MuseAuthPlugin({ client })
  serveAll(() => new Response("{}", { status: 401 }))
  const u = await hooks.auth.usage(getAuth)
  expect(u.signIn).toBe("expired")
})

test("usage of a plain API key reports the key and any rate limit", async () => {
  const { client, getAuth } = makeClient({ type: "api", key: "LLM|pasted", metadata: { email: "ada@example.com" } })
  const hooks = await MuseAuthPlugin({ client })
  serveAll(() => new Response("{}", { status: 429, headers: { "retry-after": "120" } }))
  const loader = await hooks.auth.loader(getAuth)
  await post(loader)
  const u = await hooks.auth.usage(getAuth)
  expect(u.plan).toBe("API key")
  expect(u.user).toBe("ada@example.com")
  expect(u.windows.map((w) => w.name)).toEqual(["Rate limit"])
})

test("a 429 shows as a Rate limit window until it resets", async () => {
  const { client, getAuth } = makeClient(oauthAuth())
  const hooks = await MuseAuthPlugin({ client })
  serveAll((url) =>
    url.includes("/muse-code/key") ? Response.json(SAMPLE_MINTED_BODY) : new Response("{}", { status: 429, headers: { "retry-after": "120" } }),
  )
  const loader = await hooks.auth.loader(getAuth)
  const res = await post(loader)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  const u = await hooks.auth.usage(getAuth)
  expect(u.windows.map((w) => w.name)).toEqual(["Rate limit", "5 hours", "7 days"])
  expect(u.windows[0].aside).toBe(true)
})

test("resetOf reads retry-after and rate-limit reset headers", () => {
  const now = 1_800_000_000_000
  expect(resetOf(new Headers({ "retry-after": "30" }), now)).toBe(now + 30_000)
  expect(resetOf(new Headers({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }), now)).toBe(Date.parse("Wed, 21 Oct 2026 07:28:00 GMT"))
  expect(resetOf(new Headers({ "x-ratelimit-reset-requests": "1800000100" }), now)).toBe(1_800_000_100_000)
  expect(resetOf(new Headers({ "x-ratelimit-reset": "5" }), now)).toBe(now + 5000)
  expect(resetOf(new Headers({}), now)).toBe(0)
})

test("stateOf prefers a newer CLI sign-in and keeps both keys in view", () => {
  const cli = tempCli({ access_token: "dca:cli_new", api_key: "LLM|cli_key", user_email: "ada@example.com" })
  try {
    const s = stateOf(oauthAuth("LLM|ours", { useCli: true, cliPath: cli.file }))
    expect(s.accessToken).toBe("dca:cli_new")
    expect(s.cliApiKey).toBe("LLM|cli_key")
    expect(s.apiKey).toBe("LLM|ours")
    expect(_internal.keyOf(s)).toBe("LLM|cli_key")
    _internal.rejected.add("LLM|cli_key")
    expect(_internal.keyOf(s)).toBe("LLM|ours")
  } finally {
    cli.done()
  }
})
