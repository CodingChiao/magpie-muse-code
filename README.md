# magpie-muse-code

Meta One / Muse Code（`muse` CLI）订阅的 magpie / OpenCode 供应商插件。Provider id：`muse`，模型写作 `muse/<model>`。

## 登录方式

- **Sign in with Meta account (device code)**：和 `muse login` 相同的 OIDC 设备码登录（`auth.meta.com`，client_id `1031625952748946`），拿到 `dca:…` access token 后在 `POST https://api.meta.ai/muse-code/key` 换取 Model API key（`LLM|…`）。轮询时遇到断网、超时或 5xx 会退避重试，直到设备码过期。
- **Use Muse Code CLI's current sign-in**：读取 `muse login` 保存的凭据：`$MUSE_AUTH_PATH`，否则 `$XDG_CONFIG_HOME/muse/auth.json`，否则 `~/.config/muse/auth.json`。CLI 之后重新登录或换了 key，插件会跟着用新的。插件换到的新 key 会写回该文件，CLI 继续可用：只在内容有变化时写；CLI 已重新登录、或文件在写入期间被改过时不覆盖；Windows 上文件被占用会重试，失败也不会留下含 key 的临时文件。
- **Meta Model API key**：直接粘贴 `LLM|…`（或 `dca:…` token；用 token 时换到的 key 缓存在进程内，不会每个请求都换一次）。

登录信息存在 magpie 的 `plugin-auth.json`。

### 登录有效期

Meta 的设备码登录无法自动续期：`/oidc/device/token/` 不接受 `refresh_token` grant（2026-10-17 实测返回 404），所以插件不向 magpie 申报过期时间（`expires: 0`），也不提供 `auth.refresh`。access token 失效后，已换到的 `LLM|` key 仍可继续出请求；用量里会提示重新登录，只有 key 本身也被拒时才把账号标为需要重新登录。

## 请求

走 OpenAI Responses API（`@ai-sdk/openai`），`https://api.meta.ai/v1/responses`，带 CLI 同款请求头：

- `Authorization: Bearer LLM|…`
- `x-api-version: 1.0.0`、`x-client-id: tbh:cli`、`User-Agent: muse-build/0.1.0`
- `*-contributor` 模型加 `x-tbh-contributor-mode: 1`
- 会话 id（`prompt_cache_key` / magpie sessionID）写入 `x-tbh-session-id`、`x-meta-ai-gateway-session-id`

key 被拒时：

- 401：已有其他请求换到新 key 就直接用它重试，否则用 access token 换一次 key 再重试（回复带 `X-Magpie-Sign-In: renewed`）。重试后仍是 401，或换不到 key，就标记 `expired`；换 key 时连不上 Meta 则不标记。
- 403：同样换一次 key 重试；仍是 403 就原样返回，按权限或套餐问题处理，不标记登录失效。
- 30 秒内刚换到的 key 再被拒时不会重复换（Meta 只会给回同一个）。

Meta 端点不接受的内容会被改写：

- `tool_choice` 只支持 `"auto"`：其他值改成 `auto`，`none` 则去掉工具
- Codex 的 freeform 工具（`custom`，如 `apply_patch`）改成只有一个字符串参数 `input` 的 function 工具；历史里的 `custom_tool_call(_output)` 转成 `function_call(_output)`；回复中对这些工具的调用再转回 `custom_tool_call`（流式和非流式都支持）
- 去掉其他不支持的工具类型（`local_shell`、`shell` 等）和 `external_web_access`
- Codex 的 `agent_message` 转成普通 user 消息
- 没有 `encrypted_content` 的 reasoning 条目（来自其他供应商）丢弃，`content: null` 删除
- 请求没指定时，补上模型默认的推理档位（`reasoning.effort`，如 `high`）和 `include`（`reasoning.encrypted_content`），并把 variant 名换成它对应的档位。magpie 只把 variant 名传给网关；在 OpenCode 里这些本来由 AI SDK 设置，这一步不会改动什么

## 模型

登录后从 `GET https://api.meta.ai/muse-code/models` 拉取（隐藏和非文本输出模型被过滤），未登录时内置：
`muse-wonder-1.0`、`muse-spark-1.3`、`muse-spark-1.2` 及其 `-contributor` 版本。推理档位来自接口的 `variants`（minimal…max）。

## 用量

`auth.usage` 读取 `/muse-code/key` 返回的 `subs_usage`（这是唯一的用量来源）：5 小时窗口和 7 天窗口，套餐名为 `subs_tier_name`。60 秒内的重复读取共用同一次结果；被 Meta 拒绝的 access token 10 分钟内不会再拿去换 key。遇到 429 时额外显示 “Rate limit” 窗口。

## 使用

```sh
magpie plugin add github:CodingChiao/magpie-muse-code
magpie plugin login muse          # 选择登录方式
magpie provider test muse muse-spark-1.3
magpie quota
```

之后任何接入 magpie 网关的 agent 都可以用 `muse/muse-wonder-1.0` 等模型（OpenAI Chat / Responses / Anthropic Messages 均由网关转换）。

## 测试

```sh
bun test            # 插件在 magpie 里跑在 Bun 上
npm run test:node   # 没有 Bun 时：Node 20.6+ 通过 test/node 下的 bun:test 兼容层跑同一套测试
```
