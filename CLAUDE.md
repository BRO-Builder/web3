# CLAUDE.md

This repo holds two things:

1. **Tezos smart contracts** in `contracts/`, written in SmartPy 0.24 (Python).
2. **The BRO Builder Web3 Portal** in `src/`: an internal React + Vite app that deploys and operates those contracts through a Beacon wallet (Taquito).

The contracts form two systems that share the BRO token:

- **Token-DEX-Delegator**: trading, liquidity, the BRO token, and delegating the DEX's XTZ to a baker to earn rewards.
- **Projects-Funding-MarketAssistant**: contractors request loans for projects, investors fund them and earn daily interest on the money actually drawn, BRO Builder takes a share of that interest, and a funding wallet (gated by the market assistant) keeps project income and outgoings fixed in USD.

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
  bromarket.py      BROMarketAssistant  BRO/USD price feed + gate to the funding wallet
  brofunding.py     BROFunding          project listings, investor deposits, refunds
  broprojects.py    BROProjects         draws, daily interest, hold payouts, repayment, default, settlement, investor claims
  utils/common.py   shared types (module `t`) and shared math/views (module `units`)
  utils/helper.py   test-only stubs (DummyFA2, a stub DEX, a stub launch target)
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
| `BROMarketAssistant` (MA) | An oracle wallet pushes the BRO/USD price (`update_price`). Contracts read it via the `get_price` view, which fails when the price is unset or older than `max_price_age`. It holds no funds: the BRO that absorbs the gap between USD obligations and BRO amounts sits in a plain tz **funding wallet**. BROProjects sends surplus, BRO Builder's interest share and late fees straight to that wallet, and calls `cover` here when short; `cover` pulls BRO from the wallet, which must have made the MA an FA2 operator. BRO only: it never holds or accepts XTZ. |
| `BROFunding` | A contractor submits a project: USD budget in cents, a monthly interest rate (300–900 bps), a term in months (it sizes the interest hold), milestones and an estimated completion. The late fee rate and BRO Builder's share (`builder_share_bps`, admin-set, max 50%) are saved into the listing. Investors deposit BRO, valued in USD at the current price. When the budget is reached, all of the project's BRO and its terms go to BROProjects via `launch`, in the same operation as the closing deposit. If the deadline passes, or the admin cancels, investors refund. |
| `BROProjects` | Splits the BRO into per-milestone escrow. The admin or an approver-NFT holder approves milestones in order. Claiming approved milestones is a **draw**: the first draws withhold the interest hold (budget × monthly rate × term, kept as BRO) and the contractor gets the rest at today's price; the funding wallet takes any surplus or covers any shortfall. Interest runs per day (monthly rate / 30, partial days in full) only on drawn money still outstanding. Every 30 days from launch anyone can call `pay_interest` to pay the interest earned out of the hold: BRO Builder's share to the funding wallet, the rest to investors. The admin-approved end date (initially proposed from `est_completion`) ends the contract period: no more draws, and anyone can `release_undrawn` to give undrawn money back to investors. The contractor repays at any time, in installments (late fee, then interest above the hold, then principal); the total is drawn + interest − hold, plus a late fee once the end date + grace has passed (counted from the end date, max 100%, paid to the funding wallet). On full repayment or default the project settles. Investors `claim_payout` their share of everything allotted to them at any time. |

A project has **the same id on BROFunding and BROProjects**. BROFunding keeps the listing and deposits; BROProjects keeps the progress and reads deposits through BROFunding's `get_investment` view at every investor claim.

Deployment order (System 1 should exist first: the oracle prices BRO from BRODex):
1. `BROMarketAssistant(admin, oracle, funding_wallet, token, token_id, max_price_age)`
2. `BROFunding(admin, market, token, token_id, late_fee_bps_per_day, builder_share_bps, max_milestones)`
3. `BROProjects(admin, funding, market, token, token_id, grace_days)`
4. `funding.set_projects(<projects>)`. **One-time and irreversible.**
5. `market.set_ledger(<projects>)`. It must be BROProjects, not BROFunding.
6. The funding wallet makes the MA an FA2 operator of its BRO, and is funded with BRO.
7. Optional: `projects.set_nft(...)` for NFT approvers.
8. Push a first price, and keep the oracle running.

The worked examples in the rules (e.g. $10,000 at 4%/month for 2 months: hold $800, draws $4,000 + $6,000, repaid $9,760, investors +$392, BRO Builder +$168) are checked in the `broprojects.py` scenario. See CONTRACT_NOTES §5.

## Rules that are easy to break

- **Units:** USD is `nat` cents. Price is BRO base units per USD cent × 10^6. Rates are basis points; `monthly_rate_bps` is per 30 days. `term_months` only sizes the interest hold; the approved end date ends the contract period. See CONTRACT_NOTES §3.
- **Rounding directions are deliberate.** Each one protects a specific side. Don't change them casually (§3).
- **One-way links:** `delegator.set_dex` and `funding.set_projects` can be called only once, and `BROProjects.funding` has no setter. A BROFunding/BROProjects pair is bound for life; replacing either means redeploying both.
- **Links nothing cross-checks:** `funding.market` and `projects.market` must point to the same MA, `market.ledger` must be BROProjects, and the funding wallet must keep the MA as its FA2 operator. One MA serves one BROProjects.
- **A stale or missing price blocks `invest`, `claim_milestone`, `pay_interest`, `repay` and `mark_default`.**
- **Shared types:** changing anything in `utils/common.py` changes the Michelson of every contract that imports it. On-chain views return `None` on a type mismatch, which surfaces as `*_UNAVAILABLE` errors (§9).
- **Size:** wallets reject large originations well below the 32 KB protocol limit. Re-measure packed size after changes (§12).
- **Project data is public and permanent.** Owner name, phone, email and site address are stored in plain text on BROFunding.
- System 1 (Token-DEX-Delegator) has been audited. System 2 (Projects-Funding-MarketAssistant) has not.

### SmartPy gotchas

- fa2_lib's module is named `t`, which clashes with ours. Use `DummyFA2` in scenarios, not `BROToken`.
- `DummyFA2` **enforces operators** like a real FA2, so scenarios must set them up (BRODex's scenario doesn't yet and fails with `FA2_NOT_OPERATOR`). Still check real-token flows on a testnet.
- Importing a contract file runs its test, e.g. `broprojects` also runs the `brofunding` scenario.
- Private functions can't call other private functions. Module-level functions can call each other: put shared logic there or in `units`.
- **Treat `[warning] Error in generated Michelson contract` as a failure** even when the test passes: grep the `.tz` for `# Error`. A local named `o` once caused it (CONTRACT_NOTES §11).
- Views in scenarios run at the time of the last call; snapshot lazy values with `scenario.compute(...)`.
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
| `/deployment-market` | BROMarketAssistant | BRO token and id, funding wallet, oracle address, max price age (seconds), admin. |
| `/deployment-funding` | BROFunding | MA, BRO token and id, late fee (bps/day, default 50), BRO Builder's share of interest (bps, default 3000, max 5000), max milestones, admin. |
| `/deployment-projects` | BROProjects | BROFunding, MA, BRO token and id, grace period (days, default 3), admin. |
| `/deployment-projects-setup` | Projects setup | Takes BROFunding + BROProjects addresses. Links them (`set_projects`, `set_ledger`), funds the funding wallet and lets its owner authorize the MA as operator, sets the oracle and funding wallet, pushes the first price, shows the funding wallet `flows` totals, sets the approver NFT, edits rules (late fee, BRO Builder's share, grace days, max price age), pauses, changes the market and transfers admins. Flags mismatched links. Targets the current contracts only (not the old pair). |

### Trading and voting

| Route | Tool | Notes |
|---|---|---|
| `/exchange-dex` | Exchange | Swap XTZ ↔ token against a DEX, with live quotes and slippage protection. |
| `/liquidity-dex` | Liquidity | Add liquidity for LP shares, or redeem shares for XTZ + token. |
| `/vote` | Baker voting | Vote for a baker with your LP shares, withdraw your vote, view tallies, and trigger `update_delegate` when a candidate qualifies. |

### Projects

| Route | Tool | Notes |
|---|---|---|
| `/projects` | BRO Projects | Takes BROFunding + BROProjects addresses and reads the MA from them. Shows the price feed (the oracle wallet can push a price here). Submit a project (the monthly rate comes read-only from the BRO rate API and must be 3–9%; the form shows the interest hold), list projects, and act on one: invest (with the investor estimate), cancel, refund, approve milestone, draw (showing the hold withheld), pay interest, release undrawn money, propose/approve/reject the end date, repay (with the owed breakdown), mark default, claim payout (with the investor statement). Only the actions open to the connected wallet and the project's state are shown. |

Operator handling: `invest` and `repay` pull BRO with FA2 `transfer`. FA2 operators have no allowance, so the pages batch add-operator → call → remove-operator in one operation. Keep that pattern in any new flow.

### Web app code notes

- `src/shared/tezos.ts`: `useWallet()` and the network list. The Beacon timeout is 10 minutes because large originations (BROProjects) take wallets a long time to review.
- `src/shared/templeChannel.ts`: Temple's own page↔extension protocol. `useWallet()` sends operations with more than 16 KB of JSON (BROFunding and BROProjects originations; BROProjects now packs to ~24 KB) through it instead of Beacon. Beacon's base58 encoding is quadratic, and decoding a request that large stalls Temple's service worker until Chrome kills it. Don't remove this without testing a BROProjects deploy in Temple.
- `src/shared/contracts.ts`: code URLs, storage builders, and `getErrorMessage` for Beacon/RPC errors.
- `src/shared/projectRules.ts`: mirrors the BROProjects math (interest days, hold, amount owed, late fee, 30-day marks, draw split, default date) in bigint seconds and cents. Change it together with `broprojects.py`.
- `src/shared/broProjects.ts`: price conversions (`priceFromUsd`, `usdFromPrice`, `PRICE_SCALE`), option reading, TzKT token balances.
- `src/shared/units.ts`: `parseUnits` / `formatUnits` with bigint.
- `src/shared/Controls.tsx`: `Page`, `Section`, `NetworkWallet`, `ContractCode` building blocks. Use these for new pages.
- Add a new tool by creating a page in `src/pages/`, adding a route (and its `.html` alias) in `src/main.tsx`, and adding a card in `HomePage.tsx`.
