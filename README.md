# Free Code Portable

**A terminal coding agent with configurable model providers and independent tool services.**

[English](README.md) · [简体中文](README.zh-CN.md)

Free Code Portable is a development fork of [freecodexyz/free-code](https://github.com/freecodexyz/free-code), based on upstream commit [`6b25ab6`](https://github.com/freecodexyz/free-code/commit/6b25ab6). It keeps the existing terminal workflow while making model selection, web search, transcription, and local browser sessions configurable independently.

Use a local model for the main conversation, send a review to another configured provider, and keep the same tools and permission checks. Local and third-party API profiles can run without an Anthropic account. Each selected service still has its own availability, authentication, and billing requirements.

This is an evolving adaptation of the inherited harness. Its core message representation still uses substantial Anthropic Messages/Beta structure, and some snapshot features remain incomplete.

## What this fork adds

| Area | Behavior |
| --- | --- |
| Model providers | Named profiles for Anthropic Messages, OpenAI Chat Completions, and Responses; existing Codex OAuth and Claude cloud integrations remain available. |
| Model switching | `/provider` and `/model provider/model`; running requests and background agents retain their original provider context. |
| Sub-agents | Select a different configured provider/model for an Agent or teammate, with separate credentials and the existing permission rules. |
| Context management | Model-sized output reserves, compaction budgets, and prompts based on declared capabilities. |
| Conversation state | Retain compatible native reasoning state for continuation and session resume; private state is scoped to its source. |
| Web tools | SearXNG or Brave Search; direct HTTP page retrieval and local Markdown extraction. |
| Voice | Independent OpenAI-compatible transcription, including local Whisper-compatible services. |
| Local workflows | Local tool discovery, browser sessions, planning, and Agent-based advisor review. |

## Quick start

Requires **Bun 1.3.11 or newer** and macOS or Linux; use WSL on Windows. Model, search, and transcription servers are separate services: this repository does not install or start them.

```sh
git clone https://github.com/YanzhangJiang/free-code-portable.git
cd free-code-portable
bun install
bun run build
```

For a local OpenAI-compatible model server already listening at `http://localhost:11434/v1`, create a separate demonstration configuration:

```sh
portable_config="$(mktemp -d "${TMPDIR:-/tmp}/free-code-portable.XXXXXX")"
export CLAUDE_CONFIG_DIR="$portable_config"
cp examples/providers.local.json "$portable_config/providers.json"
```

Edit the copied file, replacing both occurrences of `YOUR_MODEL_ID` with the exact model ID offered by your server. The minimal configuration is:

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

Adjust the context and output limits to match your server. The model must support tool calling. A keyless local endpoint can omit `apiKeyEnv`; authenticated endpoints should name their own credential environment variable.

```sh
./cli --providers-file "$portable_config/providers.json" --provider local
# Or send one prompt:
./cli --providers-file "$portable_config/providers.json" --provider local \
  -p "Read this repository and explain its structure."
```

The temporary `CLAUDE_CONFIG_DIR` keeps this demonstration separate from an existing `~/.claude` directory. For continued use, choose a persistent configuration directory and set `CLAUDE_CONFIG_DIR` there. The exported value applies to this shell; use `unset CLAUDE_CONFIG_DIR` to return to the default location.

See [PROVIDERS.md](PROVIDERS.md) for hosted APIs, credentials, multiple profiles, model capabilities, caching, and cloud integrations.

## Switch models and delegate work

Inside a session:

```text
/provider
/provider local
/model other-profile/exact-model-id
/provider legacy
```

The selected profile and model must already exist in the loaded configuration. Changes to configuration or credential variables require a restart. Switching preserves compatible conversation history; subsequent requests send that history to the newly selected service.

Agents can use a configured `provider/model` independently of the main conversation. Existing aliases such as `haiku` resolve within the parent provider, and in-flight work retains its original routing. See [sub-agent configuration and limits](PROVIDERS.md#子-agent-与长任务).

`/advisor provider/model` selects a review model for custom profiles. Reviews use the ordinary Agent tool, subject to its permissions and the main model's decision to request a review.

## Configure independent services

Search and voice use `services.json`, separate from model profiles and their credentials. To use a SearXNG instance already running on port 8888:

```sh
cp examples/services.searxng.json "$portable_config/services.json"
./cli --providers-file "$portable_config/providers.json" \
  --services-file "$portable_config/services.json" --provider local
```

The example contains:

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

Enable JSON output in your SearXNG instance. Brave Search is also supported. Custom model profiles require a configured search service; search failures do not fall back to Anthropic.

Custom profiles fetch public web pages directly by default. Voice can use a separate Whisper-compatible endpoint and uploads audio after the push-to-talk key is released; it does not provide live interim captions. Both retain their existing tool or microphone requirements.

See [EXTERNAL_SERVICES.md](EXTERNAL_SERVICES.md) for complete examples, proxy support, fetch restrictions, and transcription requirements.

## Local browser sessions and planning

```sh
./cli local-remote --port 8080 --cwd "$PWD" -- \
  --providers-file "$portable_config/providers.json" --provider local
```

Open the printed local URL and enter the access token shown in the terminal. The browser can send prompts, view events, approve tools, and cancel work in a new persistent CLI child session. It binds to `127.0.0.1`; use an SSH tunnel for another machine. It does not attach to an existing terminal session. Stopping the server ends its child session.

`/plan` uses the current local session. With a custom profile, `/ultraplan <request>` also plans locally with available exploration/planning agents and ordinary plan approval. These paths need no Anthropic hosted relay; normal model requests still go to the selected provider.

## Compatibility and current limits

- Provider support is protocol-specific. Bedrock, Vertex, and Foundry use the inherited Claude integrations; native Gemini and Bedrock Converse are not implemented.
- Chat Completions/Responses adapters support text, declared image capability, and local tool calls. They do not implement PDF/document, audio/video conversation blocks, or arbitrary vendor-hosted tools.
- Native reasoning state is replayed only for matching sources and unchanged content. It cannot be moved freely across providers, models, or endpoints, or reconstructed after it was lost.
- Token counts may use local estimates. Declared context limits must match the server, and very large prompts or tool results can still exceed them.
- Custom profiles use ordinary permissions and approvals. Anthropic's automatic permission classifier and Fast mode are not portable; Claude.ai connectors and cloud sync are not automatically enabled.
- Direct web fetch has no browser login state. Transcription needs a working recording backend. Search, transcription, and hosted model services may charge separately.
- Credential-bearing model/search profiles may require in-process teammates instead of independent terminal panes. See the detailed provider guide.
- Experimental flags that compile are not a guarantee of a complete feature. Protocol tests do not establish equal coding quality across models; live-service compatibility and performance need separate evaluation.

Existing `FREE_CODE_*` variables, `CLAUDE_CONFIG_DIR`, `~/.claude`, and CLI compatibility conventions are retained. The repository name is not a migration of existing settings. Legacy routes remain available through `/provider legacy`.

## Development and documentation

```sh
bun run build                         # ./cli
bun run build:dev:full                # ./cli-dev, broader experimental flags
FREE_CODE_TEST_NETWORK=1 FREE_CODE_TEST_BINARY="$PWD/cli-dev" bun run test:providers
git diff --check
```

The tests include local mock HTTP services and real CLI tool loops; they need permission to listen on loopback and do not require paid model calls. The inherited snapshot still has whole-project TypeScript diagnostics. A successful build or focused test run is not a claim that the entire source tree type-checks cleanly.

| Document | Contents |
| --- | --- |
| [Provider guide](PROVIDERS.md) | Configuration, routing, credentials, capabilities, and detailed limits. |
| [Independent services](EXTERNAL_SERVICES.md) | Search, web fetch, transcription, browser sessions, and local planning. |
| [Provider evaluation](PROVIDER_EVALUATION.md) | Optional real-model task runner; explicitly enabled calls may incur charges. |
| [Feature audit](FEATURES.md) | Inherited compile-time flags and reconstruction notes. |
| [Development guidance](AGENTS.md) | Repository conventions, resource ownership, verification, and commit workflow. |
| [Upstream change notes](changes.md) | Historical notes inherited from the upstream snapshot. |

For contributions, make a focused branch, follow [AGENTS.md](AGENTS.md), describe the behavior changed, and include relevant verification. Do not commit credentials or personal configuration.

## Provenance and licensing status

This repository is a fork of [freecodexyz/free-code](https://github.com/freecodexyz/free-code), which reconstructs a Claude Code source snapshot. It is an independent project, not an official Anthropic product.

The inherited README identifies the original Claude Code source as Anthropic's property. This repository currently has no repository-wide `LICENSE` file, and this fork does not assert a new blanket license over the inherited source. Dependencies retain their respective notices and terms.
