# Free Code Portable

**可配置模型 provider、独立工具服务的终端编程 Agent。**

[English](README.md) · [简体中文](README.zh-CN.md)

Free Code Portable fork 自 [freecodexyz/free-code](https://github.com/freecodexyz/free-code)，以其提交 [`6b25ab6`](https://github.com/freecodexyz/free-code/commit/6b25ab6) 为基础。在保留已有终端工作流的同时，让模型选择、联网搜索、语音转录与本地浏览器会话能够分别配置。

你可以用本地模型处理主会话，让另一家 provider 的模型负责审查，同时沿用文件操作、工具调用与权限确认。本地或第三方 API profile 可在没有 Anthropic 账户的情况下运行；每项服务仍有自己的认证、可用性和计费要求。

项目仍在改造继承的 harness。核心消息结构尚大量使用 Anthropic Messages/Beta 形状，快照中的部分功能也仍不完整。

## 本 fork 增加了什么

| 范围 | 实现 |
| --- | --- |
| 模型 provider | 为 Anthropic Messages、OpenAI Chat Completions、Responses 配置命名 profile；保留已有 Codex OAuth 和 Claude 云平台集成。 |
| 会话内切换 | `/provider` 与 `/model provider/model`；进行中的请求和后台 Agent 保留各自原有的 provider 上下文。 |
| 子 Agent | Agent 或 teammate 可选择另一组 provider/model，分别使用凭证，沿用已有权限规则。 |
| 上下文管理 | 按模型窗口计算输出预留和压缩预算，依据声明的能力生成提示。 |
| 会话状态 | 保存兼容协议的原生推理状态，用于后续请求和恢复会话；私有状态绑定其来源。 |
| 联网工具 | SearXNG 或 Brave Search；直接 HTTP 抓取网页并在本地提取 Markdown。 |
| 语音输入 | 独立的 OpenAI-compatible transcription 接口，包括本地 Whisper 兼容服务。 |
| 本地工作流 | 本地工具发现、浏览器会话、规划，以及通过普通 Agent 实现的顾问审查。 |

## 快速开始

需要 **Bun 1.3.11 或更新版本**，以及 macOS 或 Linux；Windows 可使用 WSL。模型、搜索和转录服务需要自行准备，本仓库不会自动安装或启动它们。

```sh
git clone https://github.com/YanzhangJiang/free-code-portable.git
cd free-code-portable
bun install
bun run build
```

假设本地 OpenAI-compatible 模型服务已在 `http://localhost:11434/v1` 运行，先为这次体验创建独立配置目录：

```sh
portable_config="$(mktemp -d "${TMPDIR:-/tmp}/free-code-portable.XXXXXX")"
export CLAUDE_CONFIG_DIR="$portable_config"
cp examples/providers.local.json "$portable_config/providers.json"
```

编辑复制后的文件，将两处 `YOUR_MODEL_ID` 都替换成服务实际提供的精确模型 ID。最小配置如下：

```json
{
  "defaultProvider": "local",
  "providers": {
    "local": {
      "api": "openai-completions",
      "baseURL": "http://localhost:11434/v1",
      "defaultModel": "YOUR_MODEL_ID",
      "models": [
        {
          "id": "YOUR_MODEL_ID",
          "contextWindow": 16384,
          "maxOutputTokens": 4096
        }
      ]
    }
  }
}
```

上下文与输出额度应按服务的实际配置调整，模型本身须支持工具调用。不需要认证的本地服务可省略 `apiKeyEnv`；需要认证时，应填写该服务自己的凭证环境变量名。

```sh
./cli --providers-file "$portable_config/providers.json" --provider local
# 或只发送一条请求：
./cli --providers-file "$portable_config/providers.json" --provider local \
  -p "阅读这个仓库，解释项目结构。"
```

临时的 `CLAUDE_CONFIG_DIR` 让这次体验与已有 `~/.claude` 配置分开。长期使用时，请选择持久化配置目录并将 `CLAUDE_CONFIG_DIR` 指向它。上述环境变量只影响当前 shell；执行 `unset CLAUDE_CONFIG_DIR` 可恢复默认路径。

托管 API、凭证、多 profile、模型能力、缓存和云平台配置见 [PROVIDERS.md](PROVIDERS.md)。

## 切换模型与分配任务

在交互会话中使用：

```text
/provider
/provider local
/model other-profile/exact-model-id
/provider legacy
```

所选 profile 和模型须已在启动时加载的配置中声明。修改配置文件或凭证变量后需要重启。切换会保留兼容的对话历史，后续请求会把这些历史发送到新选择的服务。

子 Agent 可以独立选择已配置的 `provider/model`。`haiku` 等已有别名在父 Agent 所属 provider 内解析；进行中的任务继续使用启动时的路由。配置方式和边界见 [子 Agent 与长任务](PROVIDERS.md#子-agent-与长任务)。

自定义 profile 下，`/advisor provider/model` 可选择审查模型。审查通过普通 Agent 工具完成，受其权限规则约束，是否发起审查由主模型按提示决定。

## 配置独立服务

搜索与语音读取 `services.json`，与模型 profile 及其凭证分别配置。假设 SearXNG 已在端口 8888 运行：

```sh
cp examples/services.searxng.json "$portable_config/services.json"
./cli --providers-file "$portable_config/providers.json" \
  --services-file "$portable_config/services.json" --provider local
```

示例内容如下：

```json
{
  "webSearch": {
    "provider": "searxng",
    "baseURL": "http://127.0.0.1:8888",
    "maxResults": 10,
    "timeoutMs": 20000
  }
}
```

需要在 SearXNG 中启用 JSON 输出。也可配置 Brave Search。自定义模型 profile 需要配置搜索服务才能使用联网搜索；搜索失败不会自动回退到 Anthropic。

自定义 profile 默认直接抓取公开网页。语音可使用独立的 Whisper 兼容端点，按住录音键、松开后上传转录，没有实时中间字幕；相关工具权限和本地录音要求仍然适用。

完整示例、代理支持、网页抓取限制和转录要求见 [EXTERNAL_SERVICES.md](EXTERNAL_SERVICES.md)。

## 本地浏览器会话与规划

```sh
./cli local-remote --port 8080 --cwd "$PWD" -- \
  --providers-file "$portable_config/providers.json" --provider local
```

打开终端打印的本地地址，输入终端中显示的访问 token。浏览器可向新建的持久 CLI 子会话发送请求、查看事件、处理工具批准和取消任务。服务只监听 `127.0.0.1`，跨机器访问可使用 SSH 隧道。它不接管已打开的终端会话；停止服务器会结束其子会话。

`/plan` 在当前本地会话中规划。自定义 profile 下，`/ultraplan <任务>` 也使用本地路径，借助可用的探索/规划 Agent 和普通计划审批。这些路径不需要 Anthropic 托管 relay；正常模型请求仍会发送给所选 provider。

## 兼容性与当前限制

- 支持范围按协议划分。Bedrock、Vertex、Foundry 沿用 Claude 集成；尚未实现 Gemini 原生协议或 Bedrock Converse。
- Chat Completions/Responses 适配器支持文字、声明的图片能力和本地工具调用，不实现 PDF/document、对话音视频块或任意厂商托管工具。
- 原生推理状态仅在来源匹配且对应内容未修改时回放，不能随意跨 provider、模型或端点搬运，也无法补回已经丢失的状态。
- Token 数可能采用本地估算。模型配置须匹配服务实际额度；过大的提示或工具输出仍可能超出上下文。
- 自定义 profile 使用普通权限规则和审批。Anthropic 自动权限分类器与 Fast mode 尚不通用，也不会自动启用 Claude.ai 连接器和云同步。
- 直接网页抓取没有浏览器登录态。语音需要可用的录音组件；搜索、转录和托管模型服务可能分别收费。
- 带模型或搜索凭证的 profile 可能需要进程内 teammate，无法直接使用独立终端 pane；具体限制见 provider 文档。
- 实验开关能编译不代表对应功能完整。协议测试不代表不同模型有相同的编程质量；实际服务兼容性、效果和性能需要另行评测。

保留已有 `FREE_CODE_*` 环境变量、`CLAUDE_CONFIG_DIR`、`~/.claude` 路径及 CLI 兼容约定。仓库更名不会自动迁移已有设置；`/provider legacy` 可返回原有路由。

## 开发与文档

```sh
bun run build                         # 生成 ./cli
bun run build:dev:full                # 生成 ./cli-dev，启用更多实验开关
FREE_CODE_TEST_NETWORK=1 FREE_CODE_TEST_BINARY="$PWD/cli-dev" bun run test:providers
git diff --check
```

测试包括本地模拟 HTTP 服务与真实 CLI 工具循环，需要允许监听回环端口，不需要调用付费模型。继承的快照仍存在全仓 TypeScript 诊断；构建成功或相关测试通过，不表示整个源码树已经通过严格类型检查。

| 文档 | 内容 |
| --- | --- |
| [Provider 指南](PROVIDERS.md) | 配置、路由、凭证、能力与详细限制。 |
| [独立服务](EXTERNAL_SERVICES.md) | 搜索、网页读取、转录、浏览器会话和本地规划。 |
| [Provider 评测](PROVIDER_EVALUATION.md) | 可选的真实模型任务 runner；显式启用后的请求可能收费。 |
| [功能审计](FEATURES.md) | 继承的编译开关与重建记录。 |
| [开发约定](AGENTS.md) | 仓库规范、资源所有权、验证与提交流程。 |
| [上游变更记录](changes.md) | 从上游快照继承的历史说明。 |

欢迎在独立分支中提交范围明确的改动。请遵循 [AGENTS.md](AGENTS.md)，说明行为变化并提供相应验证；不要提交凭证或个人配置。

## 来源与许可现状

本仓库 fork 自 [freecodexyz/free-code](https://github.com/freecodexyz/free-code)，上游重建了 Claude Code 源码快照。本项目独立维护，并非 Anthropic 官方产品。

继承的 README 声明原始 Claude Code 源码属于 Anthropic。本仓库当前没有仓库级 `LICENSE` 文件，本 fork 不对继承源码另行宣称统一授权。各依赖保留其各自的声明与条款。
