# Optional provider evaluation

This small evaluation runs the same three local tasks through a selected provider
and model. It is separate from `bun test` and is not a model quality ranking.
No live provider results have been collected as part of adding this runner.

Preview the plan or usage without reading configuration, credentials or starting
the CLI:

```sh
bun tests/fixtures/provider-evaluation.ts
bun tests/fixtures/provider-evaluation.ts --help
```

To run, explicitly supply all four execution options. These requests may incur
provider charges. Use an existing provider profile from [PROVIDERS.md](PROVIDERS.md)
and set only its configured `apiKeyEnv` credential yourself if required. The runner
does not discover, copy or refresh tokens from another application.

```sh
bun tests/fixtures/provider-evaluation.ts \
  --run \
  --binary ./cli \
  --providers-file /absolute/path/to/providers.json \
  --model example/exact-model-id \
  --timeout-ms 120000 \
  --max-turns 8 > example-evaluation.json
```

`--binary` must be an executable CLI entry point. `bun run build` creates `./cli`;
`bun run build:dev:full` creates `./cli-dev`. An executable script must have a
working shebang. Model IDs may contain additional `/` characters after the provider
prefix. Only configured `anthropic`, `openai-completions` and `openai-responses`
endpoints are supported, including keyless endpoints; OAuth and cloud credential
discovery are intentionally outside this runner.

| Scenario | Objective checks |
| --- | --- |
| `read-sentinel` | Exact sentinel returned from a local file. |
| `fix-javascript` | Fix positive-number summation; preserve the visible verifier; pass independent assertions on empty, negative, mixed and fractional inputs. |
| `respect-protected-file` | Write the requested answer and preserve the forbidden file byte for byte. |

Every scenario requires a successful CLI JSON result. Assertions are run again by
the runner after the CLI exits; a model's claim that tests passed is insufficient.
Checks observe final file bytes and behavior, not every intermediate edit or proof
that the model ran a particular command. The last scenario tests a simple explicit
constraint, not resistance to adversarial instructions.

Each scenario gets a fresh temporary workspace, configuration directory and
temporary-file directory. Only the selected profile is copied. The child receives
`PATH`, the selected `apiKeyEnv`, and the runner's temporary/configuration settings;
ambient provider credentials, proxies and shell startup options are not forwarded.
The parent shell and user configuration are unchanged. `--bare`, empty setting
sources, strict MCP configuration, disabled persistence and a fixed tool list keep
the setup consistent. API key values are redacted from the JSON report.

This is not an OS security sandbox. The selected CLI and Bash tools execute with
the current user's permissions; use a disposable account or container for stronger
filesystem/network isolation. POSIX is required for process-group cleanup. Child
process groups are terminated on timeout, cancellation or completion; temporary
directories are removed in `finally` blocks. SIGINT/SIGTERM cancels the active task
and marks remaining tasks cancelled. Forced termination of the runner itself
(such as SIGKILL) cannot guarantee cleanup. Captured output is capped at 1 MiB per
child; exceeding the limit fails that task.

The report contains fixture/schema versions, exact model ID, provider API,
configuration fingerprint, runtime, turn/time limits, per-task checks, CLI output,
usage when reported, and elapsed times. Exit status is `0` for a plan or all passes,
`1` for task failures, `2` for setup errors, and `130` for cancellation. Setup errors
are JSON on stderr. Save a separate report for each model; compare identical
fixture versions, binaries, limits and environments, and repeat runs to measure
variation. Timing and reported usage depend on the provider and are not normalized
scores. These three small tasks do not establish general model quality.
