# DSH Search Ledger

[简体中文](./README.md) · **English**

Channel management and cost tracking for DSH's native `web_search` and `web_fetch` tools.

If you use DeepSeek's official API alongside a relay or another search service, you need to decide where each request goes, what happens when it fails, and how to count the cost. This plugin puts those settings and records in one place. Bind search channels to model providers, manage each channel's keys, and inspect the actual requests in a local ledger.

Version **0.5.1** targets **DSH 0.2.1-rc.2**. It tracks search and fetch requests routed through the plugin, not model-token usage. The costs shown are local estimates, not provider invoices.

## Features

- Route Search and Fetch separately, with provider bindings, global overrides, and session overrides.
- Give official and relay channels their own prices, currencies, and billing policies.
- Save several keys per channel, one per line. Normal requests rotate the starting key and try other keys in the same channel after a failure.
- Enable ordered failover when you need it. Engines without a usable key are skipped; failures, rate limits, and timeouts move to the next configured channel. Success, including a valid empty search result, stops the chain.
- Keep a record of each actual attempt. Related fallback attempts share an `operationId`, and historical records keep the price used at the time of the request.
- Filter usage by date, channel, source provider, session, and currency. The UI supports dark mode, narrow panels, keyboard navigation, and long dropdown lists.

You can enter keys directly in the UI and test them individually. Tests ask you to confirm the potential cost first. They do not save your input or switch to another channel.

## What makes it different from a search API integration?

The extra piece here is the connection between request routing and accounting.

For example, Search from your official DeepSeek model provider can use the official API, Search from a relay-backed provider can use the relay, and Fetch can use local HTTP for both. Each channel keeps its own price and credentials. Changing one operation does not require replacing the whole search setup.

Failed attempts stay in the ledger too. If the first channel times out and the second succeeds, that does not mean only one request was made. The earlier attempt is kept, with its outcome marked as unconfirmed when necessary. A missing price is shown as unknown rather than free.

This is useful when you split requests across providers and search services, or need to work out where a call went and why costs changed. It does not sync account-wide bills, choose the cheapest service, collect public search instances, or silently enable paid fallback. This describes the plugin's approach, not test results for a particular third-party plugin.

## Supported channels

| Channel | Search | Fetch | Notes |
| --- | :---: | :---: | --- |
| DeepSeek official API | ✓ | ✓ | Search and Fetch are priced separately |
| DeepSeek-compatible relay | ✓ | ✓ | Must support the tool API; a chat endpoint alone is not enough |
| TinyFish | ✓ | ✓ | Uses the official endpoint for each operation |
| Baidu Qianfan | ✓ | — | Search only |
| Tavily | ✓ | ✓ | basic Search / Extract; credits are reserved conservatively in the local ledger |
| SearXNG | ✓ | — | Use an instance you host or have permission to access, with JSON output enabled |
| Local HTTP | — | ✓ | Reuses DSH's fetch backend, without a per-call API fee from this plugin |

Prices, free allowances, and limits depend on your provider's account plan. SearXNG and local fetching still involve hosting, network, and website-access costs. They are not a promise of unlimited free use.

## Installation

Requires Node.js **≥22.19** and **DSH 0.2.1-rc.2**. Other DSH versions have not been verified. Do not bypass the compatibility check to force an installation.

### Install from npm

`dsh-search-ledger@0.5.1` is published on npm. Stop all DSH processes sharing this DSH_HOME and back up the target profile and plugin data before installing:

```powershell
dsh plugin --profile web add "dsh-search-ledger@0.5.1" --ignore-scripts
```

Replace `web` with your profile name. A plain `npm install dsh-search-ledger@0.5.1` only adds the package to the current Node project; it does not register the plugin or apply its patch in DSH. Stop DSH before updating, and do not keep the old and new packages in the same profile.

The repository does not provide a prebuilt tarball. If `minimumReleaseAge` rejects a dependency, check it or wait for the required age. Do not delete the lockfile or disable protection globally as a shortcut.

### Switching from the old name

The project was previously called `dsh-web-search-billing` and is now `dsh-search-ledger`. The version remains 0.5.1; the rename does not change billing behavior.

If the old package is installed, stop DSH and back up the profile and `$DSH_HOME/web-search-billing/` first. Remove the old package before installing the new one. Do not install both in the same profile: they share configuration entries and tool backends and will conflict.

```powershell
dsh plugin --profile web remove dsh-web-search-billing
dsh plugin --profile web add "dsh-search-ledger@0.5.1" --ignore-scripts
```

On Desktop, use `desktop` as the profile for the corresponding `remove` / `add` commands. Internal configuration keys, credential identifiers, and the `web-search-billing` data directory keep their old names. Do not rename or delete them. After switching, check channel settings, key status, provider bindings, and historical usage before making requests.

## Configuration

After restarting DSH, open **DSH 搜索账本** in the settings sidebar. The UI currently uses Chinese labels; they are included below so you can find the controls.

1. Add a channel under **渠道管理**, enter its name, endpoint, and prices, then save the channel configuration. New channels start disabled and do not send requests automatically.
2. Expand the channel, enter one key per line under **API Key**, and save the pool. Saving again replaces the whole pool; it does not append keys. Saved values are not displayed.
3. Under **渠道地址、费率与高级配置**, check **启用** and save the channel configuration again. Saving keys and enabling a channel are separate steps.
4. Under **Provider 与覆盖**, select Search and Fetch channels for the actual model provider ID, then save. Precedence is: session override → global override → provider binding.
5. Check that the host Web tools use `web-search-metered` and `web-fetch-metered`. Make a native tool call, then check the recent records under **用量与费用**.

The installation patch selects those backends, but higher-priority configuration can override it. The plugin does not bind model providers by default or choose a paid channel when no binding exists.

To use fallback, enable **有序切换** for the operation, set the channel order, and adjust the timeout budgets. See [provider-routing.patch.yml](./examples/provider-routing.patch.yml) for an example. Replace its provider IDs, endpoints, and prices with your own.

### Testing keys

Select Search or Fetch, then click **测试 Key**. If the input contains keys, those are tested. Otherwise, the test uses the saved pool or compatible credential reference. Your input stays in the field afterward; saving it is a separate action.

Each key gets one attempt, with a maximum of 10 seconds per key and 60 seconds for the batch. Tests do not switch channels, but **they can incur charges and are recorded in the ledger**. Fetch tests use `https://example.com/`. A timeout, rate limit, or network error does not necessarily mean a key is invalid or that the provider did not charge you.

Pools support up to 32 keys. The rotation cursor for normal requests is shared within the current process and resets after a restart.

## How costs are counted

The unit is an actual API attempt, not a conversation turn. One tool call with several queries can send several underlying requests.

DeepSeek official channels default to **5 CNY per 1,000 requests** for both Search and Fetch, with billing confirmed for HTTP 200 responses containing nonempty results. These are plugin defaults, not prices synchronized with the provider. Relay channels have their own prices and can use nonempty-success or all-HTTP-200 billing. Check the policy against your service agreement.

At 5 CNY per 1,000 requests, 10 billable successes cost 0.05 CNY. Amounts use integer micro-units internally. CNY and USD are shown separately, without automatic conversion.

The ledger separates billable success, empty results, confirmed failures, unconfirmed outcomes, and unknown prices. Once a request has been sent, a timeout, disconnection, or unreadable response can leave its billing status uncertain. It is not simply treated as free, and a later successful fallback does not remove the earlier attempt.

Only requests through this plugin's backends are counted. It cannot account for other plugins, devices, model-side internal searches, or earlier calls it did not observe.

Tavily credits are also a local safeguard. Within one DSH_HOME, the same key shares an allowance across channels and profiles. Usage from other tools, devices, or DSH_HOME directories is not visible here, so this cannot guarantee an account-wide spending limit.

## Data and backups

Key pools use the host's credential storage, isolated by DSH_HOME, profile, and channel. They are not written into plugin configuration or the ledger, and do not replace model credentials with the same name. Default local host storage is not an encrypted vault; protect your local account and files.

The ledger does not retain keys, Authorization headers, search queries, or page content. It keeps accounting metadata such as channel identity, request attribution, timestamps, outcomes, and prices. Data lives in `$DSH_HOME/web-search-billing/`.

Stop processes sharing that directory before making a backup. Keep the database and its related files together with `installation-salt`; do not copy only an actively written main database. Old ledger upgrades create a consistent backup first, and a failed upgrade does not automatically delete the ledger. Do not run old and new versions against the same directory or roll back by editing only the schema version.

A channel with historical records can still be used normally. History protection prevents deletion or changes to its endpoint identity. Create a new channel to change services, or disable one you no longer use. Changing a name or price does not recalculate historical costs.

## FAQ

### Why can't I select a saved channel?

Check **启用** in the channel's advanced configuration and save. Disabled channels show a reason but cannot be selected. Qianfan supports Search only, so it does not appear in the Fetch dropdown.

### Why is usage empty after a search?

Check the host backends, provider bindings, keys, and channel enablement, then the date and currency filters. A configuration that looks correct does not prove a request succeeded. Calls outside the plugin are not recorded either.

### Does “已有请求记录” mean the channel is unusable?

No. That warning protects accounting history. It does not disable the channel or test connectivity. An enabled channel with valid credentials and routing can still be used.

### Does uninstalling delete the ledger?

No. Stop DSH, then run this command with your actual profile name instead of `web`:

```powershell
dsh plugin --profile web remove dsh-search-ledger
```

Uninstalling does not automatically erase historical data.

## Development

```powershell
node scripts/check.mjs       # Types, tests, builds, and packaging contracts
node scripts/test.mjs        # Behavior tests only
node scripts/typecheck.mjs   # Host and Client type checks only
```

The 0.5.1 feature baseline passed 235 behavior tests. The repository also includes contracts for packaging, the real Renderer Loader, and the desktop installer. Browser checks cover post-save dropdowns, narrow panels, dark mode, scaling, and 2,000-item menus.

These checks use synthetic keys and mocked responses. They do not mean every provider account or Electron environment has been tested. The pinned host development dependencies still have documented security limitations. Do not process untrusted archives or replace host dependencies solely for this plugin.

When reporting a problem, include the version, steps to reproduce it, and redacted errors. Do not upload keys, full diagnostic bundles, or personal profiles.

## License

[MIT](./LICENSE). Bundled dependency licenses are listed in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
