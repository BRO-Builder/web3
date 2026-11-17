# BRO contracts: working notes

Things to keep in mind when changing, testing, deploying or integrating the
contracts in `contracts/`. Most of these are easy to miss: one-way links,
rounding, cross-contract types and the off-chain pieces that depend on them.

**Audit status:** BROToken, BRODex and BRODelegator have been audited.
BROMarketAssistant, BROFunding and BROProjects have **not** been audited yet.

**Rules version:** BROFunding and BROProjects implement the *BRO Capital: New
Projects Contract Rules* (Nov 2026): daily interest on drawn money only, an
interest hold withheld from the first draws, payouts every 30 days, early
repayment, undrawn money back to investors, and BRO Builder's share of
investors' interest. The previously deployed pair keeps the old rules (flat
interest on the whole budget, paid at settlement) and is not compatible with
these sources.

## 1. The contracts and how they connect

| File | Contract | Role |
|---|---|---|
| `brotoken.py` | `BROToken` | FA2 fungible token (fa2_lib `Fungible` + `OnchainviewBalanceOf`) |
| `brodelegator.py` | `BRODelegator` | Holds all of the DEX's XTZ and delegates it to the baker LPs vote for |
| `brodex.py` | `BRODex` | Constant-product BRO ↔ XTZ AMM; its XTZ lives in the delegator |
| `bromarket.py` | `BROMarketAssistant` (MA) | BRO/USD price feed, and the gate to the funding wallet (`cover`) |
| `brofunding.py` | `BROFunding` | Project listings, investor deposits, refunds, cancellation |
| `broprojects.py` | `BROProjects` | Draws, daily interest, hold payouts, repayment, default, settlement, investor claims |

```
      update_price (oracle wallet, PHP job; prices BRO from BRODex off-chain)
                          │
                          ▼
                 BROMarketAssistant ◄──────── cover ─────────── BROProjects
                   │   get_price (view) ──► BROFunding, BROProjects   │  ▲
                   │   get_funding_wallet (view) ──► BROProjects      │  │
                   ▼ pulls BRO (FA2 operator)                         │  │
             funding wallet (tz1) ◄── surplus, builder fee, late fee ─┘  │
                                                                         │
                 BROFunding ── launch (BRO + terms) ─────────────────────┘
                     ▲
                     └── get_investment (view, at every investor claim) ── BROProjects
```

- The **funding wallet** is a plain tz wallet, not a contract. Its address
  is stored on the MA (`funding_wallet`) and read by BROProjects through
  `get_funding_wallet`.
- BRO flows to the wallet as plain FA2 transfers from BROProjects: price
  surplus, BRO Builder's share of interest, and late fees.
- BRO flows from the wallet through `cover`: BROProjects asks the MA, and
  the MA pulls the BRO out of the wallet. This works only while the wallet
  has made the MA an FA2 operator of its BRO.
- The MA handles BRO only. It never holds, receives or swaps XTZ, and every
  entrypoint rejects attached tez. The wallet's owner manages its funds
  (including any swaps on BRODex) directly with their own key.

A project has **one id on both contracts**. BROFunding stores the listing:
title, scope, site, owner, milestone descriptions and deposits. BROProjects
stores the progress: escrow, draws, hold, interest, repayment, settlement and
what investors have been allotted. Readers such as the Build Pool pages
merge the two by id.

## 2. Deployment and linking

Order (each step needs addresses from the ones before it):

1. `BROToken`, then `BRODelegator`, then `BRODex(vault=<delegator>)`, then `delegator.set_dex(<dex>)`.
   Then make the DEX an FA2 operator on the token and call `dex.initialize_pool`.
   The oracle prices BRO from this pool, so it needs liquidity before the first price push. On an empty pool `get_price_token_to_xtz` returns 0.
2. `BROMarketAssistant(admin, oracle=<oracle tz1>, funding_wallet=<tz wallet>, token=<BRO>, token_id, max_price_age)`.
3. `BROFunding(admin, market=<MA>, token=<BRO>, token_id, late_fee_bps_per_day, builder_share_bps, max_milestones)`.
4. `BROProjects(admin, funding=<BROFunding>, market=<MA>, token=<BRO>, token_id, grace_days)`.
5. `funding.set_projects(<BROProjects>)`.
6. `market.set_ledger(<BROProjects>)`.
7. The funding wallet calls `update_operators` on the BRO token: `add_operator(owner=<wallet>, operator=<MA>, token_id)`. Then fund the wallet with BRO.
8. Optional: `projects.set_nft(Some({address, token_id}))` for NFT approvers.
9. Push a first price, then keep the oracle running.

Suggested starting values: `late_fee_bps_per_day` 50 (0.5% a day),
`builder_share_bps` 3000 (30%), `grace_days` 3.

**One-way links. Getting these wrong means redeploying:**
- `delegator.set_dex` can be called only once (`DEX_ALREADY_SET`).
- `funding.set_projects` can be called only once (`PROJECTS_ALREADY_SET`).
- `BROProjects.funding` is set at origination and has **no setter**.

So a BROFunding/BROProjects pair is bound for life. Replacing either one
means deploying a new pair. Investors of the old pair can still refund on
old BROFunding, and claim on old BROProjects, which reads deposits from old
BROFunding.

**Links that must stay in sync. They are separate settings and nothing checks them against each other:**
- `funding.market` and `projects.market` must both point to the same MA.
- `market.ledger` must be **BROProjects**, not BROFunding. Only `ledger` may call `cover`.
- If you replace the MA, update all of these:
  - `funding.set_market`
  - `projects.set_market`
  - `newMA.set_ledger(projects)`
  - the funding wallet's operator approval for the new MA
  - the oracle's `MARKET_ADDRESS`
  - `VITE_MARKET_ADDRESS`
- If you replace the funding wallet (`market.set_funding_wallet`), the new
  wallet must make the MA an operator before any `cover` can succeed.
- The MA serves exactly one ledger. A second BROProjects needs its own MA.

## 3. Units, rates and rounding

| Quantity | Unit |
|---|---|
| USD | `nat` **cents** |
| BRO | token base units (`decimals` from token metadata; the current BRO has 6) |
| Price | **BRO base units per USD cent × 10^6** (`PRICE_SCALE`) |
| `monthly_rate_bps` | interest per 30 days, in bps; 300–900 (3–9%) at submission. Per day: rate / 30 |
| `term_months` | sizes the interest hold only (no deadline is derived from it) |
| `builder_share_bps` | BRO Builder's share of investors' interest; ≤ 5000 (50%) |
| `late_fee_bps_per_day` | late fee per day, in bps of what each installment pays; ≤ 10000 |
| Interest days | per draw: `ceil((to − drawn_at) / 86400)`; a partial day counts in full |
| Late days | `ceil((now − end_date) / 86400)`, counted from the approved end date (grace days included), and only once `now > end_date + grace`; 1 second past grace = grace + 1 days |
| 30-day marks | `funded_at + k × 2,592,000` seconds (counted from launch) |

Formulas (all in cents unless noted):

- **Hold target** = `budget_usd × monthly_rate_bps × term_months / 10000`.
- **Interest(to)** = `(closed_usd_days + Σ outstanding_usd × interest_days(to)) × monthly_rate_bps / 300000`.
  `closed_usd_days` holds the cent-days of principal already repaid; each
  repaid cent is closed at the days it was out.
- **Owed before the late fee** (`base`) = `outstanding principal + interest(now) − hold_usd − interest_paid_usd`, never below 0.
  This is the PDF's "drawn + real interest − hold", less what has been repaid.
- **Late fee rate** = `min(10000, late_days × late_fee_bps_per_day)`. The
  amount due is `base + base × rate / 10000`.
- `usd_to_bro(c) = c × price / 10^6`, `usd_to_bro_up` rounds up, `bro_to_usd(b) = b × 10^6 / price`.
- From USD per BRO: `price = 10^decimals × 10^4 / usd_per_bro`.

Rounding directions (keep them this way; each one protects the side noted):

| Where | Rounds | Effect |
|---|---|---|
| Deposit USD value (`invest`, partial deposit) | down | an investor is never credited more USD than they paid for |
| BRO still needed to close funding | **up** | the closing deposit always reaches the budget exactly |
| Milestone USD shares; escrow per milestone | down, **last takes the remainder** | shares always add up to the budget or the funded BRO |
| Hold target | down | contractor |
| Interest (on the summed cent-days) | down | contractor |
| Draw BRO (`usd_to_bro`, paid part and held part separately) | down | contractor |
| Hold payout BRO (`usd_to_bro`) | down | wallet |
| Builder share of interest BRO | down | investors |
| Partial installment: owed part `usd × 10000 / (10000 + fee rate)` | down | the remainder is late fee |
| Installment BRO (fee, interest and principal each `usd_to_bro_up`) | **up** | investors / wallet; the payer may pay up to 2 base units extra |
| Investor claim `investor_bro × deposit_bro / funded_bro` | down | rounding dust stays in BROProjects |

There is no sweep for dust. It stays in BROProjects permanently.

## 4. Price feed

- The MA's `get_price` view fails with `PRICE_NOT_SET` when the price is 0, and with `PRICE_STALE` when `now − price_updated_at > max_price_age`.
- **A stale or missing price blocks** `invest` (including the closing deposit), `claim_milestone`, `pay_interest`, `repay` and `mark_default`.
- It does not block `approve_milestone`, `release_undrawn`, end-date actions, refunds or `claim_payout`.
- Price-dependent conversions: draws, hold payouts (each at its own day's price), installments, and on default the investors' share of unpaid interest.
- The oracle's heartbeat (`PRICE_HEARTBEAT_SECONDS`, default 2,700) must stay **below** `max_price_age`. Allow for scheduler and inclusion delays.
- The price formula is the BRODex `get_price_token_to_xtz(1 BRO)` view × Coinbase XTZ/USD, computed off-chain.
  - That quote includes the DEX fee, so it is slightly below the spot ratio.
  - The PHP oracle and the pages use the same formula. Change both together.
- The pages quote with the live DEX price, but the contracts charge at the MA's last pushed price. Between pushes the two differ by up to `PRICE_DEVIATION_BPS`.
- On Shadownet, XTZ/USD is still the real Coinbase rate.
- The oracle key must be a revealed **tz1 (ed25519)** account, because the PHP signer only supports ed25519.
- `market.oracle` must equal that key's address, or `update_price` fails with `NOT_ORACLE`.

## 5. Project lifecycle

```
BROFunding:   Funding ──(budget reached)──► Launched ─┐
                 │  └──(deadline passed, first refund)──► Failed
                 └──(admin cancel_project)──► Cancelled
                                                      │ launch
BROProjects:                                          ▼
              Active ──(last milestone drawn, or undrawn released)──► Repaying
                 │                                                       │
                 ├──────────(everything owed repaid)────────────────────►├──► Repaid
                 └──────────(mark_default)──────────────────────────────►└──► Defaulted
```

A worked example (the rules document's case A): $10,000 budget, 4% a month,
2 months, so the hold is $800. $4,000 drawn on day 0 (contractor receives
$3,200), $6,000 on day 30. Real interest: 30 days on $4,000 = $160, plus 30
days on $10,000 = $400, so $560. The contractor repays $10,000 + $560 − $800
= $9,760. Investors get their BRO back plus $392 (70%); the wallet gets $168
(30%). The scenario in `broprojects.py` checks this and the other two cases.

- **Submission (BROFunding):** `budget_usd > 0` and `funding_deadline > now`.
  - `monthly_rate_bps` is 300–900 and `term_months` is 1–60.
  - There are 1 to `max_milestones` milestones, each with `pct_bps > 0` and `duration_days > 0`, and the shares must add up to exactly 10,000.
  - `project_type` must be `residential` or `commercial`.
  - The global `late_fee_bps_per_day` and `builder_share_bps` are **saved into the listing** and passed on at launch. `set_late_fee` (≤ 10,000, `FEE_TOO_HIGH`) and `set_builder_share` (≤ 5,000, `SHARE_TOO_HIGH`) only affect projects submitted afterwards.
- **Listings can't be edited.** A wrong listing can only be cancelled while it is funding.
- **Funding:**
  - `invest` is allowed while `now <= funding_deadline` (inclusive).
  - It takes `min(max_bro, BRO still needed)`, so overfunding is never pulled.
  - The deposit that closes funding transfers **all** of the project's BRO to BROProjects and calls `launch` in the same operation. If `launch` fails, the closing deposit fails.
- **Refund:**
  - Allowed for `Failed`, for `Cancelled`, or for `Funding` once the deadline has passed. The first refund flips the status to `Failed`.
  - A refund deletes the investor's deposit record.
- **Launch:** escrow is split per milestone, with the last taking the remainder. M1 is due `duration_days` after launch. `funded_at` starts the 30-day payout marks. The listing's `est_completion` becomes the pending `proposed_end_date`; `end_date` starts as `None`.
- **End date** (BROProjects). The approved end date is the **end of the contract period**:
  - `propose_end_date(project_id, end_date)`: the contractor, while `Active` or `Repaying`. It replaces any pending proposal.
  - `approve_end_date(project_id, end_date)`: the BROProjects admin. The date must equal the pending proposal (`PROPOSAL_MISMATCH`). `end_date` becomes the proposal and the proposal is cleared.
  - `reject_end_date(project_id)`: the BROProjects admin. Clears the proposal.
  - Until a new proposal is approved, the previously approved `end_date` stays in force; a pending proposal never pauses the late fee or default.
  - Nothing checks the date: the admin can approve one in the past, which ends the period (and may start the late fee) immediately.
  - Without an approved end date there are no late fees, no period end (draws stay open, nothing can be released) and no end-date default.
- **Approval:**
  - Only the **current** milestone can be approved, in order, while `Active`.
  - There is **no milestone late fee**.
  - The next milestone falls due `duration_days` after **this approval**.
- **Draw** (`claim_milestone`, contractor only, `Active` only):
  - Not after the approved end date (`PERIOD_ENDED`).
  - Draws every approved, undrawn milestone. Interest on each starts now (`drawn_at`) on its `usd` (`outstanding_usd`).
  - The hold is withheld first: `min(drawn cents, hold target − hold_usd)`. A small first draw is held in full and the rest comes from later draws. The held part is kept here as BRO at today's price (`hold_bro`).
  - The contractor receives BRO worth the rest at today's price.
  - If the escrow exceeds what's needed (BRO rose), the surplus goes to the wallet. If it is short (BRO fell), the wallet covers it. If the wallet can't, **the draw fails**.
  - Drawing the last milestone moves the project to `Repaying`.
- **Hold payouts** (`pay_interest`, anyone):
  - Pays the interest earned up to the latest 30-day mark, capped at the hold withheld so far, at today's price. The builder share goes to the wallet; the rest is allotted to investors (`investor_bro`).
  - A mark is paid once (`paid_until`). `claim_milestone` and `repay` pay the passed marks first, so each mark uses the balances as they stood at it.
  - If the hold BRO can't fund the payout (BRO fell), investors are paid first and the wallet covers their gap. If the wallet can't, the call fails (and so does the draw or repayment that triggered it). Nothing is due → `NOTHING_TO_PAY`.
  - Interest above the hold (only possible past the term or late) is not paid from the hold; the contractor pays it with installments.
- **Undrawn money** (`release_undrawn`, anyone): after the approved end date, allots the escrow of every undrawn milestone back to investors, as the BRO they deposited. Once only (`ALREADY_RELEASED`); the project moves to `Repaying`. Settlement does the same.
- **Repayment** (`repay`, anyone, `Active` or `Repaying`, at any time):
  - The amount due is `base` plus the late fee on it (§3). Overpayment is capped.
  - Each installment pays, in order: the late fee on what it pays, interest above the hold, then principal. Principal reduces the oldest draws first and stops their interest from that day.
  - The installment's parts go: late fee → wallet; interest → builder share to the wallet, the rest to investors at once; principal → held until settlement (`repaid_bro`).
  - Paying everything due settles the project: the unused hold comes off the debt, the last hold payout runs to now, and undrawn money is released.
  - **Early exit:** while undrawn milestones remain and the period is open, only the contractor may make the payment that settles (`NOT_CONTRACTOR`). Otherwise anyone could pay a $0 balance and close a fresh project. With nothing drawn, the contractor exits with `repay(0)`.
  - **Late fee:** none up to `end_date + grace`. After that, every day since `end_date` itself counts, so 1 second past grace charges grace + 1 days at once. Capped at 100%. It keeps growing while BROProjects is paused.
- **Settlement** happens on full repayment or `mark_default`.
  - Investors are owed the BRO deposited for the drawn milestones (undrawn escrow is released separately), plus any last hold payout the hold BRO couldn't fund, plus on default their share of the unpaid interest above the hold.
  - The pool is the repaid principal BRO plus what is left of the hold BRO.
  - Any excess goes to the wallet. Any shortfall is covered by the wallet as far as its balance allows (less covers already requested in the same call), and the rest is recorded as `uncovered_bro`. **Settlement is never blocked by a thin wallet.**
- **Default** (`mark_default`, approvers):
  - Possible after the approved `end_date + grace`, or, while `Active`, after the current milestone's `due_at + grace`. Both are strict `>`.
  - Needs a fresh price.
  - The amount owed at that moment (with the late fee) is recorded in `default_due_usd` but not collected.
  - The hold pays the interest earned so far; the unused hold, the repaid principal and the undrawn escrow go to investors. Approved-but-undrawn milestones are **not** paid to the contractor.
- **Investor claims** (`claim_payout`, any time): pays the investor's share of `investor_bro` (interest payouts, released undrawn money, settlement) in proportion to their deposit, minus what they've already claimed (`payouts_claimed`). Nothing new → `NOTHING_TO_CLAIM`.
- **Grace days are read live** by `repay`, `mark_default` and `get_amount_due`. Changing `grace_days` moves the late-fee start and default date of every live project, unlike the late fee rate and builder share.

## 6. Where the BRO sits

| Stage | BRO held by |
|---|---|
| Funding | BROFunding (sum of `funded_bro` of `Funding` projects, plus not-yet-refunded `Failed`/`Cancelled` deposits) |
| Active / Repaying | BROProjects: undrawn escrow + `hold_bro` + `repaid_bro` + `investor_bro` not yet claimed |
| Repaid / Defaulted | BROProjects: `investor_bro` not yet claimed, plus dust |
| Funding wallet | price surplus, builder fees and late fees; the source of covers |

`flows` on each project, and the contract-wide `flows` in storage, record what
went to and came from the wallet: `builder_fee_bro`, `late_fee_bro`,
`surplus_bro` (price gains) and `covered_bro` (price losses paid in). When a
call both sends to and covers from the wallet, only the net is transferred,
but both are recorded in full.

The tests check that the total is conserved across every account and contract
(`total()` in the scenarios). Keep that check when adding flows.

**Funding wallet sizing:** the wallet funds draw shortfalls and hold-payout
shortfalls, where too little blocks the call, and settlement shortfalls,
where too little leaves investors short (`uncovered_bro`). Moving BRO out of
the wallet directly reduces what open projects can draw on.

## 7. Permissions

| Action | Who |
|---|---|
| `submit_project` | anyone (becomes `contractor`) |
| `invest`, `refund` | anyone (refund: their own deposit) |
| `cancel_project`, `set_late_fee`, `set_builder_share`, `set_market`, `set_projects`, `set_admin`, `pause` on BROFunding | BROFunding admin |
| `launch` | BROFunding contract only (`NOT_FUNDING_CONTRACT`) |
| `claim_milestone`, `propose_end_date` | the project's contractor |
| `approve_end_date`, `reject_end_date` | BROProjects admin only (not NFT approvers) |
| `repay` | anyone (the payer's BRO is pulled); only the contractor for an early exit with undrawn milestones |
| `pay_interest`, `release_undrawn` | anyone |
| `claim_payout` | investors with a deposit on BROFunding |
| `approve_milestone`, `mark_default` | **BROProjects admin, or anyone holding > 0 of the configured NFT** |
| `set_nft`, `set_grace_days`, `set_market`, `set_admin`, `pause` on BROProjects | BROProjects admin |
| `update_price` | MA `oracle` |
| `cover` | MA `ledger` (BROProjects) |
| `set_admin`, `set_oracle`, `set_max_price_age`, `set_ledger`, `set_funding_wallet` on the MA | MA admin |

- **NFT approvers:** the check is live. Whoever holds the token at call time can approve, so transferring the NFT transfers the right.
- **Transferring an admin role:** the BROProjects admin is always an approver too.
- **Admins:** there is no multisig or timelock, and each contract has its own admin. `set_admin` takes effect immediately and can't be undone by the old admin.

## 8. Pause behaviour

| Contract | Paused blocks | Still works |
|---|---|---|
| BROFunding | `submit_project`, `invest`, `refund` | admin actions; `launch` can't happen (it needs `invest`) |
| BROProjects | `claim_milestone`, `pay_interest`, `repay`, `claim_payout` | `approve_milestone`, `mark_default`, `release_undrawn`, `launch`, end-date propose/approve/reject, admin actions |
| BRODex | liquidity and swaps | `credit_rewards` |

**Interest and late fees keep accruing while BROProjects is paused,** because
`repay` is blocked but the clock and the end date don't move. The admin can
approve a later end date during a pause if that is unfair. Deadlines don't
move either: a long pause can make projects defaultable.

## 9. Cross-contract interfaces (do not change one side only)

Shared types live in `contracts/utils/common.py` (module `t`), and the shared
math and view helpers live in its `units` module. Changing a shared type
changes the Michelson of **every** contract that uses it, which means
recompiling, redeploying and updating readers.

| Interface | Caller → callee | Must match |
|---|---|---|
| `launch(t.launch_params)` | BROFunding → BROProjects | record fields and layout (includes `monthly_rate_bps`, `builder_share_bps`, `est_completion`) |
| `get_investment(t.investment_key) → t.investment` | BROProjects → BROFunding view | name, input and output type |
| `get_price() → nat` | BROFunding/BROProjects → MA view | name, unit (see §3) |
| `get_funding_wallet() → address` | BROProjects → MA view | name and type |
| `cover(t.cover_params)` | BROProjects → MA | record `{to_, amount}` |
| `get_balance_of(list[balance_of_request]) → list[balance_of_response]` | BROProjects → BRO token and NFT | fa2_lib layout |
| `transfer`, `update_operators` | all → BRO FA2 | FA2 standard layouts |
| `get_price_token_to_xtz(nat) → mutez` | oracle + pages → BRODex view | name and types |

- **On-chain views fail silently as `None` on a type mismatch.** The callers turn that into `PRICE_UNAVAILABLE`, `MARKET_VIEW_UNAVAILABLE`, `BALANCE_VIEW_UNAVAILABLE` or `FUNDING_VIEW_UNAVAILABLE`. If you see one of these, check the view's name and types first.
- **The NFT contract must expose the `get_balance_of` on-chain view** (fa2_lib `OnchainviewBalanceOf`). In fa2_lib, `get_balance` is **off-chain only**, so it doesn't count.
- **The BRO token must support `get_balance_of` and operators.** The current BROToken does.
- BROProjects views: `get_amount_due(project_id)` returns the cents to pay now to settle (with the late fee; 0 once repaid; `default_due_usd` once defaulted). `get_project(project_id)` returns the whole record but nothing calls it on-chain (~940 bytes; a candidate to drop, §12).

## 10. FA2 operators

- BROFunding (`invest`) and BROProjects (`repay`) pull BRO with `transfer from_=sender`. The payer must first make that contract an FA2 operator.
  - FA2 operators have **no allowance**: an operator can move the owner's entire balance.
  - The pages therefore batch add-operator → call → remove-operator in one operation. Anything else integrating should do the same.
- The **funding wallet must keep the MA as an operator** of its BRO for `cover`. This approval is permanent by design (covers happen inside other people's calls), so the wallet should hold only the BRO meant to back projects.
- BROProjects sends its own BRO in one FA2 batch per call (pull from the payer first, then payouts), after any `cover`.
- **`DummyFA2` in `utils/helper.py` enforces operators,** like a real FA2. Scenarios must set operators up. (BRODex's scenario still doesn't, so it fails with `FA2_NOT_OPERATOR`.)

## 11. SmartPy gotchas (0.24)

- **Module name collisions:**
  - fa2_lib's own module is named `t`, which clashes with ours, so `BROToken` can't share a test scenario with our contracts. Use `DummyFA2` instead.
  - BRODex's module is named `main`, the same as fa2_lib's `main`.
- **Private functions can't call other private functions.** Module-level functions can call each other, so shared pure logic (`interest`, `late_bps`, `owed`, `add_flows`) lives at module level. Privates return amounts and the entrypoint does the transfers through one `pay_` call.
- **A local named `o` produced broken Michelson** in BROProjects (`cannot unify branches`, operations dropped). SmartPy only prints `[warning] Error in generated Michelson contract: previous error`, and the test still passes. Treat that warning as a failure: grep the `.tz` for `# Error` to find the spot.
- **Importing a contract file runs its `@sp.add_test`.** For example, `broprojects.py` imports `brofunding.py`, so the funding test runs too.
- **In scenarios:**
  - Compare unit variants as `sp.variant.Active(sp.unit)`.
  - Read maps with default values as `.get(key, sp.nat(0))`, not `default=`.
  - Use `_exception="ERR"` so that a failure for the wrong reason is caught.
  - Views like `get_amount_due` run at the time of the **last call**: make a call (e.g. a price push) at the time you want first.
  - `bal(x)` is a lazy expression. Snapshot it with `scenario.compute(...)`.
  - `a - b` on nats is an `int`; compare as `a + b == c` instead.
- **Picking files from `build/`:** each scenario originates several contracts, including stubs and dummy tokens. Pick the right `step_*_cont_N_contract.json` from `build/<Name>/log.txt` ("file ... contract BROProjects"). The market assistant's scenario writes to `build/BROMarket/`.
- **SmartPy's `.tz` output is huge,** because it annotates every instruction with the stack type. The upload files in `build/upload/` are compacted versions without those annotations.

## 12. Size limits

The protocol limit is 32 KB per operation, but wallets refuse much smaller
originations. This is why BROLedger was split.

Current packed code sizes:

| Contract | Bytes |
|---|---|
| BROProjects | 24,271 |
| BROFunding | 7,444 |
| BRODex | 5,881 |
| BROToken | 5,345 |
| BRODelegator | 2,892 |
| BROMarketAssistant | 1,932 |

BROProjects grew from 13,806 bytes with the new rules. Most of it is in
`repay` (~4.1 KB), `mark_default` (~2.4 KB), `claim_milestone` (~2.1 KB) and
`get_amount_due` (~1.4 KB, which recompiles the interest math). Its
origination is above the portal's 16 KB JSON threshold, so it goes through
the Temple channel (see `CLAUDE.md`). Test it on a testnet before relying on it.

Each `.tz` also contains the storage and parameter types. Big record types,
like `t.listing` and `t.project`, are repeated wherever they're used: in
big_map types, view return types and lambdas.

To shrink a contract:
- Drop on-chain views nothing calls. For example, `BROProjects.get_project` is about 940 bytes and isn't used.
- Avoid duplicating large records.
- Use fewer private helpers that capture big types.
- A balanced `.layout(...)` on `t.project` was tried and made BROProjects *larger* (25,507 bytes).

Re-measure after every change with `packDataBytes` from `@taquito/michel-codec`.

## 13. Data, privacy and storage

- **Project details are public and permanent.** Site address, owner name, phone and email are stored on BROFunding in plain text and can't be removed. Even a cancelled listing keeps them in chain history.
- **Big map entries are never deleted,** except a deposit on refund. Storage grows with every project, and the sender pays the storage burn.
- **Bound loops:** `max_milestones` bounds the loops in submit, launch, draws, interest, repayment, release and settlement. Raising it raises the gas cost of those calls.

## 14. Checklist when changing a contract

1. Update the shared types in `utils/common.py` if an interface changes, and check every contract that imports them (§9).
2. Keep the rounding directions (§3) and the permission and pause behaviour (§7, §8), or change them deliberately and document it here.
3. Extend the scenario for every new path. Use `_exception`, keep the balance-conservation `total()` check, and cover price-up and price-down cases.
4. Run every scenario: `.venv/bin/python -m contracts.<name>` for `brotoken brodelegator brodex bromarket brofunding broprojects`. Treat the "Error in generated Michelson contract" warning as a failure (§11).
5. Re-measure the packed size (§12).
6. Rebuild the compacted upload files in `build/upload/` (`build/` is gitignored), and republish them where the deployment pages fetch them (`CONTRACT_CODE_URLS` in `src/shared/contracts.ts`).
7. Update the readers that mirror storage or entrypoints:
   - **Build Pool pages** (brobuilder-dex): `src/shared/ledger.ts` parses BROFunding and BROProjects storage by field name, and mirrors the late-fee, default-date, entitlement and payout formulas. The pages call entrypoints by name.
   - **PHP oracle** (brobuilder-dex `server/oracle`): it calls `update_price` and the DEX view, and reads MA storage (`price`, `price_updated_at`, `oracle`) from TzKT.
   - **Portal** (this repo, `src/`):
     - `src/shared/contracts.ts`: the `create*Storage` builders must list every storage field of each contract.
     - `src/pages/ProjectsPage.tsx`: parses BROFunding and BROProjects storage by field name, mirrors the late-fee, amount-due and default-date formulas, and calls entrypoints by name.
     - `src/pages/ProjectsSetupPage.tsx`: the linking, rules, pause and admin steps (§2).
8. Redeploy everything whose Michelson changed. Remember that the BROFunding/BROProjects pair has to be replaced together (§2).

**Pending (new rules):** steps 6–8 have not been done for the new
BROFunding/BROProjects. The portal and the Build Pool pages still read and
call the old pair's layout: `interest_bps` instead of `monthly_rate_bps`, no
`builder_share_bps` in `createFundingStorage`, the old project fields in
`createProjectsStorage`, and no `pay_interest` or `release_undrawn` actions.
