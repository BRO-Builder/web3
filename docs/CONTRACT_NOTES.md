# BRO contracts: working notes

Things to keep in mind when changing, testing, deploying or integrating the
contracts in `contracts/`. Most of these are easy to miss: one-way links,
rounding, cross-contract types and the off-chain pieces that depend on them.

**Audit status:** BROToken, BRODex and BRODelegator have been audited.
BROMarketAssistant, BROFunding and BROProjects have **not** been audited yet.

## 1. The contracts and how they connect

| File | Contract | Role |
|---|---|---|
| `brotoken.py` | `BROToken` | FA2 fungible token (fa2_lib `Fungible` + `OnchainviewBalanceOf`) |
| `brodelegator.py` | `BRODelegator` | Holds all of the DEX's XTZ and delegates it to the baker LPs vote for |
| `brodex.py` | `BRODex` | Constant-product BRO ↔ XTZ AMM; its XTZ lives in the delegator |
| `bromarket.py` | `BROMarketAssistant` (MA) | BRO/USD price feed plus a BRO/XTZ reserve that absorbs USD↔BRO gaps |
| `brofunding.py` | `BROFunding` | Project listings, investor deposits, refunds, cancellation |
| `broprojects.py` | `BROProjects` | Milestones, claims, repayment, default, settlement, payouts |

```
             update_price (oracle wallet, PHP job)
                          │
                          ▼
 BRODex ◄── swaps ── BROMarketAssistant ◄── cover / surplus BRO ── BROProjects
   │                      ▲  get_price (view)                       ▲   │
   │ XTZ                  └──────────────── BROFunding ── launch ───┘   │
   ▼                         get_price (view)   ▲                       │
 BRODelegator                                   └── get_investment ─────┘
                                                    (view, at payout)
```

A project has **one id on both contracts**. BROFunding stores the listing:
title, scope, site, owner, milestone descriptions and deposits. BROProjects
stores the progress: escrow, due dates, approvals, repayment and settlement.
Readers such as the Build Pool pages merge the two by id.

## 2. Deployment and linking

Order (each step needs addresses from the ones before it):

1. `BROToken`, then `BRODelegator`, then `BRODex(vault=<delegator>)`, then `delegator.set_dex(<dex>)`.
   Then make the DEX an FA2 operator on the token and call `dex.initialize_pool`.
   The oracle prices BRO from this pool, so it needs liquidity before the first price push. On an empty pool `get_price_token_to_xtz` returns 0.
2. `BROMarketAssistant(dex=<dex>, token=<BRO>, oracle=<oracle tz1>, max_price_age=...)`.
3. `BROFunding(market=<MA>, token=<BRO>, late_fee_bps_per_day, max_milestones)`.
4. `BROProjects(funding=<BROFunding>, market=<MA>, token=<BRO>, grace_days)`.
5. `funding.set_projects(<BROProjects>)`.
6. `market.set_ledger(<BROProjects>)`.
7. Optional: `projects.set_nft(Some({address, token_id}))` for NFT approvers.
8. Push a first price, then keep the oracle running.

Every step has a page in this repo's portal (`src/`): `/deployment-ft`,
`/deployment-delegator`, `/deployment-dex`, `/deployment-dex-setup` (`set_dex`,
operator and pool), `/deployment-market`, `/deployment-funding`,
`/deployment-projects`, then `/deployment-projects-setup` for steps 5–8,
reserve funding, rules, pause, `set_market` and `set_admin`.

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
  - the oracle's `MARKET_ADDRESS`
  - `VITE_MARKET_ADDRESS`
- The MA serves exactly one ledger. A second BROProjects needs its own MA.

The Build Pool Admin page (brobuilder-dex) and this repo's Projects Setup
page (`/deployment-projects-setup`) flag mismatched market and token links,
but only those they can see.

## 3. Units and rounding

| Quantity | Unit |
|---|---|
| USD | `nat` **cents** |
| BRO | token base units (`decimals` from token metadata; the current BRO has 6) |
| Price | **BRO base units per USD cent × 10^6** (`PRICE_SCALE`) |
| Rates | basis points out of 10,000 (interest, late fee per day, DEX fee, quorum) |
| Month | 30 days (term = `term_months × 30 days`) |
| Late days | `ceil((approved_at − due_at) / 86400)`; 1 second late = 1 day |

- `usd_to_bro(c) = c × price / 10^6`
- `bro_to_usd(b) = b × 10^6 / price`
- From USD per BRO: `price = 10^decimals × 10^4 / usd_per_bro`

Rounding directions (keep them this way; each one protects the side noted):

| Where | Rounds | Effect |
|---|---|---|
| Deposit USD value (`invest`, partial deposit) | down | an investor is never credited more USD than they paid for |
| BRO still needed to close funding | **up** | the closing deposit always reaches the budget exactly |
| Milestone USD shares; escrow per milestone | down, **last takes the remainder** | shares always add up to the budget or the funded BRO |
| Milestone claim (`usd_to_bro(net_usd)`) | down | contractor |
| Repayment installment (`usd_to_bro_up`) | **up** | investors |
| Payout `settled_pool × bro / funded_bro` | down | rounding dust stays in BROProjects |

There is no sweep for dust. It stays in BROProjects permanently.

## 4. Price feed

- The MA's `get_price` view fails with `PRICE_NOT_SET` when the price is 0, and with `PRICE_STALE` when `now − price_updated_at > max_price_age`.
- **A stale or missing price blocks** `invest` (including the closing deposit), `claim_milestone` and `repay`.
- It does not block `approve_milestone`, `mark_default`, refunds or payouts. Settlement also needs no price.
- The oracle's heartbeat (`PRICE_HEARTBEAT_SECONDS`, default 2,700) must stay **below** `max_price_age`. Allow for scheduler and inclusion delays.
- The price formula is the BRODex `get_price_token_to_xtz(1 BRO)` view × Coinbase XTZ/USD.
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
              Active ──(last milestone claimed)──► Repaying ──(fully repaid)──► Repaid
                 └──────────(mark_default)──────────────┴──────────────────► Defaulted
```

- **Submission:** `budget_usd > 0` and `funding_deadline > now`.
  - Interest is 50–5000 bps and the term is 1–60 months.
  - There are 1 to `max_milestones` milestones, each with `pct_bps > 0` and `duration_days > 0`, and the shares must add up to exactly 10,000.
  - `project_type` must be `residential` or `commercial`.
  - The global late fee is snapshotted into the listing. `set_late_fee` is capped at 10,000 bps per day (`FEE_TOO_HIGH`) and only affects projects submitted afterwards.
- **Listings can't be edited.** A wrong listing can only be cancelled while it is funding.
- **Funding:**
  - `invest` is allowed while `now <= funding_deadline` (inclusive).
  - It takes `min(max_bro, BRO still needed)`, so overfunding is never pulled.
  - The deposit that closes funding transfers **all** of the project's BRO to BROProjects and calls `launch` in the same operation. If `launch` fails, the closing deposit fails.
- **Refund:**
  - Allowed for `Failed`, for `Cancelled`, or for `Funding` once the deadline has passed. The first refund flips the status to `Failed`.
  - A refund deletes the investor's deposit record.
- **Launch:** escrow is split per milestone, with the last taking the remainder. M1 is due `duration_days` after launch.
- **Approval:**
  - Only the **current** milestone can be approved, in order.
  - The fee is `min(100%, late_days × late_fee_bps_per_day)`, with the rate snapshotted at submission.
  - The next milestone falls due `duration_days` after **this approval**, not after its predecessor's due date.
- **Claim:**
  - The contractor receives BRO worth exactly `net_usd` at today's price.
  - If escrow exceeds that (the late fee, or BRO rose), the surplus goes to the MA.
  - If escrow is short (BRO fell), the MA pays via `cover`. If the reserve is too small, **the claim fails** until the MA is topped up.
  - Claiming the last milestone moves the project to `Repaying`.
- **Repayment:**
  - Opens only in `Repaying`. Nothing is repaid before every milestone is claimed.
  - The amount due is `budget_usd × (1 + interest)` in cents, and each installment is converted at that day's price.
  - Overpayment is capped at what's owed.
  - Anyone can repay on a project's behalf.
  - There is no late fee on repayment.
- **Settlement** happens on full repayment or `mark_default`.
  - The investors' entitlement is `funded_bro × (1 + interest)` **in BRO**.
  - The pool is repaid BRO plus unclaimed escrow.
  - Any excess goes to the MA. Any shortfall is covered by the MA as far as its BRO balance allows, and the rest is recorded as `uncovered_bro`. A repayment is never blocked.
  - Each investor gets `settled_pool × deposit_bro / funded_bro`, once (`payouts_claimed`).
- **Default:**
  - Possible after `funded_at + term + grace`, or, while `Active`, after the current milestone's `due_at + grace`. Both are strict `>`.
  - Approved-but-unclaimed milestones are **not** paid to the contractor on default. Their escrow joins the investors' pool.
- **Grace days are read when `mark_default` is called.** Changing `grace_days` affects every live project, unlike the late fee.

## 6. Where the BRO sits

| Stage | BRO held by |
|---|---|
| Funding | BROFunding (sum of `funded_bro` of `Funding` projects, plus not-yet-refunded `Failed`/`Cancelled` deposits) |
| Active / Repaying | BROProjects (unclaimed escrow plus BRO repaid so far) |
| Repaid / Defaulted | BROProjects (`settled_pool_bro` minus payouts claimed, plus dust) |
| MA reserve | surplus from claims and settlements; source of covers |

The tests check that the total is conserved across every account and contract
(`total()` in the scenarios). Keep that check when adding flows.

**MA reserve sizing:** the reserve funds claim shortfalls, where too little
blocks the claim, and settlement shortfalls, where too little leaves
investors short (`uncovered_bro`). Withdrawing from the reserve (Admin page →
Withdraw BRO) directly reduces what open projects can draw on.

## 7. Permissions

| Action | Who |
|---|---|
| `submit_project` | anyone (becomes `contractor`) |
| `invest`, `refund` | anyone (refund: their own deposit) |
| `cancel_project`, `set_late_fee`, `set_market`, `set_projects`, `set_admin`, `pause` on BROFunding | BROFunding admin |
| `launch` | BROFunding contract only (`NOT_FUNDING_CONTRACT`) |
| `claim_milestone` | the project's contractor |
| `repay` | anyone (the payer's BRO is pulled) |
| `claim_payout` | investors with a deposit on BROFunding |
| `approve_milestone`, `mark_default` | **BROProjects admin, or anyone holding > 0 of the configured NFT** |
| `set_nft`, `set_grace_days`, `set_market`, `set_admin`, `pause` on BROProjects | BROProjects admin |
| `update_price` | MA `oracle` |
| `cover` | MA `ledger` (BROProjects) |
| MA withdraw / swap / set_* | MA admin; `default` (deposit XTZ) is open |

- **NFT approvers:** the check is live. Whoever holds the token at call time can approve, so transferring the NFT transfers the right.
- **Transferring an admin role:** the BROProjects admin is always an approver too.
- **Admins:** there is no multisig or timelock, and each contract has its own admin. `set_admin` takes effect immediately and can't be undone by the old admin.

## 8. Pause behaviour

| Contract | Paused blocks | Still works |
|---|---|---|
| BROFunding | `submit_project`, `invest`, `refund` | admin actions; `launch` can't happen (it needs `invest`) |
| BROProjects | `claim_milestone`, `repay`, `claim_payout` | `approve_milestone`, `mark_default`, `launch`, admin actions |
| BRODex | liquidity and swaps | `credit_rewards` |

**Late fees keep accruing while BROProjects is paused.** Approval isn't
paused, so an approver can still approve on time. Deadlines don't move,
though: a long pause can make projects defaultable.

## 9. Cross-contract interfaces (do not change one side only)

Shared types live in `contracts/utils/common.py` (module `t`), and the shared
math and view helpers live in its `units` module. Changing a shared type
changes the Michelson of **every** contract that uses it, which means
recompiling, redeploying and updating readers.

| Interface | Caller → callee | Must match |
|---|---|---|
| `launch(t.launch_params)` | BROFunding → BROProjects | record fields and layout |
| `get_investment(t.investment_key) → t.investment` | BROProjects → BROFunding view | name, input and output type |
| `get_price() → nat` | BROFunding/BROProjects → MA view | name, unit (see §3) |
| `cover(t.cover_params)` | BROProjects → MA | record `{to_, amount}` |
| `get_balance_of(list[balance_of_request]) → list[balance_of_response]` | BROProjects → BRO token and NFT | fa2_lib layout |
| `transfer`, `update_operators` | all → BRO FA2 | FA2 standard layouts |
| `xtz_to_token(nat)`, `token_to_xtz({token_amount, min_xtz_out})` | MA → BRODex | types and layout |
| `get_price_token_to_xtz(nat) → mutez` | oracle + pages → BRODex view | name and types |

- **On-chain views fail silently as `None` on a type mismatch.** The callers turn that into `PRICE_UNAVAILABLE`, `BALANCE_VIEW_UNAVAILABLE` or `FUNDING_VIEW_UNAVAILABLE`. If you see one of these, check the view's name and types first.
- **The NFT contract must expose the `get_balance_of` on-chain view** (fa2_lib `OnchainviewBalanceOf`). In fa2_lib, `get_balance` is **off-chain only**, so it doesn't count.
- **The BRO token must support `get_balance_of` and operators.** The current BROToken does.

## 10. FA2 operators

- BROFunding (`invest`) and BROProjects (`repay`) pull BRO with `transfer from_=sender`. The payer must first make that contract an FA2 operator.
  - FA2 operators have **no allowance**: an operator can move the owner's entire balance.
  - The pages therefore batch add-operator → call → remove-operator in one operation. Anything else integrating should do the same.
- The MA's `swap_bro_to_xtz` does the same for BRODex inside the contract. It adds the operator, swaps and removes the operator.
- **`DummyFA2` in `utils/helper.py` does not enforce operators.** Tests pass even when operator setup is missing, so check real-token flows on a testnet.

## 11. SmartPy gotchas (0.24)

- **Module name collisions:**
  - fa2_lib's own module is named `t`, which clashes with ours, so `BROToken` can't share a test scenario with our contracts. Use `DummyFA2` instead.
  - BRODex's module is named `main`, the same as fa2_lib's `main`.
- **Private functions can't call other private functions.** That's why `settle_` returns `{surplus, cover}` and the entrypoint does the transfers. Put shared logic in module-level functions (`units`) instead.
- **Importing a contract file runs its `@sp.add_test`.** For example, `broprojects.py` imports `brofunding.py`, so the funding test runs too.
- **In scenarios:**
  - Compare unit variants as `sp.variant.Active(sp.unit)`.
  - Read maps with default values as `.get(key, sp.nat(0))`, not `default=`.
  - Use `_exception="ERR"` so that a failure for the wrong reason is caught.
- **Picking files from `build/`:** each scenario originates several contracts, including stubs and dummy tokens. Pick the right `step_*_cont_N_contract.json` from `build/<Name>/log.txt` ("file ... contract BROProjects"). The market assistant's scenario writes to `build/BROMarket/`.
- **SmartPy's `.tz` output is huge,** because it annotates every instruction with the stack type. The upload files in `build/upload/` are compacted versions without those annotations.

## 12. Size limits

The protocol limit is 32 KB per operation, but wallets refuse much smaller
originations. This is why BROLedger was split.

Current packed code sizes:

| Contract | Bytes |
|---|---|
| BROProjects | 10,627 |
| BROFunding | 7,111 |
| BRODex | 5,881 |
| BROToken | 5,345 |
| BROMarketAssistant | 2,901 |
| BRODelegator | 2,892 |

Each `.tz` also contains the storage and parameter types. Big record types,
like `t.listing`, are repeated wherever they're used: in big_map types, view
return types and lambdas.

To shrink a contract:
- Drop on-chain views nothing calls. For example, `BROProjects.get_project` is about 900 bytes and isn't used.
- Avoid duplicating large records.
- Use fewer private helpers that capture big types.

Re-measure after every change with `packDataBytes` from `@taquito/michel-codec`.

## 13. Data, privacy and storage

- **Project details are public and permanent.** Site address, owner name, phone and email are stored on BROFunding in plain text and can't be removed. Even a cancelled listing keeps them in chain history.
- **Big map entries are never deleted,** except a deposit on refund. Storage grows with every project, and the sender pays the storage burn.
- **Bound loops:** `max_milestones` bounds the loops in submit, launch, claim and settle. Raising it raises the gas cost of those calls.

## 14. Checklist when changing a contract

1. Update the shared types in `utils/common.py` if an interface changes, and check every contract that imports them (§9).
2. Keep the rounding directions (§3) and the permission and pause behaviour (§7, §8), or change them deliberately and document it here.
3. Extend the scenario for every new path. Use `_exception`, keep the balance-conservation `total()` check, and cover price-up and price-down cases.
4. Run every scenario: `.venv/bin/python -m contracts.<name>` for `brotoken brodelegator brodex bromarket brofunding broprojects`.
5. Re-measure the packed size (§12).
6. Rebuild the compacted upload files in `build/upload/` (`build/` is gitignored), and republish them where the deployment pages fetch them (`CONTRACT_CODE_URLS` in `src/shared/contracts.ts`).
7. Update the readers that mirror storage or entrypoints:
   - **Build Pool pages** (brobuilder-dex): `src/shared/ledger.ts` parses BROFunding and BROProjects storage by field name, and mirrors the late-fee, default-date, entitlement and payout formulas. The pages call entrypoints by name.
   - **PHP oracle** (brobuilder-dex `server/oracle`): it calls `update_price` and the DEX view, and reads MA storage (`price`, `price_updated_at`, `oracle`) from TzKT.
   - **Portal** (this repo, `src/`):
     - `src/shared/contracts.ts`: the `create*Storage` builders must list every storage field of each contract.
     - `src/pages/ProjectsPage.tsx`: parses BROFunding and BROProjects storage by field name, mirrors the default-date formula, and calls entrypoints by name.
     - `src/pages/ProjectsSetupPage.tsx`: the linking, rules, pause and admin steps (§2).
8. Redeploy everything whose Michelson changed. Remember that the BROFunding/BROProjects pair has to be replaced together (§2).
