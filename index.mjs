// Meta One / Muse Code as an OpenCode and magpie provider plugin.
//
// Signs in the way the `muse` CLI signs in:
//   1. OIDC device authorization at https://auth.meta.com/oidc/device/authorization/
//      (client_id 1031625952748946), polled at /oidc/device/token/ for an
//      access_token (`dca:...`), then traded at POST https://api.meta.ai/muse-code/key
//      for the account's Model API key (`LLM|...`), base URL, profile and
//      subscription allowance snapshot (`subs_usage`).
//   2. Or reads the sign-in `muse login` already saved in
//      $MUSE_AUTH_PATH / ${XDG_CONFIG_HOME:-~/.config}/muse/auth.json.
//   3. Or takes a Meta Model API key (`LLM|...`) directly.
//
// The access token can't be renewed: /oidc/device/token/ answers a
// refresh_token grant with 404 (checked 2026-10-17). A sign-in lasts as long
// as Meta honours its token; the key minted with it goes on serving after
// that, and only minting a new key needs signing in again.
//
// Models are served on OpenAI's Responses API (`@ai-sdk/openai`) at
// https://api.meta.ai/v1/responses, signed with the headers `muse` sends
// (`x-api-version: 1.0.0`, `x-client-id: tbh:cli`, `User-Agent: muse-build/0.1.0`,
// and `x-tbh-contributor-mode: 1` on `*-contributor` models).

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs"
import { STATUS_CODES } from "node:http"
import { homedir } from "node:os"
import { join } from "node:path"

const PROVIDER = "muse"
const NPM = "@ai-sdk/openai"

const AUTH_ORIGIN = "https://auth.meta.com"
const API_ORIGIN = "https://api.meta.ai"
const BASE = `${API_ORIGIN}/v1`

const CLIENT_ID = "1031625952748946"
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
const API_VERSION = "1.0.0"
const CLIENT_SURFACE = "tbh:cli"
const USER_AGENT = "muse-build/0.1.0"
const LAUNCHER_UA = "muse-code/launcher-ps-3"

const HOLD_MS = 5 * 60 * 1000
// A key minted this recently isn't minted again when a request is refused:
// Meta would only hand the same one back.
const MINT_FRESH = 30 * 1000
// auth.usage reads the allowance off a mint at most this old.
const USAGE_FRESH = 60 * 1000
// An access token /muse-code/key turned away isn't offered again for this long.
const DEAD_TTL = 10 * 60 * 1000
// Device sign-in polling backs off to at most this after a poll that failed.
const POLL_BACKOFF_MAX = 30 * 1000
// magpie's host asks provider.models before every request it sends: an account's
// list is asked of Meta at most this often, and a failure told again for
// LIST_FAILED_FRESH without asking.
const MODELS_FRESH = 5 * 60 * 1000
const LIST_FAILED_FRESH = 30 * 1000
const RENAME_TRIES = 20
const ICON =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%230064e0' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'><path d='M12 12c-2-2.67-4-4-6-4a4 4 0 1 0 0 8c2 0 4-1.33 6-4Zm0 0c2 2.67 4 4 6 4a4 4 0 0 0 0-8c-2 0-4 1.33-6 4Z'/></svg>"

// Tools that https://api.meta.ai/v1/responses accepts; unsupported tool types
// (such as Codex's `local_shell`, `shell`) are rejected by Meta's endpoint with
// 400 invalid_request_error. Codex's freeform `custom` tools (apply_patch) are
// sent as function tools instead (functionOfCustom).
const ALLOWED_TOOLS = new Set([
  "function",
  "web_search",
  "web_search_preview",
  "web_search_preview_2025_03_11",
  "file_search",
  "code_interpreter",
  "computer_use_preview",
  "mcp",
  "image_generation",
])

const EFFORTS_MAX = ["minimal", "low", "medium", "high", "xhigh", "max"]
const EFFORTS_XHIGH = ["minimal", "low", "medium", "high", "xhigh"]

function variantsOf(efforts) {
  return Object.fromEntries(efforts.map((e) => [e, { reasoningEffort: e }]))
}

function defaultModelEntry(id, name, efforts = EFFORTS_MAX, releaseDate = "2026-10-12") {
  return {
    id,
    name,
    attachment: true,
    reasoning: true,
    temperature: false,
    tool_call: true,
    release_date: releaseDate,
    modalities: { input: ["text", "image"], output: ["text"] },
    limit: { context: 1007997, output: 128000 },
    options: {
      reasoningEffort: "high",
      include: ["reasoning.encrypted_content"],
    },
    variants: variantsOf(efforts),
  }
}

const DEFAULT_MODELS = {
  "muse-wonder-1.0": defaultModelEntry("muse-wonder-1.0", "muse-wonder-1.0", EFFORTS_MAX, "2026-10-12"),
  "muse-wonder-1.0-contributor": defaultModelEntry(
    "muse-wonder-1.0-contributor",
    "muse-wonder-1.0-contributor",
    EFFORTS_MAX,
    "2026-10-12",
  ),
  "muse-spark-1.3": defaultModelEntry("muse-spark-1.3", "muse-spark-1.3", EFFORTS_MAX, "2026-09-02"),
  "muse-spark-1.3-contributor": defaultModelEntry(
    "muse-spark-1.3-contributor",
    "muse-spark-1.3-contributor",
    EFFORTS_MAX,
    "2026-09-02",
  ),
  "muse-spark-1.2": defaultModelEntry("muse-spark-1.2", "muse-spark-1.2", EFFORTS_XHIGH, "2026-08-05"),
  "muse-spark-1.2-contributor": defaultModelEntry(
    "muse-spark-1.2-contributor",
    "muse-spark-1.2-contributor",
    EFFORTS_XHIGH,
    "2026-08-05",
  ),
}

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v)
const str = (o, k) => (typeof o?.[k] === "string" && o[k].trim() ? o[k].trim() : "")
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const expired = (message) => Object.assign(new Error(message), { signIn: "expired" })

function originOf(baseUrl) {
  try {
    return new URL(baseUrl || BASE).origin
  } catch {
    return API_ORIGIN
  }
}

function normalizeBaseUrl(baseUrl) {
  const s = typeof baseUrl === "string" && baseUrl.trim() ? baseUrl.trim().replace(/\/+$/, "") : BASE
  return s.endsWith("/v1") ? s : `${s}/v1`
}

// ---- Model defaults ---------------------------------------------------------------

// What each model asks of a request that doesn't say (its `options`: the
// reasoning effort, `include`) and what its variants stand for. OpenCode applies
// these through the AI SDK; magpie hands its gateway only the variants' names,
// so the loader's fetch fills them in (applyDefaults).
const modelDefaults = new Map()

function noteModel(id, m) {
  if (typeof id !== "string" || !id || !isObj(m)) return
  modelDefaults.set(id, {
    reasoning: m.capabilities?.reasoning ?? m.reasoning ?? true,
    options: isObj(m.options) ? m.options : {},
    variants: isObj(m.variants) ? m.variants : {},
  })
}

function noteDefaultModels() {
  for (const [id, m] of Object.entries(DEFAULT_MODELS)) noteModel(id, m)
}
noteDefaultModels()

// ---- Muse Code CLI auth.json ----------------------------------------------------

function cliAuthPath() {
  if (process.env.MUSE_AUTH_PATH?.trim()) return process.env.MUSE_AUTH_PATH.trim()
  const candidates = []
  if (process.env.XDG_CONFIG_HOME?.trim()) {
    candidates.push(join(process.env.XDG_CONFIG_HOME.trim(), "muse", "auth.json"))
  }
  for (const h of [process.env.HOME, process.env.USERPROFILE, homedir()]) {
    if (h?.trim()) candidates.push(join(h.trim(), ".config", "muse", "auth.json"))
  }
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return candidates[0] || join(homedir(), ".config", "muse", "auth.json")
}

function readCliCredential(path = cliAuthPath()) {
  try {
    if (!path || !existsSync(path)) return null
    const doc = JSON.parse(readFileSync(path, "utf8"))
    const meta = doc?.providers?.meta
    if (!isObj(meta)) return null
    const accessToken = str(meta, "access_token")
    const apiKey = str(meta, "api_key")
    if (!accessToken && !apiKey) return null
    return {
      accessToken,
      apiKey,
      baseUrl: normalizeBaseUrl(str(meta, "api_base_url") || BASE),
      email: str(meta, "user_email"),
      fullName: str(meta, "user_full_name"),
      subsActive: meta.subs_active === true,
      mechanism: str(meta, "mechanism") || (accessToken ? "oauth" : "api_key"),
      obtainedVia: str(meta, "obtained_via") || "device_code",
      cliPath: path,
    }
  } catch {
    return null
  }
}

// saveCliCredential writes a freshly minted key and profile back into the CLI's
// auth.json, so `muse` goes on working with it: only when something changed,
// only over the sign-in the key was minted for (a CLI that signed in again
// keeps its own), and never over a file the CLI rewrote meanwhile. It says
// whether it wrote.
function saveCliCredential(minted, accessToken, path = cliAuthPath()) {
  if (!path) return false
  let text
  let doc
  try {
    text = readFileSync(path, "utf8")
    doc = JSON.parse(text)
  } catch {
    return false
  }
  const meta = doc?.providers?.meta
  if (!isObj(meta)) return false
  if (meta.access_token && accessToken && meta.access_token !== accessToken) return false
  let changed = false
  const set = (k, v) => {
    if (v === undefined || v === "" || meta[k] === v) return
    meta[k] = v
    changed = true
  }
  set("api_key", minted.apiKey)
  set("api_base_url", minted.baseUrl)
  set("user_full_name", minted.fullName)
  set("user_email", minted.email)
  if (typeof minted.subsActive === "boolean") set("subs_active", minted.subsActive)
  if (!changed) return false
  return replaceFile(path, JSON.stringify(doc, null, 2) + "\n", text)
}

// pause blocks for ms: the CLI's file is read and replaced in one synchronous step.
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// replaceFile puts data at path through a temp file renamed over it, as long
// as path still holds was. Windows refuses a rename over a file another program
// holds open for a moment, so the rename is tried again; the temp file, which
// holds the key, never stays behind.
function replaceFile(path, data, was, rename = renameSync) {
  const tmp = `${path}.magpie-tmp.${process.pid}`
  try {
    const buf = Buffer.from(data)
    const fd = openSync(tmp, "w", 0o600)
    try {
      for (let off = 0; off < buf.length; ) off += writeSync(fd, buf, off, buf.length - off)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    for (let i = 1; ; i++) {
      if (readFileSync(path, "utf8") !== was) return false
      try {
        rename(tmp, path)
        return true
      } catch (e) {
        if (i >= RENAME_TRIES || !["EPERM", "EACCES", "EBUSY"].includes(e?.code)) throw e
        pause(10)
      }
    }
  } catch {
    return false
  } finally {
    try {
      unlinkSync(tmp)
    } catch {}
  }
}

// ---- OAuth device flow & key minting --------------------------------------------

function resolveHttps(uri) {
  const s = String(uri ?? "").trim()
  if (!s) return ""
  if (s.startsWith("https://")) return s
  if (s.startsWith("http://")) return "https://" + s.slice(7)
  return ""
}

async function startDeviceCode(authOrigin = AUTH_ORIGIN) {
  const res = await fetch(`${authOrigin}/oidc/device/authorization/`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": LAUNCHER_UA,
    },
    body: new URLSearchParams({ client_id: CLIENT_ID }).toString(),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Meta sign-in could not be started (HTTP ${res.status}): ${text.slice(0, 200)}`)
  }
  let d
  try {
    d = JSON.parse(text)
  } catch {
    throw new Error("Meta device authorization returned invalid JSON")
  }
  const deviceCode = str(d, "device_code")
  const userCode = str(d, "user_code")
  const url = resolveHttps(str(d, "verification_uri_complete")) || resolveHttps(str(d, "verification_uri"))
  if (!deviceCode || !userCode || !url) {
    throw new Error("Meta device authorization response missing device_code, user_code, or verification_uri")
  }
  const rawInterval = Number(d.interval)
  const intervalSec = Number.isFinite(rawInterval) && rawInterval > 0 ? rawInterval : 5
  const lifetimeSec = Math.min(1800, Math.max(60, Number(d.expires_in) || 900))
  return {
    deviceCode,
    userCode,
    url,
    intervalMs: intervalSec * 1000,
    deadline: Date.now() + lifetimeSec * 1000,
  }
}

async function pollDeviceToken(d, authOrigin = AUTH_ORIGIN) {
  let interval = d.intervalMs
  let wait = interval
  while (Date.now() < d.deadline) {
    await sleep(wait)
    let res
    let text
    try {
      res = await fetch(`${authOrigin}/oidc/device/token/`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": LAUNCHER_UA,
        },
        body: new URLSearchParams({
          grant_type: DEVICE_GRANT,
          device_code: d.deviceCode,
          client_id: CLIENT_ID,
        }).toString(),
        signal: AbortSignal.timeout(30_000),
      })
      text = await res.text()
    } catch {
      // A dropped connection or a poll that timed out isn't Meta's answer:
      // ask again, backing off, until the code expires.
      wait = Math.min(wait * 2, POLL_BACKOFF_MAX)
      continue
    }
    let body = {}
    try {
      body = JSON.parse(text) ?? {}
    } catch {}
    if (res.ok) {
      const accessToken = str(body, "access_token")
      if (!accessToken) throw new Error("Meta sign-in response carried no usable access_token")
      return { accessToken }
    }
    const errCode = str(body, "error")
    if (errCode === "authorization_pending") {
      wait = interval
      continue
    }
    if (errCode === "slow_down") {
      interval += 5000
      wait = interval
      continue
    }
    if (errCode === "access_denied") throw new Error("Meta sign-in request was denied")
    if (errCode === "expired_token") throw new Error("Meta sign-in code expired before it was approved")
    // Nor is a server failing for a moment.
    if (!errCode && (res.status >= 500 || res.status === 429)) {
      wait = Math.min(wait * 2, POLL_BACKOFF_MAX)
      continue
    }
    throw new Error(`Meta sign-in failed (HTTP ${res.status}${errCode ? `: ${errCode}` : ""})`)
  }
  throw new Error("Meta sign-in code expired before it was approved")
}

// mintKey trades a Meta OAuth access_token (`dca:...`) at POST /muse-code/key
// for the account's Model API key (`LLM|...`), profile, and subscription usage.
async function mintKey(accessToken, apiOrigin = API_ORIGIN) {
  if (!accessToken) throw expired("Meta account is not signed in; run `muse login` or sign in again")
  const url = `${apiOrigin.replace(/\/+$/, "")}/muse-code/key`
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-api-version": API_VERSION,
      "User-Agent": USER_AGENT,
    },
    body: "{}",
    signal: AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {}
  if (!res.ok) {
    const code = body?.code ?? body?.error?.code
    const detail = str(body, "detail") || str(body, "title") || str(body?.error, "message") || text.slice(0, 200)
    if (code === "MODEL_API__ONBOARDING_REQUIRED" || code === 4705001) {
      throw expired(
        "Your Meta account isn't set up for Model API yet — finish onboarding at https://dev.meta.ai, then sign in again.",
      )
    }
    if (code === 4705002 || detail.includes("no_payg")) {
      throw new Error(
        "Muse Code requires a subscription or payment method — subscribe at https://accountscenter.meta.com/muse_code/?ep=no_payg, then sign in again.",
      )
    }
    if (res.status === 401 || res.status === 403) {
      // refused: the access token itself was turned away (keyServes may still find its key serving)
      throw Object.assign(
        expired(`Meta refused the stored sign-in (HTTP ${res.status}${detail ? `: ${detail}` : ""}); sign in again`),
        { refused: true },
      )
    }
    throw new Error(`Meta key mint failed (HTTP ${res.status}${detail ? `: ${detail}` : ""})`)
  }
  if (!isObj(body)) throw new Error("Meta key mint response did not parse as JSON")
  if (body.require_payment && !body.api_key) {
    const action = str(body, "action_url") || "https://accountscenter.meta.com/muse_code/?ep=no_payg"
    throw new Error(`Muse Code requires a payment method or subscription — visit ${action}, then sign in again.`)
  }
  const apiKey = str(body, "api_key")
  if (!apiKey) throw new Error("Meta key mint response missing api_key")
  return {
    apiKey,
    baseUrl: normalizeBaseUrl(str(body, "base_url") || BASE),
    email: str(body, "user_email"),
    fullName: str(body, "user_full_name"),
    avatarUrl: str(body, "user_avatar_url"),
    subsActive: body.is_subs_active === true,
    tierId: str(body, "subs_tier_id"),
    tierName: str(body, "subs_tier_name"),
    upgradeAvailable: body.is_subs_upgrade_available === true,
    hasPaymentMethod: body.has_payment_method === true,
    requirePayment: body.require_payment === true,
    actionUrl: str(body, "action_url"),
    subsUsage: isObj(body.subs_usage) ? body.subs_usage : null,
  }
}

// ---- Account credential state ---------------------------------------------------

// Extract state from magpie / OpenCode's auth object (`{type: "oauth", ...}` or `{type: "api", key}`).
function stateOf(auth) {
  if (!isObj(auth)) return null
  if (auth.type === "api") {
    const key = str(auth, "key")
    if (!key) return null
    const profile = {
      baseUrl: normalizeBaseUrl(str(auth.metadata, "baseUrl") || BASE),
      email: str(auth, "accountId") || str(auth.metadata, "email"),
      fullName: str(auth.metadata, "fullName"),
      tierName: str(auth.metadata, "tierName"),
    }
    // Allow pasting either an `LLM|...` API key or a `dca:...` OAuth access token
    if (key.startsWith("dca:")) return { kind: "oauth", accessToken: key, apiKey: "", ...profile }
    return { kind: "api", accessToken: "", apiKey: key, ...profile }
  }
  if (auth.type === "oauth") {
    let extra = {}
    if (typeof auth.refresh === "string" && auth.refresh.startsWith("{")) {
      try {
        extra = JSON.parse(auth.refresh) ?? {}
      } catch {}
    }
    const accessRaw = str(auth, "access")
    const refreshRaw = typeof auth.refresh === "string" && !auth.refresh.startsWith("{") ? auth.refresh.trim() : ""
    const accessToken =
      str(extra, "accessToken") ||
      str(auth, "accessToken") ||
      (accessRaw.startsWith("dca:") ? accessRaw : refreshRaw.startsWith("dca:") ? refreshRaw : "")
    const apiKey =
      str(extra, "apiKey") ||
      str(auth, "apiKey") ||
      (accessRaw.startsWith("LLM|") ? accessRaw : !accessToken && accessRaw ? accessRaw : "")
    // Linked to the CLI's auth.json: the CLI may have signed in again, or minted a newer key, since
    const cli = extra.useCli ? readCliCredential(extra.cliPath || undefined) : null
    const accountId = str(auth, "accountId")
    return {
      kind: "oauth",
      accessToken: cli?.accessToken || accessToken,
      apiKey,
      cliApiKey: cli?.apiKey || "",
      baseUrl: normalizeBaseUrl(cli?.baseUrl || str(extra, "baseUrl") || str(auth, "baseUrl") || BASE),
      email: str(extra, "email") || cli?.email || (accountId.includes("@") ? accountId : ""),
      fullName: cli?.fullName || str(extra, "fullName"),
      tierName: str(extra, "tierName"),
      useCli: !!extra.useCli,
      cliPath: extra.cliPath || (extra.useCli ? cliAuthPath() : ""),
    }
  }
  return null
}

function packOAuthResult(minted, accessToken, opts = {}) {
  const who = minted.email || minted.fullName || opts.email || opts.fullName
  // An account Meta names no one for is told apart from another such by its
  // key's account id (magpie's uid), rather than both going as "Muse Code".
  const uid = who ? "" : (/^LLM\|(\d+)\|/.exec(minted.apiKey ?? "")?.[1] ?? "")
  const extra = {
    accessToken,
    apiKey: minted.apiKey,
    baseUrl: minted.baseUrl || BASE,
    email: minted.email || opts.email || "",
    fullName: minted.fullName || opts.fullName || "",
    tierName: minted.tierName || "",
    subsActive: minted.subsActive,
    ...(opts.useCli ? { useCli: true, cliPath: opts.cliPath || cliAuthPath() } : {}),
  }
  return {
    type: "success",
    // Keep the minted LLM|... key in `access` so OpenCode or direct callers have a
    // ready bearer key, and pack the OAuth token + metadata in `refresh` + top-level fields.
    access: minted.apiKey,
    refresh: JSON.stringify(extra),
    // Meta's sign-in can't be renewed (see the top of this file), so magpie has
    // nothing to schedule: the key is re-minted on demand when a request is refused.
    expires: 0,
    accountId: who || "Muse Code",
    ...(uid ? { uid } : {}),
    email: minted.email || opts.email || undefined,
    apiKey: minted.apiKey,
    accessToken,
    baseUrl: minted.baseUrl || BASE,
    tierName: minted.tierName || undefined,
  }
}

// ---- Keys per Meta sign-in --------------------------------------------------------

// latest is the newest key minted in this process for each Meta sign-in (access
// token at an API origin), so a sign-in that can't store its key (a pasted dca:
// token) and the requests racing on a refused key share one mint instead of
// each minting again. rejected are keys Meta refused; dead are sign-ins
// /muse-code/key turned away, not offered again for DEAD_TTL.
const latest = new Map() // token@origin → { apiKey, at, minted }
const rejected = new Set()
const dead = new Map() // token@origin → { at, error }
const inflightMints = new Map()

const tokenKey = (s) => `${s.accessToken}@${originOf(s.baseUrl)}`
const accountKeyOf = (s) => s.email || s.accessToken || s.apiKey

function refuse(key) {
  if (!key) return
  rejected.add(key)
  if (rejected.size > 256) rejected.delete(rejected.values().next().value)
}

// keyOf is the key a request on sign-in s should carry: the newest minted for it
// in this process, the CLI's, the stored one, whichever comes first that Meta
// hasn't refused. A key alone (no access token to mint another) is carried
// whatever it got.
function keyOf(s) {
  if (!s.accessToken) return s.apiKey
  const l = latest.get(tokenKey(s))
  for (const k of [l?.apiKey, s.cliApiKey, s.apiKey]) {
    if (k && !rejected.has(k)) return k
  }
  return ""
}

// mintFor mints a key for sign-in s, one mint at a time per sign-in. maxAge
// takes a mint that recent instead; retryDead asks again of a sign-in turned
// away lately (signing in again is the user asking).
async function mintFor(s, { maxAge = 0, retryDead = false } = {}) {
  const k = tokenKey(s)
  const l = latest.get(k)
  if (l && maxAge > 0 && Date.now() - l.at <= maxAge) return l.minted
  const d = dead.get(k)
  if (d && !retryDead && Date.now() - d.at < DEAD_TTL) throw d.error
  let job = inflightMints.get(k)
  if (!job) {
    job = mintKey(s.accessToken, originOf(s.baseUrl))
      .then(
        (minted) => {
          latest.set(k, { apiKey: minted.apiKey, at: Date.now(), minted })
          rejected.delete(minted.apiKey)
          dead.delete(k)
          return minted
        },
        (e) => {
          if (e?.refused) dead.set(k, { at: Date.now(), error: e })
          throw e
        },
      )
      .finally(() => inflightMints.delete(k))
    inflightMints.set(k, job)
  }
  return job
}

// adoptMinted is sign-in s on the key Meta just minted for it, written back to
// the CLI's auth.json when linked to it and kept with the sign-in (remember).
async function adoptMinted(s, minted, remember) {
  const updated = {
    ...s,
    apiKey: minted.apiKey,
    baseUrl: minted.baseUrl || s.baseUrl,
    email: minted.email || s.email,
    fullName: minted.fullName || s.fullName,
    tierName: minted.tierName || s.tierName,
  }
  if (s.useCli) saveCliCredential(minted, s.accessToken, s.cliPath || undefined)
  if (remember) await remember(updated, minted)
  return updated
}

// ready is sign-in s with the key a request should carry, minting one when it
// has none Meta hasn't refused (unless the one refused was minted moments ago).
async function ready(s, remember) {
  if (!s) throw new Error("Muse Code is not signed in; run `magpie plugin login muse`")
  const have = keyOf(s)
  if (have) return have === s.apiKey ? s : { ...s, apiKey: have }
  if (!s.accessToken) throw expired("Muse Code sign-in has expired; sign in again")
  const l = latest.get(tokenKey(s))
  if (l && Date.now() - l.at < MINT_FRESH) return { ...s, apiKey: l.apiKey }
  return adoptMinted(s, await mintFor(s), remember)
}

// replacement is another key for sign-in s than refused: one minted meanwhile
// (by another request or a usage read), else a new mint, unless refused was
// itself minted moments ago and Meta would hand it back (null).
async function replacement(s, refused, remember) {
  const have = keyOf(s)
  if (have && have !== refused) return { ...s, apiKey: have }
  const l = latest.get(tokenKey(s))
  if (l?.apiKey === refused && Date.now() - l.at < MINT_FRESH) return null
  return adoptMinted(s, await mintFor(s), remember)
}

// keyServes is whether Meta still takes key: true, false when it refuses it
// (401), null when that can't be told.
async function keyServes(s, key) {
  try {
    const headers = new Headers({ Accept: "application/json" })
    signHeaders(headers, key, "", "")
    const res = await fetch(`${originOf(s.baseUrl)}/muse-code/models`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(15_000),
    })
    await res.body?.cancel?.().catch(() => {})
    return res.ok ? true : res.status === 401 ? false : null
  } catch {
    return null
  }
}

// ---- Headers & request rewriting ------------------------------------------------

function isContributorModel(modelId) {
  return typeof modelId === "string" && modelId.endsWith("-contributor")
}

function signHeaders(headers, apiKey, modelId, sessionId) {
  headers.set("Authorization", `Bearer ${apiKey}`)
  headers.set("x-api-version", API_VERSION)
  headers.set("x-client-id", CLIENT_SURFACE)
  headers.set("User-Agent", USER_AGENT)
  if (isContributorModel(modelId)) {
    headers.set("x-tbh-contributor-mode", "1")
  }
  if (sessionId) {
    if (!headers.has("x-tbh-session-id")) headers.set("x-tbh-session-id", sessionId)
    if (!headers.has("x-meta-ai-gateway-session-id")) headers.set("x-meta-ai-gateway-session-id", sessionId)
  }
}

function bodyText(body) {
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return new TextDecoder().decode(body)
  return body
}

// functionOfCustom is a freeform tool (Codex's apply_patch: {type: "custom",
// name, description, format}) as a function tool taking its text as `input`,
// since Meta's endpoint takes no custom tools.
function functionOfCustom(t) {
  const format = isObj(t.format) ? t.format : {}
  const grammar = format.type === "grammar" && typeof format.definition === "string" ? format.definition.trim() : ""
  const description = [
    typeof t.description === "string" ? t.description.trim() : "",
    "Pass the tool's raw input as the single string argument `input` (the text itself, not JSON).",
    grammar ? `The input must match this ${str(format, "syntax") || "grammar"} grammar:\n${grammar}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
  return {
    type: "function",
    name: t.name,
    description,
    parameters: {
      type: "object",
      properties: { input: { type: "string", description: "The tool's raw input." } },
      required: ["input"],
      additionalProperties: false,
    },
    strict: false,
  }
}

// applyDefaults fills in what the model's defaults d ask of a request that
// doesn't say (the reasoning effort, `include`), and puts the effort a variant
// stands for in place of its name. It says whether it changed m.
function applyDefaults(m, isChat, d) {
  if (!isObj(d) || d.reasoning === false) return false
  let dirty = false
  const effortOf = (name) => str(d.variants?.[name], "reasoningEffort") || name
  const fallback = str(d.options, "reasoningEffort")
  if (isChat) {
    if (typeof m.reasoning_effort === "string" && m.reasoning_effort) {
      const e = effortOf(m.reasoning_effort)
      if (e !== m.reasoning_effort) {
        m.reasoning_effort = e
        dirty = true
      }
    } else if (fallback) {
      m.reasoning_effort = fallback
      dirty = true
    }
    return dirty
  }
  const r = isObj(m.reasoning) ? m.reasoning : null
  if (typeof r?.effort === "string" && r.effort) {
    const e = effortOf(r.effort)
    if (e !== r.effort) {
      m.reasoning = { ...r, effort: e }
      dirty = true
    }
  } else if (fallback) {
    m.reasoning = { ...(r ?? {}), effort: fallback }
    dirty = true
  }
  const want = Array.isArray(d.options?.include) ? d.options.include.filter((x) => typeof x === "string" && x) : []
  const have = Array.isArray(m.include) ? m.include : []
  const add = want.filter((x) => !have.includes(x))
  if (add.length) {
    m.include = [...have, ...add]
    dirty = true
  }
  return dirty
}

// Rewrites an OpenAI Responses or Chat Completions request body for Meta's endpoint:
//   1. `tool_choice`: Meta's /v1/responses only accepts `"auto"` (or omitted when no tools).
//      `"required"`, `"none"`, or `{type: "function", name: "..."}` are rejected with 400.
//   2. `tools`: Codex's freeform `custom` tools become function tools (their names
//      come back as `customTools`, for customBody to turn their calls back);
//      other unsupported tool types (`local_shell`, `shell`, etc.) are dropped, and
//      `external_web_access` is removed.
//   3. `input`: Converts Codex's `agent_message` items to standard `message` items and
//      `custom_tool_call(_output)` items to `function_call(_output)` so Meta's strict
//      input union parser accepts them, and drops unreferenced `reasoning` items without
//      `encrypted_content` (from other providers) that Meta would reject as not found.
//   4. The model's defaults the request doesn't set (applyDefaults), from defaultsOf(model).
function rewrite(body, url = "", defaultsOf = () => undefined) {
  const none = { body, model: "", sessionId: "", customTools: new Set() }
  if (typeof body !== "string" || !body.trim()) return none
  let m
  try {
    m = JSON.parse(body)
  } catch {
    return none
  }
  if (!isObj(m)) return none

  const model = typeof m.model === "string" ? m.model : ""
  const sessionId = typeof m.prompt_cache_key === "string" ? m.prompt_cache_key : ""
  const isChat = String(url).includes("/chat/completions")
  const customTools = new Set()
  let dirty = false

  if (Array.isArray(m.tools)) {
    const before = m.tools.length
    m.tools = m.tools
      .map((t) => {
        if (!isChat && isObj(t) && t.type === "custom" && typeof t.name === "string" && t.name) {
          customTools.add(t.name)
          dirty = true
          return functionOfCustom(t)
        }
        return t
      })
      .filter((t) => isObj(t) && ALLOWED_TOOLS.has(t.type))
    for (const t of m.tools) {
      if ("external_web_access" in t) {
        delete t.external_web_access
        dirty = true
      }
    }
    if (m.tools.length !== before) dirty = true
    if (m.tools.length === 0) {
      delete m.tools
      if ("tool_choice" in m) delete m.tool_choice
      dirty = true
    }
  }

  // Meta's /v1/responses only supports `"auto"` for `tool_choice` (#5190 in muse binary).
  if ("tool_choice" in m) {
    if (m.tool_choice === "none") {
      delete m.tools
      delete m.tool_choice
      dirty = true
    } else if (!Array.isArray(m.tools) || m.tools.length === 0) {
      delete m.tool_choice
      dirty = true
    } else if (m.tool_choice !== "auto") {
      m.tool_choice = "auto"
      dirty = true
    }
  }

  if (!isChat && Array.isArray(m.input)) {
    const nextInput = []
    let inputDirty = false
    for (const it of m.input) {
      if (!isObj(it)) {
        nextInput.push(it)
        continue
      }
      // Convert Codex collaboration `agent_message` into standard user message
      if (
        it.type === "agent_message" &&
        !Object.hasOwn(it, "encrypted_content") &&
        Array.isArray(it.content) &&
        it.content.length > 0
      ) {
        const from = typeof it.author === "string" ? it.author : ""
        const to = typeof it.recipient === "string" ? it.recipient : ""
        const header = from && to ? `From ${from} to ${to}` : from ? `From ${from}` : to ? `To ${to}` : ""
        inputDirty = true
        nextInput.push({
          type: "message",
          role: "user",
          content: header ? [{ type: "input_text", text: `${header}\n\n` }, ...it.content] : it.content,
        })
        continue
      }
      // Codex's freeform tool calls and their results, as the function calls
      // their tools are sent as (ids left out: Meta may not know them)
      if (it.type === "custom_tool_call") {
        inputDirty = true
        nextInput.push({
          type: "function_call",
          call_id: it.call_id,
          name: it.name,
          arguments: JSON.stringify({ input: typeof it.input === "string" ? it.input : "" }),
          ...(typeof it.status === "string" ? { status: it.status } : {}),
        })
        continue
      }
      if (it.type === "custom_tool_call_output") {
        inputDirty = true
        nextInput.push({ type: "function_call_output", call_id: it.call_id, output: it.output })
        continue
      }
      // Reasoning items without encrypted_content (e.g. from another provider or plain summary)
      // fail on Meta with "Referenced reasoning item 'rs_...' was not found or has expired."
      if (it.type === "reasoning") {
        if (typeof it.encrypted_content !== "string" || !it.encrypted_content) {
          inputDirty = true
          continue
        }
        if ("content" in it && it.content === null) {
          const clean = { ...it }
          delete clean.content
          inputDirty = true
          nextInput.push(clean)
          continue
        }
      }
      nextInput.push(it)
    }
    if (inputDirty) {
      m.input = nextInput
      dirty = true
    }
  }

  if (model && applyDefaults(m, isChat, defaultsOf(model))) dirty = true

  return {
    body: dirty ? JSON.stringify(m) : body,
    model,
    sessionId,
    customTools,
  }
}

// ---- Codex freeform tools in replies ----------------------------------------------

// inputOf is a function call's arguments as its freeform tool's input: the
// `input` the model filled in, else the arguments as they came.
function inputOf(args) {
  if (typeof args !== "string") return ""
  try {
    const v = JSON.parse(args)
    if (typeof v === "string") return v
    if (isObj(v)) {
      if (typeof v.input === "string") return v.input
      const texts = Object.values(v).filter((x) => typeof x === "string")
      if (texts.length === 1) return texts[0]
    }
  } catch {}
  return args
}

// toCustomCall is a function call to one of the freeform tools names as the
// custom_tool_call Codex expects, or null for any other item.
function toCustomCall(item, names) {
  if (!isObj(item) || item.type !== "function_call" || !names.has(item.name)) return null
  const { arguments: args, ...rest } = item
  return { ...rest, type: "custom_tool_call", input: inputOf(args) }
}

// customOutput turns the calls in a whole response's output, saying whether it changed any.
function customOutput(response, names) {
  if (!isObj(response) || !Array.isArray(response.output)) return false
  let changed = false
  response.output = response.output.map((it) => {
    const c = toCustomCall(it, names)
    if (c) changed = true
    return c ?? it
  })
  return changed
}

// customEvent is one Responses stream event with the calls of freeform tools
// put back as Codex sent the tools (custom_tool_call); null drops it. ids are
// the items made custom so far in the stream.
function customEvent(ev, names, ids) {
  switch (ev?.type) {
    case "response.output_item.added":
    case "response.output_item.done": {
      const item = toCustomCall(ev.item, names)
      if (!item) return ev
      if (typeof item.id === "string") ids.add(item.id)
      return { ...ev, item }
    }
    case "response.function_call_arguments.delta":
      // the input goes whole with .done: these are pieces of the JSON around it
      return ids.has(ev.item_id) ? null : ev
    case "response.function_call_arguments.done": {
      if (!ids.has(ev.item_id)) return ev
      const { type: _t, arguments: args, ...rest } = ev
      return { type: "response.custom_tool_call_input.done", ...rest, input: inputOf(args) }
    }
    default: {
      if (!isObj(ev?.response)) return ev
      const response = { ...ev.response }
      return customOutput(response, names) ? { ...ev, response } : ev
    }
  }
}

// sseMap passes a server-sent event stream through, handing map each event
// whose data mentions `mention` and parses as JSON: what map returns is sent in
// its place (null drops it); everything else goes as it came.
function sseMap(body, map, mention) {
  const dec = new TextDecoder()
  const enc = new TextEncoder()
  let buf = ""
  const event = (raw) => {
    const lines = raw.split("\n")
    const data = lines
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(l.startsWith("data: ") ? 6 : 5))
      .join("\n")
    if (!data.includes(mention)) return raw + "\n\n"
    let ev
    try {
      ev = JSON.parse(data)
    } catch {
      return raw + "\n\n"
    }
    const out = map(ev)
    if (out === ev) return raw + "\n\n"
    if (!out) return ""
    const named = lines.some((l) => l.startsWith("event:"))
    const rest = lines.filter((l) => !l.startsWith("data:") && !l.startsWith("event:"))
    return [...rest, ...(named ? [`event: ${out.type}`] : []), `data: ${JSON.stringify(out)}`].join("\n") + "\n\n"
  }
  return body.pipeThrough(
    new TransformStream({
      transform(chunk, ctl) {
        buf = (buf + dec.decode(chunk, { stream: true })).replace(/\r\n/g, "\n")
        let out = ""
        for (let i; (i = buf.indexOf("\n\n")) >= 0; ) {
          out += event(buf.slice(0, i))
          buf = buf.slice(i + 2)
        }
        if (out) ctl.enqueue(enc.encode(out))
      },
      flush(ctl) {
        buf = (buf + dec.decode()).replace(/\r\n/g, "\n")
        if (buf.trim()) ctl.enqueue(enc.encode(event(buf.replace(/\n+$/, ""))))
      },
    }),
  )
}

// customBody is the body of Meta's reply with the calls of the request's
// freeform tools turned back into custom_tool_call items, streamed or whole.
async function customBody(res, names) {
  const type = res.headers.get("content-type") ?? ""
  if (type.includes("text/event-stream")) {
    const ids = new Set()
    return sseMap(res.body, (ev) => customEvent(ev, names, ids), "function_call")
  }
  if (!type.includes("json")) return res.body
  const text = await res.text()
  try {
    const v = JSON.parse(text)
    return customOutput(v, names) ? JSON.stringify(v) : text
  } catch {
    return text
  }
}

// ---- Models discovery (`/muse-code/models` & `/v1/models`) ----------------------

function parseMuseCodeModels(payload) {
  const list = Array.isArray(payload?.data) ? payload.data : []
  const out = []
  for (const item of list) {
    if (!isObj(item) || typeof item.id !== "string" || !item.id.trim()) continue
    const id = item.id.trim()
    const meta = isObj(item.metadata?.["muse-code"]) ? item.metadata["muse-code"] : null
    if (meta?.is_hidden === true) continue
    // Skip non-text / transcribe-only models in the general chat/responses catalog
    const outMods = Array.isArray(meta?.modalities?.output) ? meta.modalities.output : ["text"]
    if (!outMods.includes("text")) continue
    if (id.includes("voice-transcribe") || id.startsWith("sam-")) continue

    const rawVariants = isObj(meta?.variants) ? meta.variants : null
    const efforts = rawVariants
      ? Object.keys(rawVariants).filter((k) => isObj(rawVariants[k]))
      : id.startsWith("muse-spark-1.2")
        ? EFFORTS_XHIGH
        : EFFORTS_MAX

    const variants = {}
    for (const e of efforts) {
      const v = rawVariants?.[e]
      variants[e] = { reasoningEffort: str(v, "reasoningEffort") || e }
    }

    const inputMods = Array.isArray(meta?.modalities?.input) ? meta.modalities.input : ["text", "image"]
    const hasImage = inputMods.includes("image") || meta?.attachment !== false
    const context = num(meta?.limit?.context) ?? 1007997
    const output = num(meta?.limit?.output) ?? 128000

    out.push({
      id,
      name: str(meta, "name") || id,
      releaseDate: str(meta, "release_date"),
      description: str(meta, "description"),
      reasoning: meta?.reasoning !== false,
      temperature: meta?.temperature === true,
      toolCall: meta?.tool_call !== false,
      attachment: hasImage,
      inputModalities: inputMods,
      outputModalities: outMods,
      context,
      output,
      options: isObj(meta?.options) ? meta.options : { reasoningEffort: "high", include: ["reasoning.encrypted_content"] },
      variants,
    })
  }
  return out
}

async function fetchModelsForAccount(s, remember) {
  let cur = await ready(s, remember)
  const list = (c) => {
    const headers = new Headers({ Accept: "application/json" })
    signHeaders(headers, c.apiKey, "", "")
    return fetch(`${originOf(c.baseUrl)}/muse-code/models`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(15_000),
    })
  }

  let res = await list(cur)

  // A refused key: one minted meanwhile, or a new one, and the list asked again.
  if ((res.status === 401 || res.status === 403) && cur.accessToken) {
    if (res.status === 401) refuse(cur.apiKey)
    const next = await replacement(cur, cur.apiKey, remember)
    if (next?.apiKey && next.apiKey !== cur.apiKey) {
      await res.body?.cancel?.().catch(() => {})
      cur = next
      res = await list(cur)
    }
  }

  if (res.status === 401) {
    if (cur.accessToken) refuse(cur.apiKey)
    throw expired("Muse Code refused the sign-in; sign in again")
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`Muse Code models: HTTP ${res.status} ${text.slice(0, 200)}`.trim())
  }

  const parsed = parseMuseCodeModels(await res.json())
  if (!parsed.length) throw new Error("Muse Code listed no visible models")
  return { models: parsed, baseUrl: cur.baseUrl }
}

// listed is each account's model list as Meta last gave it (or the failure it
// last met), by its token or key at its origin; listing are the lists being asked for.
const listed = new Map()
const listing = new Map()

async function modelsFor(s, remember) {
  const k = `${s.accessToken || s.apiKey}@${originOf(s.baseUrl)}`
  const c = listed.get(k)
  if (c && Date.now() - c.at < (c.error ? LIST_FAILED_FRESH : MODELS_FRESH)) {
    if (c.error) throw c.error
    return c.list
  }
  let job = listing.get(k)
  if (!job) {
    job = fetchModelsForAccount(s, remember)
      .then(
        (list) => {
          listed.set(k, { at: Date.now(), list })
          return list
        },
        (error) => {
          listed.set(k, { at: Date.now(), error })
          throw error
        },
      )
      .finally(() => listing.delete(k))
    listing.set(k, job)
  }
  return job
}

// ---- Usage & Rate-limit tracking (`POST /muse-code/key` -> `subs_usage`) --------

const limited = new Map()

function resetOf(headers, now) {
  const ra = headers?.get?.("retry-after")
  if (ra) {
    const n = Number(ra)
    if (Number.isFinite(n) && n >= 0) return now + n * 1000
    const d = Date.parse(ra)
    if (!Number.isNaN(d)) return d
  }
  if (headers && typeof headers[Symbol.iterator] === "function") {
    for (const [k, v] of headers) {
      if (!/ratelimit.*reset/i.test(k)) continue
      const n = Number(v)
      if (!Number.isFinite(n) || n < 0) continue
      if (n > 1e12) return n
      if (n > 1e9) return n * 1000
      return now + n * 1000
    }
  }
  return 0
}

function noteRateLimit(accountKey, res, now = Date.now()) {
  if (!accountKey) return
  if (res.status === 429) limited.set(accountKey, { at: now, until: resetOf(res.headers, now) })
  else if (res.ok) limited.delete(accountKey)
}

function rateWindow(accountKey, now = Date.now()) {
  if (!accountKey) return []
  const l = limited.get(accountKey)
  if (!l) return []
  if (l.until ? l.until <= now : now - l.at >= HOLD_MS) {
    limited.delete(accountKey)
    return []
  }
  const end = l.until || l.at + HOLD_MS
  return [{ name: "Rate limit", used: 100, resetsAt: new Date(end).toISOString(), aside: true }]
}

function toIsoReset(val) {
  if (typeof val === "number" && Number.isFinite(val) && val > 0) {
    return new Date(val > 1e12 ? val : val * 1000).toISOString()
  }
  if (typeof val === "string" && val.trim()) {
    const n = Number(val)
    if (Number.isFinite(n) && n > 0) return new Date(n > 1e12 ? n : n * 1000).toISOString()
    const d = Date.parse(val)
    if (!Number.isNaN(d)) return new Date(d).toISOString()
  }
  return undefined
}

function formatWindowName(mins) {
  if (!mins || mins <= 0) return "Window"
  if (mins % 60 === 0) {
    const hrs = mins / 60
    return hrs === 1 ? "1 hour" : `${hrs} hours`
  }
  return `${mins} mins`
}

function usageFromMinted(minted, accountKey) {
  const windows = [...rateWindow(accountKey)]
  const su = minted?.subsUsage
  if (isObj(su)) {
    if (isObj(su.window)) {
      const mins = num(su.window.window_duration_mins) ?? 300
      const resetsAt = toIsoReset(su.window.resets_at)
      windows.push({
        name: formatWindowName(mins),
        used: num(su.window.used_percent) ?? 0,
        span: mins * 60,
        ...(resetsAt ? { resetsAt } : {}),
      })
    }
    if (isObj(su.weekly)) {
      const resetsAt = toIsoReset(su.weekly.resets_at)
      windows.push({
        name: "7 days",
        used: num(su.weekly.used_percent) ?? 0,
        span: 7 * 24 * 3600,
        ...(resetsAt ? { resetsAt } : {}),
      })
    }
  }
  const plan = minted.tierName || (minted.subsActive ? "Muse Code" : "No plan")
  const user = minted.email || minted.fullName || undefined
  const out = {
    plan,
    ...(user ? { user } : {}),
    windows,
    signIn: "kept",
  }
  if (!minted.subsActive && minted.requirePayment) {
    out.error = "Muse Code subscription or payment method required"
  }
  return out
}

function keptResponse(res, signIn = "kept", body = res.body) {
  const headers = new Headers(res.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  headers.set("X-Magpie-Sign-In", signIn)
  return new Response(body, {
    status: res.status,
    statusText: res.statusText || STATUS_CODES[res.status] || "",
    headers,
  })
}

// ---- Login methods --------------------------------------------------------------

async function authorizeDevice() {
  const d = await startDeviceCode()
  return {
    url: d.url,
    instructions: `Confirm code ${d.userCode} in your browser to sign in to Meta One / Muse Code.`,
    method: "auto",
    async callback() {
      try {
        const tok = await pollDeviceToken(d)
        const minted = await mintFor({ accessToken: tok.accessToken, baseUrl: BASE })
        return packOAuthResult(minted, tok.accessToken)
      } catch (e) {
        return { type: "failed", error: String(e?.message ?? e).slice(0, 500) }
      }
    },
  }
}

async function authorizeCliCurrent() {
  const path = cliAuthPath()
  const c = readCliCredential(path)
  if (!c) {
    throw new Error(`Muse Code CLI is not signed in at ${path}; run \`muse login\` first or use Device Code sign-in`)
  }
  if (c.accessToken) {
    // Signing in asks again of a sign-in turned away lately: `muse login` or onboarding may have mended it.
    const minted = await mintFor(c, { retryDead: true })
    saveCliCredential(minted, c.accessToken, path)
    const who = minted.email || minted.fullName || c.email || c.fullName || "Muse Code account"
    return {
      url: "",
      instructions: `Using Muse Code CLI sign-in (${who}).`,
      method: "auto",
      async callback() {
        return packOAuthResult(minted, c.accessToken, {
          email: c.email,
          fullName: c.fullName,
          useCli: true,
          cliPath: path,
        })
      },
    }
  }
  const who = c.email || c.fullName || "Muse Code API key"
  return {
    url: "",
    instructions: `Using Muse Code CLI API key (${who}).`,
    method: "auto",
    async callback() {
      return {
        type: "success",
        key: c.apiKey,
        accountId: who,
        metadata: { baseUrl: c.baseUrl, email: c.email, fullName: c.fullName },
      }
    },
  }
}

// ---- Plugin export --------------------------------------------------------------

export const MuseAuthPlugin = async ({ client } = {}) => {
  // remember keeps a newly minted key and profile with the sign-in, as magpie or
  // OpenCode stores it (OAuth sign-ins only: a pasted key or token stays as pasted).
  const remember = async (auth, updated, minted) => {
    if (!client?.auth?.set || !isObj(auth) || auth.type !== "oauth" || !minted) return
    try {
      const next = packOAuthResult(minted, updated.accessToken, {
        email: updated.email,
        fullName: updated.fullName,
        useCli: updated.useCli,
        cliPath: updated.cliPath,
      })
      delete next.type
      const body = { ...auth, ...next, type: "oauth" }
      if (!next.uid) delete body.uid
      await client.auth.set({ path: { id: PROVIDER }, body })
    } catch {}
  }

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      const was = cfg.provider[PROVIDER] ?? {}
      cfg.provider[PROVIDER] = {
        name: "Meta One (Muse Code)",
        npm: NPM,
        api: BASE,
        searches: true,
        ...was,
        models: {
          ...DEFAULT_MODELS,
          ...(was.models ?? {}),
        },
      }
    },

    "chat.headers": async (input, output) => {
      if (input?.model?.providerID === PROVIDER && input?.sessionID) {
        output.headers["x-tbh-session-id"] = input.sessionID
        output.headers["x-meta-ai-gateway-session-id"] = input.sessionID
      }
    },

    auth: {
      provider: PROVIDER,
      icon: ICON,
      maxConcurrency: 8,

      methods: [
        {
          type: "oauth",
          label: "Sign in with Meta account (device code)",
          authorize: authorizeDevice,
        },
        {
          type: "oauth",
          label: "Use Muse Code CLI's current sign-in (~/.config/muse/auth.json)",
          authorize: authorizeCliCurrent,
        },
        {
          type: "api",
          label: "Meta Model API key (LLM|… or dca:…)",
          placeholder: "LLM|…",
        },
      ],

      async loader(getAuth, provider) {
        const initial = stateOf(await getAuth())
        if (!initial) return {}
        for (const [id, m] of Object.entries(provider?.models ?? {})) noteModel(m?.api?.id || id, m)
        return {
          baseURL: initial.baseUrl || BASE,
          apiKey: "muse",
          async fetch(input, init) {
            const rawAuth = await getAuth()
            const s0 = stateOf(rawAuth)
            if (!s0) throw expired("Muse Code is not signed in; run `magpie plugin login muse`")
            const keep = (u, m) => remember(rawAuth, u, m)

            const req = new Request(input, init)
            const rawBody = bodyText(init?.body ?? (input instanceof Request ? await input.clone().text() : undefined))
            const { body, model, sessionId, customTools } = rewrite(rawBody, req.url, (id) => modelDefaults.get(id))

            let s = await ready(s0, keep)

            const sendOnce = async (cred) => {
              const headers = new Headers(init?.headers ?? req.headers)
              signHeaders(headers, cred.apiKey, model, sessionId)
              headers.delete("content-length")
              return fetch(req.url, {
                ...init,
                method: init?.method ?? req.method,
                headers,
                body,
                signal: init?.signal ?? req.signal,
              })
            }

            let res = await sendOnce(s)
            let renewed = false
            let unsure = false

            // A refused key (401, or a 403 that may be about the key): unless another
            // request minted a newer one meanwhile, or this one was minted moments
            // ago, mint once more with the sign-in's access token and retry.
            if ((res.status === 401 || res.status === 403) && s.accessToken) {
              if (res.status === 401) refuse(s.apiKey)
              let next = null
              try {
                next = await replacement(stateOf(await getAuth()) ?? s0, s.apiKey, keep)
              } catch (e) {
                if (res.status === 401 && e?.signIn === "expired") {
                  await res.body?.cancel?.().catch(() => {})
                  return keptResponse(
                    new Response(
                      JSON.stringify({
                        error: {
                          message: e.message,
                          type: "authentication_error",
                          code: "invalid_api_key",
                        },
                      }),
                      { status: 401, headers: { "content-type": "application/json" } },
                    ),
                    "expired",
                  )
                }
                // Meta couldn't be asked for a key (or a 403 the sign-in can't
                // mend): its answer stands, and says nothing of the sign-in.
                unsure = true
              }
              if (next?.apiKey && next.apiKey !== s.apiKey) {
                await res.body?.cancel?.().catch(() => {})
                s = next
                res = await sendOnce(s)
                renewed = true
              }
            }

            noteRateLimit(accountKeyOf(s), res)

            // Refused, and no other key to be had: signing in again is what's left.
            if (res.status === 401 && !unsure) {
              if (s.accessToken) refuse(s.apiKey)
              return keptResponse(res, "expired")
            }
            const out = customTools.size && res.ok ? await customBody(res, customTools) : res.body
            return keptResponse(res, renewed && res.ok ? "renewed" : "kept", out)
          },
        }
      },

      async usage(getAuth) {
        const rawAuth = await getAuth()
        const s = stateOf(rawAuth)
        if (!s) return { error: "not signed in", windows: [], signIn: "kept" }
        const acctKey = accountKeyOf(s)

        if (s.accessToken) {
          try {
            // `/muse-code/key` is where the allowance is told; a mint this recent is read again instead
            const minted = await mintFor(s, { maxAge: USAGE_FRESH })
            await adoptMinted(s, minted, (u, m) => remember(rawAuth, u, m))
            return usageFromMinted(minted, acctKey)
          } catch (e) {
            const windows = rateWindow(acctKey)
            const said = String(e?.message ?? e)
            if (!e?.refused) return { error: said, windows, signIn: e?.signIn === "expired" ? "expired" : "kept" }
            // Meta turned the sign-in away, but the key minted with it may still
            // serve: the account is marked only when that is refused too.
            const key = keyOf(s)
            const serves = key ? await keyServes(s, key) : false
            if (serves === false) return { error: said, windows, signIn: "expired" }
            const user = s.email || s.fullName
            return {
              plan: s.tierName || "Muse Code",
              ...(user ? { user } : {}),
              windows,
              signIn: "kept",
              error: serves
                ? "Meta sign-in expired: requests still work on the current key, but sign in again (magpie plugin login muse) so a new key can be issued when Meta replaces it"
                : said,
            }
          }
        }

        // Plain API-key login (`LLM|...` without OAuth `dca:...` token):
        // `/muse-code/key` requires the OAuth token, so report API key status + any rate-limit window.
        return {
          plan: s.tierName || "API key",
          ...(s.email ? { user: s.email } : {}),
          windows: rateWindow(acctKey),
          signIn: "kept",
        }
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        const have = provider?.models ?? DEFAULT_MODELS
        const s = stateOf(auth)
        if (!s) return have

        const { models, baseUrl } = await modelsFor(s, (u, m) => remember(auth, u, m))
        const base = have["muse-wonder-1.0"] ?? Object.values(have)[0] ?? {}
        const out = {}

        for (const m of models) {
          const was = have[m.id] ?? base
          out[m.id] = {
            ...was,
            id: m.id,
            providerID: provider?.id ?? PROVIDER,
            name: m.name,
            api: {
              ...(was.api ?? {}),
              id: m.id,
              url: baseUrl || BASE,
              npm: NPM,
            },
            status: "active",
            limit: {
              ...(was.limit ?? {}),
              context: m.context || was.limit?.context || 1007997,
              output: m.output || was.limit?.output || 128000,
            },
            options: {
              ...(was.options ?? {}),
              ...(m.options ?? {}),
            },
            capabilities: {
              ...(was.capabilities ?? {}),
              temperature: m.temperature,
              reasoning: m.reasoning,
              attachment: m.attachment,
              toolcall: m.toolCall,
              input: {
                ...(was.capabilities?.input ?? {}),
                text: m.inputModalities.includes("text"),
                image: m.inputModalities.includes("image"),
                audio: false,
                video: false,
                pdf: false,
              },
              output: {
                ...(was.capabilities?.output ?? {}),
                text: m.outputModalities.includes("text"),
                image: m.outputModalities.includes("image"),
                audio: false,
                video: false,
                pdf: false,
              },
            },
            release_date: m.releaseDate || was.release_date || "",
            variants: m.variants,
          }
          noteModel(m.id, out[m.id])
        }
        return out
      },
    },
  }
}

export const _internal = {
  PROVIDER,
  NPM,
  AUTH_ORIGIN,
  API_ORIGIN,
  BASE,
  CLIENT_ID,
  DEFAULT_MODELS,
  ALLOWED_TOOLS,
  MINT_FRESH,
  USAGE_FRESH,
  cliAuthPath,
  readCliCredential,
  saveCliCredential,
  replaceFile,
  startDeviceCode,
  pollDeviceToken,
  mintKey,
  mintFor,
  stateOf,
  packOAuthResult,
  keyOf,
  ready,
  replacement,
  signHeaders,
  rewrite,
  applyDefaults,
  customEvent,
  customBody,
  parseMuseCodeModels,
  fetchModelsForAccount,
  listed,
  usageFromMinted,
  resetOf,
  modelDefaults,
  latest,
  rejected,
  limited,
  HOLD_MS,
  noteRateLimit,
  rateWindow,
  // reset forgets everything this module keeps between calls (for tests)
  reset() {
    limited.clear()
    latest.clear()
    rejected.clear()
    dead.clear()
    inflightMints.clear()
    listed.clear()
    listing.clear()
    modelDefaults.clear()
    noteDefaultModels()
  },
}
