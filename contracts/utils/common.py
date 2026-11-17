"""Shared types for the BRO contracts.

The DEX, BRODelegator, BROFunding, BROProjects and BROMarketAssistant import this module
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

  # Project types (USD amounts are nat cents). A project is listed and
  # funded on BROFunding, then launched on BROProjects under the same id.
  site: type = sp.record(
    street=sp.string, city=sp.string, state=sp.string, zip=sp.string
  )

  owner: type = sp.record(name=sp.string, phone=sp.string, email=sp.string)

  milestone_input: type = sp.record(
    description=sp.string, pct_bps=sp.nat, duration_days=sp.nat
  )

  # BROFunding: a milestone as listed (usd = its share of the budget)
  milestone_terms: type = sp.record(
    description=sp.string, pct_bps=sp.nat, duration_days=sp.nat, usd=sp.nat
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
    # interest per month (30 days) on drawn money, 300-900 bps
    monthly_rate_bps=sp.nat,
    # sizes the interest hold: budget x monthly rate x term
    term_months=sp.nat,
    milestones=list[milestone_input],
  )

  funding_status: type = sp.variant(
    Funding=sp.unit, Failed=sp.unit, Cancelled=sp.unit, Launched=sp.unit
  )

  listing: type = sp.record(
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
    monthly_rate_bps=sp.nat,
    term_months=sp.nat,
    late_fee_bps_per_day=sp.nat,
    # BRO Builder's share of investors' interest, saved at submission
    builder_share_bps=sp.nat,
    milestones=sp.map[sp.nat, milestone_terms],
    funded_usd=sp.nat,
    funded_bro=sp.nat,
    funded_at=sp.option[sp.timestamp],
    status=funding_status,
  )

  investment: type = sp.record(usd=sp.nat, bro=sp.nat)

  investment_key: type = sp.record(project_id=sp.nat, investor=sp.address)

  # BROFunding -> BROProjects when funding closes (the BRO is sent first)
  launch_params: type = sp.record(
    project_id=sp.nat,
    contractor=sp.address,
    budget_usd=sp.nat,
    monthly_rate_bps=sp.nat,
    term_months=sp.nat,
    late_fee_bps_per_day=sp.nat,
    builder_share_bps=sp.nat,
    funded_bro=sp.nat,
    # the listing's estimate, proposed as the end date
    est_completion=sp.timestamp,
    milestones=list[
      sp.record(pct_bps=sp.nat, duration_days=sp.nat, usd=sp.nat)
    ],
  )

  # BROProjects: a milestone in progress. Claiming it is a draw.
  milestone: type = sp.record(
    pct_bps=sp.nat,
    duration_days=sp.nat,
    usd=sp.nat,
    # share of the funded BRO, fixed at launch
    escrow_bro=sp.nat,
    due_at=sp.option[sp.timestamp],
    approved_at=sp.option[sp.timestamp],
    # set when drawn; interest runs from here on the outstanding cents
    drawn_at=sp.option[sp.timestamp],
    # drawn cents not yet repaid (repayments reduce the oldest draws first)
    outstanding_usd=sp.nat,
  )

  project_status: type = sp.variant(
    Active=sp.unit, Repaying=sp.unit, Repaid=sp.unit, Defaulted=sp.unit
  )

  # Where BRO went to or came from the funding wallet, in BRO base units
  flows: type = sp.record(
    # BRO Builder's share of investors' interest
    builder_fee_bro=sp.nat,
    late_fee_bro=sp.nat,
    # price gains: escrow or repayments worth more than needed
    surplus_bro=sp.nat,
    # price losses paid in by the wallet
    covered_bro=sp.nat,
  )

  project: type = sp.record(
    contractor=sp.address,
    budget_usd=sp.nat,
    monthly_rate_bps=sp.nat,
    term_months=sp.nat,
    late_fee_bps_per_day=sp.nat,
    builder_share_bps=sp.nat,
    funded_bro=sp.nat,
    # launch; interest payouts fall due every 30 days from here
    funded_at=sp.timestamp,
    # approved by the admin: the end of the contract period
    end_date=sp.option[sp.timestamp],
    # proposed by the contractor, waiting for the admin
    proposed_end_date=sp.option[sp.timestamp],
    milestones=sp.map[sp.nat, milestone],
    current_milestone=sp.nat,
    # interest hold withheld from draws so far (cents) and its BRO
    hold_usd=sp.nat,
    hold_bro=sp.nat,
    # interest paid out of the hold so far (cents)
    hold_used_usd=sp.nat,
    # interest has been paid out of the hold up to this time
    paid_until=sp.timestamp,
    # cent-days of principal already repaid (interest stopped on it)
    closed_usd_days=sp.nat,
    # interest above the hold paid by the contractor (cents)
    interest_paid_usd=sp.nat,
    # everything repaid, in cents (interest, principal and late fee)
    repaid_usd=sp.nat,
    # repaid principal BRO held until settlement
    repaid_bro=sp.nat,
    # late fee paid so far (cents)
    late_fee_usd=sp.nat,
    # undrawn escrow handed back to investors (period over or settled)
    released=sp.bool,
    # BRO allotted to investors so far (interest, undrawn, principal)
    investor_bro=sp.nat,
    uncovered_bro=sp.nat,
    # cents (with late fee) still owed when the project defaulted
    default_due_usd=sp.nat,
    flows=flows,
    status=project_status,
  )

  nft_ref: type = sp.record(address=sp.address, token_id=sp.nat)


@sp.module
def units():
  """Conversions and reads shared by BROFunding and BROProjects.
  Price unit: BRO base units per USD cent, times 10^6."""
  import t # type: ignore

  def usd_to_bro(params):
    """Cents to BRO base units, rounded down."""
    (usd, price) = params
    return usd * price / 1_000_000

  def usd_to_bro_up(params):
    """Cents to BRO base units, rounded up."""
    (usd, price) = params
    return (usd * price + 999_999) / 1_000_000

  def bro_to_usd(params):
    """BRO base units to cents, rounded down."""
    (bro, price) = params
    return bro * 1_000_000 / price

  def market_price(market):
    """Current BRO/USD price; the market's view rejects stale prices."""
    sp.cast(market, sp.address)
    return sp.view("get_price", market, (), sp.nat).unwrap_some(
      error="PRICE_UNAVAILABLE"
    )

  def token_balance(params):
    """`owner`'s balance of `token_id` on an FA2 with `get_balance_of`."""
    sp.cast(
      params, sp.record(token=sp.address, owner=sp.address, token_id=sp.nat)
    )
    responses = sp.view(
      "get_balance_of",
      params.token,
      [sp.record(owner=params.owner, token_id=params.token_id)],
      list[t.balance_of_response],
    ).unwrap_some(error="BALANCE_VIEW_UNAVAILABLE")
    balance = 0
    for r in responses:
      balance += r.balance
    return balance
