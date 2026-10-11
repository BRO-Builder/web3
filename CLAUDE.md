# CLAUDE.md

This repo holds two things:

1. **Tezos smart contracts** in `contracts/`, written in SmartPy 0.24 (Python).
2. **The BRO Builder Web3 Portal** in `src/`: an internal React + Vite app that deploys and operates those contracts through a Beacon wallet (Taquito).

The contracts form two systems that share the BRO token:

- **Token-DEX-Delegator**: trading, liquidity, the BRO token, and delegating the DEX's XTZ to a baker to earn rewards.
- **Projects-Funding-MarketAssistant**: contractors request loans for projects, investors fund them and earn interest, and the market assistant keeps project income and outgoings fixed in USD.

The detailed contract notes are in **`docs/CONTRACT_NOTES.md`**: units and rounding, the project lifecycle, permissions, pause behaviour, cross-contract interfaces, size limits and the change checklist. Read it before changing a contract. This file is the overview.

## Commands

```sh
# Contracts: each file's @sp.add_test scenario compiles and tests it; output goes to build/<Name>/
.venv/bin/python -m contracts.brotoken
.venv/bin/python -m contracts.brodelegator
.venv/bin/python -m contracts.brodex
.venv/bin/python -m contracts.bromarket
.venv/bin/python -m contracts.brofunding
.venv/bin/python -m contracts.broprojects

# Web app
npm run dev        # local dev server
npm run build      # tsc --noEmit + vite build into dist/
npx wrangler deploy  # deploy dist/ to Cloudflare (run after npm run build)
```

- SmartPy (`smartpy-tezos` 0.24.2) is installed in `.venv`. There is no global `smartpy`.
- There is no JS test suite. `npm run build` is the type check.
- `build/` and `dist/` are gitignored outputs.

## Repo layout

```
contracts/
  brotoken.py       BROToken            FA2 fungible token
  brodelegator.py   BRODelegator        XTZ vault, LP voting, baker delegation
  brodex.py         BRODex              BRO <-> XTZ constant-product AMM
  bromarket.py      BROMarketAssistant  BRO/USD price feed + BRO/XTZ reserve
  brofunding.py     BROFunding          project listings, investor deposits, refunds
  broprojects.py    BROProjects         milestones, repayment, default, settlement, payouts
  utils/common.py   shared types (module `t`) and shared math/views (module `units`)
  utils/helper.py   test-only stubs (DummyFA2, a stub vault, a stub launch target)
src/
  main.tsx          routes
  pages/            one page per tool (see "Internal tools")
  shared/           wallet, storage builders, units, UI controls
docs/CONTRACT_NOTES.md
public/             LEGACY pre-React static pages. Not served (vite publicDir: false). Slated for deletion; don't edit it.
```

## System 1: Token-DEX-Delegator

| Contract | Role |
|---|---|
| `BROToken` | FA2 fungible token: fa2_lib `Fungible` + `OnchainviewBalanceOf`. Other contracts need its `get_balance_of` view and operators. |
| `BRODex` | x·y=k swaps between one FA2 token and XTZ. LP shares, an admin-set fee in bps that stays in the pool, and a pause switch. **It holds no XTZ itself**: incoming XTZ is forwarded to the vault and outgoing XTZ is paid by the vault. Invariant: `vault.accounted == dex.xtz_pool`. |
| `BRODelegator` | The vault. Holds all of the DEX's XTZ and delegates it to a baker. Voting power = LP shares, which the DEX pushes on every change (`sync_shares`). Anyone can call `update_delegate(candidate)`; it succeeds if the candidate meets `quorum_bps` and has strictly more votes than the current delegate. Baker rewards arrive as plain XTZ, and anyone can call `harvest()` to credit the surplus to the DEX pool for LPs. |

Deployment order:
1. `BROToken`
2. `BRODelegator(admin, quorum_bps)`
3. `BRODex(token, token_id, fee_bps, vault=<delegator>, admin)`
4. `delegator.set_dex(<dex>)`. **One-time and irreversible.**
5. Make the DEX an FA2 operator on the token, then `dex.initialize_pool` to seed the first liquidity.

## System 2: Projects-Funding-MarketAssistant

| Contract | Role |
|---|---|
| `BROMarketAssistant` (MA) | An oracle wallet pushes the BRO/USD price (`update_price`). Contracts read it via the `get_price` view, which fails when the price is unset or older than `max_price_age`. Its BRO reserve absorbs the gap between USD obligations and BRO amounts: BROProjects sends it surplus BRO and calls `cover` when short. The admin can withdraw and swap the reserve on BRODex. |
| `BROFunding` | A contractor submits a project: USD budget in cents, fixed interest, term, milestones. Investors deposit BRO, valued in USD at the current price. When the budget is reached, all of the project's BRO and its terms go to BROProjects via `launch`, in the same operation as the closing deposit. If the deadline passes, or the admin cancels, investors refund. |
| `BROProjects` | Splits the BRO into per-milestone escrow. The admin or an approver-NFT holder approves milestones in order, with a late fee. The contractor claims BRO worth the milestone's USD amount at today's price; the MA takes any surplus or covers any shortfall. The contractor then repays budget + interest in USD. On full repayment or default the project settles and investors claim their share (deposit + interest in BRO; the MA covers what it can). |

A project has **the same id on BROFunding and BROProjects**. BROFunding keeps the listing and deposits; BROProjects keeps the progress and reads deposits through BROFunding's `get_investment` view at payout.

Deployment order (System 1 must exist first, because the MA trades on BRODex):
1. `BROMarketAssistant(dex, token, oracle, max_price_age)`
2. `BROFunding(market, token, late_fee_bps_per_day, max_milestones)`
3. `BROProjects(funding, market, token, grace_days)`
4. `funding.set_projects(<projects>)`. **One-time and irreversible.**
5. `market.set_ledger(<projects>)`. It must be BROProjects, not BROFunding.
6. Optional: `projects.set_nft(...)` for NFT approvers.
7. Fund the MA reserve, push a first price, and keep the oracle running.

## Rules that are easy to break

- **Units:** USD is `nat` cents. Price is BRO base units per USD cent × 10^6. Rates are basis points. A month is 30 days. See CONTRACT_NOTES §3.
- **Rounding directions are deliberate.** Each one protects a specific side. Don't change them casually (§3).
- **One-way links:** `delegator.set_dex` and `funding.set_projects` can be called only once, and `BROProjects.funding` has no setter. A BROFunding/BROProjects pair is bound for life; replacing either means redeploying both.
- **Links nothing cross-checks:** `funding.market` and `projects.market` must point to the same MA, and `market.ledger` must be BROProjects. One MA serves one BROProjects.
- **A stale or missing price blocks `invest`, `claim_milestone` and `repay`.**
- **Shared types:** changing anything in `utils/common.py` changes the Michelson of every contract that imports it. On-chain views return `None` on a type mismatch, which surfaces as `*_UNAVAILABLE` errors (§9).
- **Size:** wallets reject large originations well below the 32 KB protocol limit. Re-measure packed size after changes (§12).
- **Project data is public and permanent.** Owner name, phone, email and site address are stored in plain text on BROFunding.
- System 1 (Token-DEX-Delegator) has been audited. System 2 (Projects-Funding-MarketAssistant) has not.

### SmartPy gotchas

- fa2_lib's module is named `t`, which clashes with ours. Use `DummyFA2` in scenarios, not `BROToken`.
- `DummyFA2` **does not enforce operators**, so tests pass even when operator setup is missing. Check real-token flows on a testnet.
- Importing a contract file runs its test, e.g. `broprojects` also runs the `brofunding` scenario.
- Private functions can't call other private functions. Put shared logic in `units`.
- Keep the `total()` balance-conservation check when you extend a scenario, and use `_exception="ERR"` for expected failures.
- Each scenario originates several contracts, including stubs. Use `build/<Name>/log.txt` to find which `step_*_cont_N_contract.*` file is the real contract.

When changing a contract, follow the checklist in CONTRACT_NOTES §14. That includes updating the storage builders in `src/shared/contracts.ts`, and the readers in the sibling `brobuilder-dex` repo (Build Pool pages and the PHP oracle).

## Internal tools (the Web3 Portal)

Every page starts with **1. Network** (ShadowNet by default, Ghostnet or Mainnet, via TzKT RPC) and **2. Wallet** (Beacon connect). Contract addresses are typed in on each page; nothing is preconfigured. The home page (`/`) lists the tools. Each route also works with a `.html` suffix, for old links.

### Deployment

Each deployment page fetches its compiled `.tz` from `static.eidoriantan.com/contracts/` (`CONTRACT_CODE_URLS` in `src/shared/contracts.ts`). You can also paste code into the text area. It then builds the initial storage from the form and originates. The storage builders (`create*Storage`) must match each contract's storage fields exactly.

| Route | Tool | Notes |
|---|---|---|
| `/deployment-ft` | FA2 token | Name, symbol, decimals, total supply (minted to the connected wallet), description, thumbnail. |
| `/deployment-delegator` | BRODelegator | Admin and voting quorum (bps). Deploy this before the DEX. |
| `/deployment-dex` | BRODex | Delegator vault address, token address and id, swap fee (bps), admin. |
| `/deployment-dex-setup` | DEX pool setup | After deploying the DEX: `set_dex` on the vault, add the DEX as token operator, initialize the pool. |
| `/deployment-market` | BROMarketAssistant | BRO token and id, BRODex, oracle address, max price age (seconds), admin. |
| `/deployment-funding` | BROFunding | MA, BRO token and id, late fee (bps/day), max milestones, admin. |
| `/deployment-projects` | BROProjects | BROFunding, MA, BRO token and id, grace period (days), admin. |
| `/deployment-projects-setup` | Projects setup | Takes BROFunding + BROProjects addresses. Links them (`set_projects`, `set_ledger`), funds the MA reserve, pushes the first price, sets the approver NFT, edits rules (late fee, grace days, max price age), pauses, changes the market and transfers admins. Flags mismatched links. |

### Trading and voting

| Route | Tool | Notes |
|---|---|---|
| `/exchange-dex` | Exchange | Swap XTZ ↔ token against a DEX, with live quotes and slippage protection. |
| `/liquidity-dex` | Liquidity | Add liquidity for LP shares, or redeem shares for XTZ + token. |
| `/vote` | Baker voting | Vote for a baker with your LP shares, withdraw your vote, view tallies, and trigger `update_delegate` when a candidate qualifies. |

### Projects

| Route | Tool | Notes |
|---|---|---|
| `/projects` | BRO Projects | Takes BROFunding + BROProjects addresses and reads the MA from them. Shows the price feed (the oracle wallet can push a price here). Submit a project, list projects, and act on one: invest, cancel, refund, approve milestone, claim, repay, mark default, claim payout. Only the actions open to the connected wallet and the project's state are shown. |

Operator handling: `invest` and `repay` pull BRO with FA2 `transfer`. FA2 operators have no allowance, so the pages batch add-operator → call → remove-operator in one operation. Keep that pattern in any new flow.

### Web app code notes

- `src/shared/tezos.ts`: `useWallet()` and the network list. The Beacon timeout is 10 minutes because large originations (BROProjects) take wallets a long time to review.
- `src/shared/contracts.ts`: code URLs, storage builders, and `getErrorMessage` for Beacon/RPC errors.
- `src/shared/broProjects.ts`: price conversions (`priceFromUsd`, `usdFromPrice`, `PRICE_SCALE`), option reading, TzKT token balances.
- `src/shared/units.ts`: `parseUnits` / `formatUnits` with bigint.
- `src/shared/Controls.tsx`: `Page`, `Section`, `NetworkWallet`, `ContractCode` building blocks. Use these for new pages.
- Add a new tool by creating a page in `src/pages/`, adding a route (and its `.html` alias) in `src/main.tsx`, and adding a card in `HomePage.tsx`.
