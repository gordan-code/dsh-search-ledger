# DSH Web Search Billing

[简体中文](./README.md) · **English**

Manage search channels, API keys, and a local cost ledger for DSH's native `web_search` and `web_fetch` tools.

Keep official APIs, relays, and other search services separate within one DSH setup. Route Search and Fetch independently. When a service fails, optionally try alternatives in an order you control—not an unexpected service with an unknown price.

> Version **0.5.1**, targeting **DSH 0.2.1-rc.2**. Costs are **local estimates for requests observed by this plugin**, not provider invoices or model-token usage.

## Features

- **Provider-aware routing:** bind channels to the requesting model provider's ID. Search and Fetch have separate bindings, global overrides, and session overrides.
- **Separate cost tracking:** give official and relay channels their own prices, currencies, and billing policies. Filter by date, channel, source provider, session, and currency.
- **Ordered failover:** opt in to skip engines without a usable key and move on after failures, rate limits, or timeouts. Success, including a valid empty search response, stops the chain.
- **Multiple keys per channel:** enter one key per line. Requests rotate the starting key and try other keys in the same channel before any enabled cross-channel fallback.
- **Individual key tests:** choose Search or Fetch, confirm the potential cost, then test new input or the saved pool. Results are redacted; testing neither saves the input nor switches channels.
- **Persistent local ledger:** record each actual attempt separately and link fallback attempts through an `operationId`. Historical price snapshots survive later price changes.
- **Configuration UI:** manage channels, provider bindings/overrides, and usage in three panels, with dark mode, narrow-panel layouts, keyboard navigation, and windowed long lists.

## Why use it instead of a search-only integration?

The focus is not another search button. It is keeping **routing, availability, and cost evidence** together. These are design choices, not a benchmark or a feature ranking of particular third-party plugins.

| Problem | This plugin's approach | Benefit |
| --- | --- | --- |
| Official and relay APIs share a model name but charge differently | Separate channels, provider bindings, and price snapshots | Relay traffic does not get counted as official traffic |
| Search needs an API, while Fetch should run locally | Independent Search/Fetch routing and overrides | Change one operation without replacing the whole setup |
| A key hits a rate limit or a service times out | Try the channel's other keys, then optionally other channels | Control the order and waiting budget instead of retrying blindly |
| The first attempt times out but the fallback succeeds | Keep a ledger entry for each attempt and flag uncertain outcomes | Earlier attempts are not erased by a successful final result |
| Unknown prices make a dashboard look free | Show known costs, unknown prices, and unconfirmed outcomes separately | A partial estimate does not masquerade as a complete bill |
| Configuring keys requires editing files | Enter a private key pool directly without reading saved keys back | Easier setup without replacing model credentials with the same name |

**A good fit** for DSH users who split traffic across model providers, official APIs, relays, and search services, and want to troubleshoot calls and estimate costs.

**Not a replacement** for account-wide billing, automatic cheapest-provider selection, or unlimited free search. It does not discover public search instances or silently enable paid fallback.

## Supported channels

| Channel | Search | Fetch | Notes |
| --- | :---: | :---: | --- |
| DeepSeek official API | ✓ | ✓ | Independent estimates for each operation |
| DeepSeek-compatible relay | ✓ | ✓ | Must implement the tool API, not just the chat endpoint |
| TinyFish | ✓ | ✓ | Uses the official endpoint for each operation |
| Baidu Qianfan | ✓ | — | Search only; never listed as a Fetch channel |
| Tavily | ✓ | ✓ | basic Search / Extract; credits are conservative local reservations |
| SearXNG | ✓ | — | An instance you host or have permission to use, with JSON output enabled |
| Local HTTP | — | ✓ | Reuses DSH's fetch backend, without a per-call API fee from this plugin |

Provider prices, free allowances, and limits depend on your account plan. Self-hosting, network access, and target websites can still carry costs. This plugin does not promise free or unlimited third-party service.

## Installation

### 1. Build from source

Requires Node.js **≥22.19** and DSH **0.2.1-rc.2**. Other DSH versions have not been verified; do not bypass compatibility checks to force an installation.

```powershell
pnpm install --frozen-lockfile --ignore-scripts
node scripts/check.mjs
npm pack --ignore-scripts
```

This creates `dsh-web-search-billing-0.5.1.tgz`. Installation does not currently require a published npm release.

### 2. Install into a profile

**Fully stop DSH processes using the target DSH_HOME** and back up the profile and plugin data before installing:

```powershell
dsh plugin --profile web add "./dsh-web-search-billing-0.5.1.tgz" --ignore-scripts
```

Replace `web` with your profile. On Windows Desktop, the repository includes a helper that explicitly uses the desktop app's bundled pnpm, avoiding global pnpm/store version mismatches:

```powershell
# Set this to your actual installation if it differs from the helper's default.
$env:DSH_DESKTOP_APP_ROOT = "C:/path/to/DSH Desktop/resources/app"
node ./scripts/desktop-cli.mjs plugin --profile desktop add "./dsh-web-search-billing-0.5.1.tgz" --ignore-scripts
```

Replace the placeholder path. The helper does not change global pnpm/store settings and keeps dependency release-age checks enabled by default. If `minimumReleaseAge` rejects a dependency, investigate or wait rather than deleting the lockfile or disabling protection globally.

For upgrades, stop DSH and install the new package in the same way. Do not mix source-directory links and tarball installs in one profile.

## First-time setup

The current UI uses Chinese labels; the names below include them to help you locate each control.

1. Restart DSH and open **搜索渠道与费用** in the settings sidebar.
2. Add a channel under **渠道管理**, enter its name, endpoint, and prices, and save the channel configuration. New channels start disabled and do not make requests automatically.
3. Enter one key per line in the channel's **API Key** area and save the pool. Saving again **replaces the entire pool**, rather than appending keys. Saved values are never read back into the UI.
4. Under **渠道地址、费率与高级配置**, check **启用** and save the channel configuration. **Saving keys does not enable the channel.**
5. Under **Provider 与覆盖**, bind Search and Fetch to channels for the actual model provider ID, then save. Precedence is **session override → global override → provider binding**.
6. Check that the host's Web backends are `web-search-metered` and `web-fetch-metered`. The installation patch selects them, but higher-priority configuration may override that choice.
7. Make a native tool call and inspect recent records under **用量与费用**. If you want fallback, explicitly enable **有序切换** for the operation and set the channel order and timeout budgets.

No model provider is bound by default, and no paid channel is selected implicitly. See [provider-routing.patch.yml](./examples/provider-routing.patch.yml) for a configuration example; replace its provider IDs, endpoints, and prices.

### Testing keys

Nonempty input tests the keys you just entered. Empty input tests the saved pool or a compatible credential reference. Each key gets one attempt, with a 10-second per-key budget and a 60-second batch budget. Tests do not switch channels or save keys; input remains available to save afterward.

**Tests can incur charges and are recorded in the ledger.** Fetch tests use `https://example.com/`. Timeouts, rate limits, and network failures do not necessarily mean a key is invalid or that the provider did not charge you. Normal request rotation shares a cursor within the current process and resets after restart. Pools support up to 32 keys.

## How costs are counted

The ledger separates billable success, empty results, confirmed failure, unconfirmed outcomes, and unknown prices. The unit is an **actual API attempt**, not a conversation turn. A tool call containing several queries may generate several underlying requests.

- DeepSeek official channels are preset to **5 CNY per 1,000 requests** for each operation. This is a plugin configuration default, not live price synchronization. The default policy confirms billing for HTTP 200 responses with nonempty results.
- Relay channels have independent prices and can use nonempty-success or all-HTTP-200 billing policies. Check that the selected policy matches your service agreement.
- For example, `5 per 1,000 × 10 billable successes = 0.05`. Amounts use integer micro-units internally. CNY and USD stay separate; there is no automatic conversion.
- A dispatched request that times out, disconnects, or returns an unreadable response may remain unconfirmed. A later successful fallback does not remove it. Unknown prices are not treated as zero.
- Only requests routed through this plugin's backends are observed. It cannot reconstruct earlier unobserved calls or cover other plugins, devices, or model-side internal searches.

Tavily credit protection covers only usage visible to this plugin, not your entire account. The same key shares a local allowance across channels/profiles in one DSH_HOME. Other tools, devices, and DSH_HOME directories are outside that protection.

## Data and security boundaries

- Key pools use host credential storage, isolated by DSH_HOME, profile, and channel. Keys are not written to plugin configuration or the ledger, and do not replace same-named model credentials. **Default local host storage is not an encrypted vault.**
- The ledger does not retain keys, Authorization headers, search queries, or page content. It retains channel identity, request attribution, timestamps, outcomes, prices, and related accounting metadata.
- Data lives in `$DSH_HOME/web-search-billing/`. Stop processes sharing the directory before backing it up. Keep the database and its related files together with `installation-salt`; do not copy only an actively written main database.
- A channel with historical records **can still be used normally**. History protection prevents deletion or changing its endpoint identity. Create a new channel to change services, or disable one you no longer need. Renaming or repricing does not recalculate history.
- Old ledger upgrades create a consistent backup first. A failed migration does not automatically delete the ledger. Do not run old and new versions against the same data or roll back by editing only the schema version.

## FAQ

**Why can't I select a saved Qianfan channel?** Enable it in the channel's advanced configuration and save. Disabled channels remain visible with an explanation but cannot be selected. Qianfan supports Search only.

**Why is usage empty after a search?** Check host backend selection, provider bindings, keys, channel enablement, and the date/currency filters. Configured routing does not prove a successful request; calls outside this plugin are not logged.

**Does a historical-record warning mean the channel is unusable?** No. It protects accounting history; it neither disables the channel nor verifies connectivity. An enabled channel with valid credentials and routing can continue to work.

**Does uninstalling erase the ledger?** No. Stop DSH, then run `dsh plugin --profile web remove dsh-web-search-billing`, replacing the profile name. Uninstalling does not automatically erase historical data.

## Development and verification

```powershell
node scripts/check.mjs       # Types, tests, builds, Renderer/packaging contracts
node scripts/test.mjs        # Behavior tests only
node scripts/typecheck.mjs   # Host and Client type checks only
```

The 0.5.1 feature baseline passed 235 behavior tests. The repository also includes packaging, real Renderer Loader, and desktop installer contracts. Browser checks cover post-save dropdowns, narrow panels, dark mode, scaling, and 2,000-item menus. Tests use synthetic keys and mocked responses; **they do not certify every provider account or Electron environment**.

The pinned host development dependencies have documented security limitations. Do not process untrusted archives or replace host dependencies solely for this plugin. When reporting issues, include versions, reproduction steps, and redacted errors—not keys, full diagnostic bundles, or personal profiles.

## License

[MIT](./LICENSE). Bundled dependency licenses are listed in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
