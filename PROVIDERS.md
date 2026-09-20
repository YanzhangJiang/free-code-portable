# Provider 配置与切换

本分支可以同时配置多个模型服务，在会话中通过 `/provider` 或 `/model` 切换，也可以为子 Agent 指定另一个 provider。服务地址、认证、协议和模型能力分别配置；模型的远端 ID 原样发送，不会因为名称陌生而改成另一个模型。

联网搜索、网页读取和语音使用独立配置，见 [EXTERNAL_SERVICES.md](EXTERNAL_SERVICES.md)。可选的真实模型任务评测见 [PROVIDER_EVALUATION.md](PROVIDER_EVALUATION.md)。这些能力不再要求语言模型本身来自 Anthropic，但仍需要对应的本地程序或服务端实现。

## 支持的协议

| `api` | 用途 | 认证和地址 |
|---|---|---|
| `anthropic` | Anthropic Messages API 或兼容网关 | `baseURL` + `apiKeyEnv`；使用 `x-api-key` |
| `openai-completions` | OpenAI Chat Completions 兼容服务，包括本地服务 | `baseURL` + `apiKeyEnv`；使用 Bearer token |
| `openai-responses` | OpenAI Responses API 或兼容网关 | `baseURL` + `apiKeyEnv`；使用 Bearer token |
| `codex` | 现有 ChatGPT/Codex OAuth 后端 | 使用已有 Codex 登录，不接受地址或 key 覆盖 |
| `bedrock` | AWS 上的 Claude | 使用现有 AWS 凭证、区域和云端配置 |
| `vertex` | Vertex AI 上的 Claude | 使用现有 Google Cloud 凭证和项目配置 |
| `foundry` | Azure Foundry 上的 Claude | 使用现有 Foundry API key 或 Azure 身份认证 |

云平台三个选项沿用 Anthropic 的云 SDK，不等于接入这些平台上的所有模型。Gemini、Bedrock Converse 等原生协议暂未实现；若服务提供兼容接口，可以配置相应的兼容协议。

## 从本地服务开始

先构建本分支，避免运行之前安装的旧版本：

```bash
bun install
bun run build
```

创建用户配置文件 `~/.claude/providers.json`。以下是完整的 JSON 示例，可同时保留这些 profile；默认只选择 `local`，其他 profile 的 key 在选择它们时才要求存在。

模型 ID 必须换成自己的服务实际提供的名称。下面本地服务示例假设 `http://localhost:11434/v1` 已加载 `qwen3-coder:30b`；配置不会下载模型或启动推理服务器。上下文和输出额度是客户端设置，应按实际模型、服务器配置及账户权限调整。

```json
{
  "defaultProvider": "local",
  "providers": {
    "local": {
      "name": "Local coding model",
      "api": "openai-completions",
      "baseURL": "http://localhost:11434/v1",
      "maxTokensField": "max_tokens",
      "defaultModel": "qwen3-coder:30b",
      "models": [
        {
          "id": "qwen3-coder:30b",
          "name": "Local coder",
          "contextWindow": 32768,
          "maxOutputTokens": 4096,
          "vision": false,
          "reasoning": false
        }
      ]
    },
    "anthropic": {
      "name": "Anthropic API",
      "api": "anthropic",
      "baseURL": "https://api.anthropic.com",
      "apiKeyEnv": "ANTHROPIC_API_KEY",
      "defaultModel": "claude-sonnet-4-6",
      "smallModel": "claude-haiku-4-5",
      "models": [
        {
          "id": "claude-sonnet-4-6",
          "contextWindow": 200000,
          "maxOutputTokens": 16384,
          "vision": true,
          "reasoning": true
        },
        {
          "id": "claude-haiku-4-5",
          "contextWindow": 200000,
          "maxOutputTokens": 8192,
          "vision": true,
          "reasoning": false
        }
      ]
    },
    "openai": {
      "name": "OpenAI Responses",
      "api": "openai-responses",
      "baseURL": "https://api.openai.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY",
      "defaultModel": "gpt-5.4",
      "models": [
        {
          "id": "gpt-5.4",
          "contextWindow": 200000,
          "maxOutputTokens": 16384,
          "vision": true,
          "reasoning": true
        }
      ]
    }
  }
}
```

启动并发送一条请求：

```bash
./cli --provider local
./cli --provider local -p "只回复 OK"
```

若已经把本分支安装成 `free-code` 命令，以下示例中的 `./cli` 可替换为 `free-code`。

## 配置文件与选择优先级

配置文件路径依次使用 `--providers-file <path>`、`FREE_CODE_PROVIDERS_FILE`、`$CLAUDE_CONFIG_DIR/providers.json`；未设置 `CLAUDE_CONFIG_DIR` 时为 `~/.claude/providers.json`。默认文件不存在时保留原有行为；显式指定的文件不存在、JSON 无效或字段无效时会报错。配置为严格 JSON，不接受注释、尾逗号或未声明的字段。

```bash
./cli --providers-file "$HOME/.config/free-code/providers.json" --provider local
FREE_CODE_PROVIDERS_FILE="$HOME/.config/free-code/providers.json" ./cli
FREE_CODE_PROVIDER=local ./cli
```

启动选择依次为：带已配置 provider 前缀的 `--model`、`--provider`、`FREE_CODE_PROVIDER`、文件中的 `defaultProvider`。例如，`--provider local --model openai/gpt-5.4` 最终选择 `openai`。未指定任何 profile 时沿用现有环境变量与登录配置。

修改文件、环境变量或凭证后需重新启动。当前没有 `/provider add`、在线模型目录发现、配置热重载或自动写回配置；`/provider` 用于选择已经加载的 profile。

## 在会话中切换

| 命令 | 行为 |
|---|---|
| `/provider` | 显示配置的 provider 和 legacy 选项 |
| `/provider openai` | 切换到 `openai` 的 `defaultModel` |
| `/model` | 显示可选模型，包含配置的 provider/model |
| `/model openai/gpt-5.4` | 同时切换 provider 和模型 |
| `/model claude-haiku-4-5` | 在当前 provider 中选择这个模型 ID |
| `/model default` | 使用当前 provider 的默认模型 |
| `/provider legacy` | 回到原有环境变量与登录路由 |

同一个远端模型可在不同 provider 下重复声明，例如 `direct/ModelA` 和 `proxy/ModelA`。前缀仅用于本地选择，发给服务端的都是 `ModelA`，大小写保持不变。远端名称本身也可包含 `/`，例如 profile `local` 的模型 `Qwen/Code` 使用 `local/Qwen/Code` 选择。

切换只影响当前会话，不改写配置文件或删除登录。已有普通文字、工具调用及结果保留；后续推理会把可兼容的对话历史发送给新选择的服务。切换不代表不同模型具有完全相同的上下文、推理或多模态能力。

进行中的请求和后台 Agent 保留启动时绑定的 provider、模型及凭证引用；切换前台模型不会把它们后续的工具循环、摘要或辅助请求改投新 provider。后台 Agent 运行时也可以跨 provider 切换。配置或凭证校验失败会保留当前选择，组织的模型允许列表仍然生效。

也可以在启动时直接选择模型：

```bash
./cli --model local/qwen3-coder:30b
./cli --provider anthropic --model claude-haiku-4-5
./cli --model openai/gpt-5.4 -p "解释当前目录的项目结构"
```

## 字段、能力与费用

Provider 的 key 是本地 ID：1–64 个字母、数字、连字符或下划线，以字母或数字开头；`legacy` 保留。每个 profile 必须有 `api`、非空 `models` 数组和 `defaultModel`。`defaultModel`、可选的 `smallModel` 必须精确匹配该 profile 中的模型 ID。

`smallModel` 用于需要小模型的辅助查询；未设置时使用该请求所属 provider 的 `defaultModel`。原有 Agent/skill 使用的 `sonnet`、`opus`、`best`、`opusplan` 别名映射到父 Agent 所属 profile 的默认模型，`haiku` 映射到它的 `smallModel` 或默认模型，不会因此跨回 Anthropic。如果 profile 已声明同名模型，精确 ID 优先于别名。

| 模型字段 | 含义与默认值 |
|---|---|
| `id` | 必填，远端模型或部署 ID；同一 provider 内唯一 |
| `name` | 可选，菜单显示名 |
| `contextWindow` | 总上下文 token 数，默认 `128000`；用于上下文管理和压缩阈值 |
| `maxOutputTokens` | 输出 token 上限，默认 `8192`，不得超过 `contextWindow` |
| `vision` | 默认 `false`；Messages、Chat Completions、Responses 和 Codex profile 在未启用时拒绝图片 |
| `reasoning` | 默认 `false`；控制推理/effort 的启用和协议转换 |
| `promptCaching` | 可选，`disabled` 或 `ephemeral`；未设置时不发送显式缓存标记。`ephemeral` 仅适用于 `anthropic`、`bedrock`、`vertex`、`foundry` |
| `cost` | 可选，`input`、`output` 必填，`cacheRead`、`cacheWrite` 可选；单位均为美元/百万 token |

所有 token 额度必须为正整数，价格必须为非负有限数。例如，在模型条目中加入 `"cost": { "input": 1, "output": 3, "cacheRead": 0.1, "cacheWrite": 1.2 }`；这些数字仅演示配置格式，应替换为自己的计费标准。

未声明价格时会标记费用不完整，不会套用 Claude 的价格。发生缓存 token 用量而缺少对应缓存价格时也会标记不完整。显示为零的未知费用不表示免费，金额预算不能覆盖尚未配置的收费。

`reasoning: true` 是能力声明，不保证服务接受任意推理参数：Chat Completions 使用 `reasoning_effort`，并可回放文本 `reasoning_content`；Responses 使用 `reasoning.effort` 和 reasoning summary。服务若不支持这些参数，应关闭该能力。`maxTokensField` 只适用于 `openai-completions`，默认 `max_tokens`；要求新字段的服务可设为 `max_completion_tokens`。

需要 Messages 协议的显式 prompt cache 时，可在模型条目中加入 `"promptCaching": "ephemeral"`。它使用标准临时缓存标记，不继承 Anthropic 账户的共享缓存作用域或内部一小时 TTL 开关。缓存是否命中、如何收费仍由服务决定。OpenAI 兼容协议使用服务自己的自动缓存机制，不接受这里的 `ephemeral` 选项。

## 子 Agent 与长任务

`Agent` 工具的 `model` 参数以及自定义 Agent 的模型设置可使用已配置的 `provider/model`，例如让本地模型负责主会话，让另一个 profile 完成审查：

```json
{
  "subagent_type": "general-purpose",
  "description": "Review the proposed change",
  "prompt": "Read the changed files, identify correctness risks, and report findings. Do not edit files.",
  "model": "openai/gpt-5.4"
}
```

这是一段供模型调用 `Agent` 工具的参数示例，不是 shell 命令。省略模型时按 Agent 定义继承；`inherit`、`haiku` 等别名仍在父 Agent 的 provider 内解析。显式 `provider/model` 会验证目标模型、凭证和组织允许列表，失败不会静默换用其他账户。每个 Agent 的工具权限保持原有规则。

如果当前构建开启了 fork 模式，省略 `subagent_type` 会复制父会话，工具的 `model` 参数在这条路径不生效；需要另一 provider 时，应像上例一样显式选择 `general-purpose` 或其他可用 Agent 类型。`CLAUDE_CODE_SUBAGENT_MODEL` 仍是优先级最高的统一覆盖；要按任务分别选模型，启动前应移除该覆盖。Teammate 也接受已配置的 `provider/model`，但仍受下述独立终端凭证传递限制。

配置的模型使用按窗口比例计算的输出预留、压缩阈值、摘要大小及文件/技能恢复预算，避免把 Claude 大窗口的固定 buffer 直接减到小模型上。默认输出预留不超过上下文的四分之一；摘要预留不超过八分之一，且都受 `maxOutputTokens` 限制。以输出上限 4096、无额外覆盖为例，16384 窗口的自动压缩阈值为 11305 tokens，32768 窗口为 26379 tokens。实际触发仍受消息状态、压缩设置和 token 估算影响；固定系统提示或单次工具输出过大时，模型仍可能无法容纳请求。

第三方会话采用中立身份和工具指导，不再默认推荐 Claude、假定所有模型能看图，或宣传不可用的 Fast mode。工具指导取决于当前请求的工具集合；小窗口模型会得到分段读取和精简结果的提示。自定义 `--system-prompt` 的覆盖语义保持不变，这些提示改动不构成编码成功率提升的实测结论。

认证、权限、配额、限流、超时、连接故障、上下文超限和输出额度错误经过共同分类，再进入相应的恢复路径。只有明确可重试的错误重试；能可靠读出额度时才缩小输出，否则交给上下文恢复或直接报告错误。服务返回的未知格式仍可能无法自动恢复，认证失败不会换用别的 provider。

## 独立工具与服务

- **工具发现**：自定义 profile 使用本地 `ToolSearch`，按工具名称、描述和集成关键词检索。结果为普通文本，选中的完整 schema 加入下一次模型请求，不需要 Anthropic 的 `tool_reference`。默认在可延迟工具描述估算超过上下文的 10% 时启用；`ENABLE_TOOL_SEARCH=true` 强制启用，`false` 关闭，`auto:20` 设置为 20%。发现工具不改变其执行权限，也不是联网搜索。
- **联网搜索**：在独立的 `services.json` 中选择 SearXNG 或 Brave Search。模型接收标题、URL 和摘要，`WebSearch` 权限仍生效；未配置时自定义 profile 不会调用 Anthropic 搜索作为 fallback。
- **网页读取**：自定义 profile 默认直接 HTTP 抓取并在本地提取 Markdown，不经过 Anthropic 的域名检查或辅助摘要模型。当前模型接收有长度限制的页面内容；它不继承浏览器登录或 cookie。
- **语音**：`services.json` 可指定 OpenAI-compatible transcription 服务或本地 Whisper 兼容服务。按住录音键、松开后上传转写；没有实时中间字幕，需要麦克风和可用的本地录音组件。
- **顾问审查**：自定义 profile 下使用 `/advisor provider/model` 为本会话选择审查模型，主 Agent 通过普通 `Agent` 工具请求审查；`/advisor off` 关闭。它受工具权限控制，不再发送 Anthropic 服务端 advisor 工具。是否发起审查由主模型按提示决定。
- **MCP 与同步**：自定义 profile 使用直接配置的本地或远端 MCP，不自动读取 Claude.ai 连接器，也不运行 Claude 账户的设置或团队记忆同步。已有云端连接器需要改为直接配置对应 MCP 服务；本地设置、项目记忆和文件仍可使用。

搜索和语音凭证与模型凭证分别配置，切换模型不会切换这些服务。完整示例、路径优先级、抓取限制与录音要求见 [EXTERNAL_SERVICES.md](EXTERNAL_SERVICES.md)。程序不会自动安装 SearXNG、Whisper 或模型推理服务。

Anthropic 的自动权限分类器暂未移植到其他模型。自定义 profile 使用常规权限规则和交互审批；从 legacy 自动模式切换过来时也会在执行处复核，不把不可用的分类器当作自动批准。

## 本地浏览器会话与规划

```bash
./cli local-remote --port 8080 --cwd "$PWD" -- --provider local
```

`local-remote` 在 `127.0.0.1` 启动带访问 token 的浏览器界面，并创建一个新的持久 headless CLI 子会话。按终端提示打开页面、输入 token 后，可以发送请求、查看事件、处理工具批准和取消任务。可通过 SSH 隧道从另一台机器访问，不需要 Anthropic 账户或托管 relay。它不接管已经打开的终端 REPL，也不提供 claude.ai 的账户、团队或云端任务服务。停止服务器会结束它拥有的子会话；token 可通过 `FREE_CODE_REMOTE_TOKEN` 提供，未配置时随机生成并仅在启动终端打印。

`/plan` 使用当前模型在本地会话中规划，沿用计划权限规则。自定义 profile 下，`/ultraplan <任务>` 也走本地路径：进入普通 plan 权限模式，使用可用的 Plan/Explore Agent 阅读代码和比较方案，再通过常规计划审批；不需要 `ULTRAPLAN` 编译开关。审批界面的 refine 反馈继续本地规划循环，不创建云端任务、会话或 teleport。

这两条本地路径不需要把任务提交到 Anthropic CCR 服务，但当前选用的模型服务仍会接收正常的模型请求。它们与 CCR 的云端规划、编辑和审批产品不是同一项服务。legacy 会话保留原有受编译开关控制的云端 `/ultraplan`。`local-remote` 与 legacy `/remote-control` 也是分别实现的入口，详细操作见 [EXTERNAL_SERVICES.md](EXTERNAL_SERVICES.md)。

## 地址和凭证

`anthropic`、`openai-completions`、`openai-responses` 必须设置 `baseURL`。Chat Completions 使用类似 `https://gateway.example/v1` 的 API 根路径，适配器追加 `/chat/completions`；Responses 追加 `/responses`。Anthropic 使用 SDK 接受的 API 根地址，例如 `https://api.anthropic.com`。

远端地址须用 HTTPS；HTTP 仅允许 `localhost`、`127.x.x.x` 和 `[::1]` 回环地址。URL 不接受用户名、密码、查询参数或片段。认证请求不跟随重定向。

配置文件只保存环境变量名，例如 `"apiKeyEnv": "MY_GATEWAY_KEY"`。请在启动 CLI 前，通过自己的 shell 或凭证工具设置这个变量。所指变量为空时，选择该 provider 会报错。凭证使用进程启动时的环境快照；修改 shell 中的变量后需启动新进程。

不需要认证的本地服务省略 `apiKeyEnv` 即可，适配器不会附加占位认证头。若服务要求认证，则配置它自己的变量；不会自动借用 `ANTHROPIC_API_KEY`、Anthropic OAuth 或其他 profile 的密钥。

可使用 `headers` 配置网关需要的普通请求头，例如 `"headers": { "X-Project": "personal" }`。`Authorization`、`Proxy-Authorization`、`x-api-key`、`api-key`、`Cookie` 不允许放入该字段，应通过 `apiKeyEnv` 配置认证。避免把密钥写入模型名、地址、普通 header 或提交到仓库。

`codex`、`bedrock`、`vertex`、`foundry` 不接受 `baseURL`、`apiKeyEnv` 或 `headers`，沿用各自现有认证。可以把以下 profile 放进 `providers` 中，复用已有 Codex 登录；示例额度仍应按实际模型调整：

```json
{
  "providers": {
    "subscription": {
      "name": "My Codex login",
      "api": "codex",
      "defaultModel": "gpt-5.4",
      "models": [
        {
          "id": "gpt-5.4",
          "contextWindow": 200000,
          "maxOutputTokens": 16384,
          "vision": true,
          "reasoning": true
        }
      ]
    }
  }
}
```

没有 Codex 登录时，先在 legacy 模式使用已有 `/login` 流程登录 Codex，再选择该 profile。云平台 profile 同样设置 `api`、`models`、`defaultModel`，模型 ID 必须使用相应平台要求的完整部署 ID；不会自动将普通 Claude 名称改写成 Bedrock/Vertex 部署名。

## 恢复原有行为

```bash
./cli --provider legacy
CLAUDE_CODE_USE_OPENAI=1 ./cli --provider legacy
CLAUDE_CODE_USE_BEDROCK=1 ./cli --provider legacy
```

会话中使用 `/provider legacy`。legacy 恢复原有环境变量和已有登录决定的路由，多个旧 provider 开关的优先级仍沿用项目原规则。不要同时传入指向自定义 profile 的 `--model provider/model`，它的优先级高于 `--provider legacy`。

## 已支持的范围与限制

OpenAI 兼容适配器支持文本、多轮本地工具调用和结果、工具结果中的图片、流式与非流式返回、用量统计、取消，以及 JSON Schema 输出格式转换。图片需要声明 `vision: true`；结构化输出使用非 strict 模式，最终仍取决于服务实际支持的字段。配置不会自动补齐模型本身缺少的工具调用能力。

Responses/Codex 的原生输出项（包括 `encrypted_content`、reasoning summary、message `phase`、item ID）以及 Chat Completions 的 `reasoning_content`、Anthropic thinking/signature 会附带来源 metadata 保存到会话历史。同 API、profile ID、精确模型 ID、规范化 endpoint 匹配且对应内容未改变时，可在后续请求或恢复会话时回放；Codex 另绑定账户 ID。修改、压缩或删除对应内容后会降级为可兼容的普通历史，避免把已删除内容从原生状态中恢复出来。来源标识不保存 API key，但原始返回状态属于会话数据，会随会话文件保存。

这套来源记录覆盖新生成的兼容协议 profile 与 Codex 请求；旧会话中已经丢失的原生状态不能补回。legacy 和云 SDK 的旧签名历史仍按原有兼容规则处理。

目前限制如下：

- 主循环和历史兼容结构仍大量使用 Anthropic Messages/Beta 形状；新增 provider 客户端契约和原生状态 metadata 是适配边界，尚未把整个 Agent 核心替换为完全中立的消息类型。
- Chat Completions/Responses 转换不支持 PDF/document、音频、视频或供应商托管的 server tools，遇到不支持的内容会报错。已有文件读取、Bash 和 MCP 的本地工具流程仍可使用。
- 自定义 profile 不继承 Anthropic 账户专属能力。Fast mode、Anthropic 托管 WebSearch 和自动权限分类仍不通用；搜索、工具发现和语音使用上述独立实现。普通权限规则、用户确认和沙箱不依赖该分类器。
- 供应商私有状态不会跨 provider、模型或 endpoint 移植；旧会话中已经丢失、没有 metadata 的状态也无法补回。保留字段不保证每个兼容网关接受所有原生扩展，仍需针对实际服务验证。
- OpenAI 兼容服务没有 Anthropic `count_tokens` 接口，使用现有本地估算回退。配置的上下文和输出额度必须符合服务器实际限制。
- Codex OAuth 后端有自己的请求限制，适配器不向该后端发送 `max_output_tokens`；客户端配置仍参与本地预算。Codex profile 不是通用 OpenAI API key profile。
- 模型 profile 或搜索服务使用 `apiKeyEnv` 时，创建 teammate 的 `--teammate-mode auto` 选择进程内运行；显式 `--teammate-mode tmux` 会报错，应改为 `--teammate-mode in-process`。Tmux/iTerm2 的独立终端 pane 不保证继承启动 CLI 的密钥环境，程序不会把密钥拼入命令行来传递。
- 已覆盖的协议字段不等于所有兼容服务的私有扩展；没有自动 fallback，也不会在认证失败时借用其他账户。
- 编译开关可用不代表快照内每个实验功能均已恢复；例如 context-collapse 占位实现不等于完整上下文折叠，不能据此替代现有摘要压缩。真实模型质量、账户权限、服务版本和性能需要分别评测。

## 开发参考

设计参考以下官方仓库：provider 身份、协议和模型 ID 分离；认证在请求边界解析；用模型能力决定请求参数；将不同协议的消息转换集中在适配层。

- [Kimi Code CLI：provider/model 配置](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/config.py) 与 [LLM 工厂](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/llm.py)。
- [pi：统一消息与流式类型](https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/types.ts) 与 [模型注册接口](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/model-registry.ts)。
- [OpenCode：provider 路由](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/provider/provider.ts) 与 [消息转换](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/provider/transform.ts)。

本地实现入口为 [`src/providers/config.ts`](src/providers/config.ts)、[`src/providers/runtime.ts`](src/providers/runtime.ts)、[`src/services/api/profile-client.ts`](src/services/api/profile-client.ts) 和 [`src/commands/provider/`](src/commands/provider/)。运行 `bun run test:providers` 验证配置、切换和协议适配契约；这些离线测试不代替真实服务的账户和模型兼容性验证。

另外提供了显式启动的真实模型任务评测 runner，见 [PROVIDER_EVALUATION.md](PROVIDER_EVALUATION.md)；当前没有因此收集真实 provider 的质量排名。联网搜索、语音和本地远程会话不要求使用模型账户专属服务，但配置的外部服务本身仍可能收费。

要同时运行真实 CLI 到本地模拟服务的工具调用测试，先构建，再指定该可执行文件（需要允许监听回环端口，不调用付费服务）：

```bash
bun run build:dev:full
FREE_CODE_TEST_BINARY="$PWD/cli-dev" bun run test:providers
```
