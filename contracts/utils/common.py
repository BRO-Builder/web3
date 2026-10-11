"""Shared types for the BRO contracts.

The DEX, BRODelegator, BROLedger and BROMarketAssistant import this module
so the cross-contract call parameters and the FA2 types are defined once.
"""

import smartpy as sp


@sp.module
def t():
  metadata: type = sp.big_map[sp.string, sp.bytes]

  tx: type = sp.record(
    to_=sp.address,
    token_id=sp.nat,
    amount=sp.nat,
  ).layout(("to_", ("token_id", "amount")))

  transfer_batch: type = sp.record(
    from_=sp.address,
    txs=list[tx],
  ).layout(("from_", "txs"))

  transfer_params: type = list[transfer_batch]

  # DEX -> vault: pay XTZ out of the vault
  withdraw_params: type = sp.record(to_=sp.address, amount=sp.mutez)

  # DEX -> vault: an LP's share balance changed
  sync_params: type = sp.record(
    owner=sp.address, shares=sp.nat, total_shares=sp.nat
  )

  # FA2 operators (matches fa2_lib)
  operator_permission: type = sp.record(
    owner=sp.address, operator=sp.address, token_id=sp.nat
  ).layout(("owner", ("operator", "token_id")))

  update_operators_params: type = list[
    sp.variant(
      add_operator=operator_permission, remove_operator=operator_permission
    )
  ]

  # FA2 `get_balance_of` on-chain view (fa2_lib OnchainviewBalanceOf)
  balance_of_request: type = sp.record(
    owner=sp.address, token_id=sp.nat
  ).layout(("owner", "token_id"))

  balance_of_response: type = sp.record(
    request=balance_of_request, balance=sp.nat
  ).layout(("request", "balance"))

  # ledger -> market assistant: pay BRO out of the reserve
  cover_params: type = sp.record(to_=sp.address, amount=sp.nat)

  # BROLedger project types (USD amounts are nat cents)
  site: type = sp.record(
    street=sp.string, city=sp.string, state=sp.string, zip=sp.string
  )

  owner: type = sp.record(name=sp.string, phone=sp.string, email=sp.string)

  milestone_input: type = sp.record(
    description=sp.string, pct_bps=sp.nat, duration_days=sp.nat
  )

  milestone: type = sp.record(
    description=sp.string,
    pct_bps=sp.nat,
    duration_days=sp.nat,
    # share of the budget, fixed at submission
    usd=sp.nat,
    # share of the funded BRO, fixed when funding closes
    escrow_bro=sp.nat,
    due_at=sp.option[sp.timestamp],
    approved_at=sp.option[sp.timestamp],
    # usd minus the late fee, fixed at approval
    net_usd=sp.nat,
    late_fee_usd=sp.nat,
    claimed=sp.bool,
  )

  project_status: type = sp.variant(
    Funding=sp.unit,
    Failed=sp.unit,
    Active=sp.unit,
    Repaying=sp.unit,
    Repaid=sp.unit,
    Defaulted=sp.unit,
    Cancelled=sp.unit,
  )

  project: type = sp.record(
    contractor=sp.address,
    project_type=sp.string,
    title=sp.string,
    scope=sp.string,
    site=site,
    owner=owner,
    est_completion=sp.timestamp,
    created_at=sp.timestamp,
    funding_deadline=sp.timestamp,
    budget_usd=sp.nat,
    interest_bps=sp.nat,
    term_months=sp.nat,
    late_fee_bps_per_day=sp.nat,
    funded_usd=sp.nat,
    funded_bro=sp.nat,
    funded_at=sp.option[sp.timestamp],
    milestones=sp.map[sp.nat, milestone],
    current_milestone=sp.nat,
    repaid_usd=sp.nat,
    repaid_bro=sp.nat,
    settled_pool_bro=sp.nat,
    uncovered_bro=sp.nat,
    status=project_status,
  )

  submit_params: type = sp.record(
    project_type=sp.string,
    title=sp.string,
    scope=sp.string,
    site=site,
    owner=owner,
    est_completion=sp.timestamp,
    funding_deadline=sp.timestamp,
    budget_usd=sp.nat,
    interest_bps=sp.nat,
    term_months=sp.nat,
    milestones=list[milestone_input],
  )

  investment: type = sp.record(usd=sp.nat, bro=sp.nat, settled_claimed=sp.bool)

  nft_ref: type = sp.record(address=sp.address, token_id=sp.nat)
