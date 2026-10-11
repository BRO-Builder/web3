"""BROLedger: the public ledger of BRO Builder projects, their investments,
milestones, repayment and settlement.

- A contractor submits a project with a USD budget (cents), a fixed
  interest rate, a repayment term and milestones that split the budget.
- Investors deposit BRO. Each deposit is valued in USD at the current
  BRO/USD price (read from BROMarketAssistant), and funding closes when
  the USD total reaches the budget.
- Milestones are approved by the admin or any holder of the configured
  NFT. On claim the contractor receives BRO worth exactly the milestone's
  USD amount minus late fees; the market assistant takes any surplus
  escrow and covers any shortfall.
- The contractor repays budget + interest in USD (converted at the price
  on the day of each installment). Investors are owed their deposit plus
  interest in BRO; the market assistant takes the excess or covers the
  gap as far as its reserve allows.

Units: USD is nat cents; price is BRO base units per cent, times 10^6.

This is illustrative / educational code. Have it audited before using it
with real funds.
"""

import smartpy as sp
from .utils.common import t
from .utils.helper import helpers
from .bromarket import market


@sp.module
def ledger():
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

  def amount_due(p):
    """Budget plus interest, in cents."""
    sp.cast(p, t.project)
    return p.budget_usd * (10000 + p.interest_bps) / 10000

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

  class BROLedger(sp.Contract):
    """Projects, investments, milestones and settlement, in BRO."""

    def __init__(
      self,
      metadata,
      admin,
      market,
      token_address,
      token_id,
      late_fee_bps_per_day,
      grace_days,
      max_milestones,
    ):
      self.data.metadata = sp.cast(metadata, t.metadata)
      self.data.admin = sp.cast(admin, sp.address)
      self.data.paused = False
      self.data.market = sp.cast(market, sp.address)
      self.data.token_address = sp.cast(token_address, sp.address)
      self.data.token_id = sp.cast(token_id, sp.nat)
      # holders of this token may approve milestones
      self.data.nft = sp.cast(None, sp.option[t.nft_ref])
      # snapshotted into each project at submission
      self.data.late_fee_bps_per_day = sp.cast(late_fee_bps_per_day, sp.nat)
      self.data.grace_days = sp.cast(grace_days, sp.nat)
      self.data.max_milestones = sp.cast(max_milestones, sp.nat)
      self.data.next_project_id = sp.nat(0)
      self.data.projects = sp.cast(sp.big_map(), sp.big_map[sp.nat, t.project])
      self.data.investments = sp.cast(
        sp.big_map(), sp.big_map[sp.pair[sp.nat, sp.address], t.investment]
      )

    @sp.private(with_storage="read-only", with_operations=True)
    def token_transfer_(self, params):
      """Call the BRO FA2 contract's `transfer` entrypoint (skipped for
      zero amounts)."""
      sp.cast(params, sp.record(from_=sp.address, to_=sp.address, amount=sp.nat))
      if params.amount > 0:
        contract = sp.contract(
          t.transfer_params, self.data.token_address, "transfer"
        ).unwrap_some(error="FA2_CONTRACT_NOT_FOUND")
        arg = [
          sp.record(
            from_=params.from_,
            txs=[
              sp.record(
                to_=params.to_,
                token_id=self.data.token_id,
                amount=params.amount,
              )
            ],
          )
        ]
        sp.transfer(arg, sp.mutez(0), contract)

    @sp.private(with_storage="read-only", with_operations=True)
    def market_cover_(self, params):
      """Have the market assistant pay BRO from its reserve (skipped for
      zero amounts)."""
      sp.cast(params, t.cover_params)
      if params.amount > 0:
        contract = sp.contract(
          t.cover_params, self.data.market, "cover"
        ).unwrap_some(error="MARKET_COVER_NOT_FOUND")
        sp.transfer(params, sp.mutez(0), contract)

    @sp.private(with_storage="read-only")
    def price_(self):
      """Current BRO/USD price; the market's view rejects stale prices."""
      return sp.view("get_price", self.data.market, (), sp.nat).unwrap_some(
        error="PRICE_UNAVAILABLE"
      )

    @sp.private(with_storage="read-only")
    def is_approver_(self):
      """True for the admin, or a holder of the configured NFT."""
      ok = sp.sender == self.data.admin
      if not ok:
        if self.data.nft.is_some():
          nft = self.data.nft.unwrap_some()
          ok = (
            token_balance(
              sp.record(
                token=nft.address, owner=sp.sender, token_id=nft.token_id
              )
            )
            > 0
          )
      return ok

    @sp.private(with_storage="read-write")
    def settle_(self, project_id):
      """Fix the pool investors split: repaid BRO plus unclaimed escrow,
      trimmed to their entitlement or topped up by the market as far as
      its reserve allows. Returns the BRO the caller must send to the
      market (`surplus`) and request from it (`cover`)."""
      sp.cast(project_id, sp.nat)
      p = self.data.projects[project_id]
      unclaimed = 0
      for ms in p.milestones.values():
        if not ms.claimed:
          unclaimed += ms.escrow_bro
      pool = p.repaid_bro + unclaimed
      entitlement = p.funded_bro * (10000 + p.interest_bps) / 10000
      surplus = 0
      cover = 0
      if pool > entitlement:
        surplus = sp.as_nat(pool - entitlement)
        pool = entitlement
      else:
        shortfall = sp.as_nat(entitlement - pool)
        reserve = token_balance(
          sp.record(
            token=self.data.token_address,
            owner=self.data.market,
            token_id=self.data.token_id,
          )
        )
        cover = min(shortfall, reserve)
        p.uncovered_bro = sp.as_nat(shortfall - cover)
        pool += cover
      p.settled_pool_bro = pool
      self.data.projects[project_id] = p
      return sp.record(surplus=surplus, cover=cover)

    # ------------------------------------------------------------------
    # Admin
    # ------------------------------------------------------------------
    @sp.entrypoint
    def set_admin(self, new_admin):
      sp.cast(new_admin, sp.address)
      assert sp.sender == self.data.admin, "NOT_ADMIN"
      self.data.admin = new_admin

    @sp.entrypoint
    def set_nft(self, nft):
      sp.cast(nft, sp.option[t.nft_ref])
      assert sp.sender == self.data.admin, "NOT_ADMIN"
      self.data.nft = nft

    @sp.entrypoint
    def set_market(self, new_market):
      sp.cast(new_market, sp.address)
      assert sp.sender == self.data.admin, "NOT_ADMIN"
      self.data.market = new_market

    @sp.entrypoint
    def set_late_fee(self, bps_per_day):
      """Applies to projects submitted from now on."""
      sp.cast(bps_per_day, sp.nat)
      assert sp.sender == self.data.admin, "NOT_ADMIN"
      assert bps_per_day <= 10000, "FEE_TOO_HIGH"
      self.data.late_fee_bps_per_day = bps_per_day

    @sp.entrypoint
    def set_grace_days(self, days):
      sp.cast(days, sp.nat)
      assert sp.sender == self.data.admin, "NOT_ADMIN"
      self.data.grace_days = days

    @sp.entrypoint
    def pause(self, new_paused):
      """Admin-only switch. When paused, submit_project, invest, refund,
      claim_milestone, repay and claim_payout are disabled."""
      sp.cast(new_paused, sp.bool)
      assert sp.sender == self.data.admin, "NOT_ADMIN"
      self.data.paused = new_paused

    @sp.entrypoint
    def cancel_project(self, project_id):
      """Reject a spam or invalid submission while it is still funding.
      Investors can then refund."""
      sp.cast(project_id, sp.nat)
      assert sp.sender == self.data.admin, "NOT_ADMIN"
      p = self.data.projects.get(project_id, error="PROJECT_NOT_FOUND")
      assert p.status.is_variant.Funding(), "NOT_FUNDING"
      p.status = sp.variant.Cancelled()
      self.data.projects[project_id] = p

    # ------------------------------------------------------------------
    # Contractor
    # ------------------------------------------------------------------
    @sp.entrypoint
    def submit_project(self, params):
      sp.cast(params, t.submit_params)
      assert not self.data.paused, "PAUSED"
      assert (
        params.project_type == "residential"
        or params.project_type == "commercial"
      ), "BAD_PROJECT_TYPE"
      assert params.budget_usd > 0, "BAD_BUDGET"
      assert params.funding_deadline > sp.now, "BAD_DEADLINE"
      assert (
        params.interest_bps >= 50 and params.interest_bps <= 5000
      ), "BAD_INTEREST"
      assert params.term_months >= 1 and params.term_months <= 60, "BAD_TERM"
      n = sp.len(params.milestones)
      assert n >= 1 and n <= self.data.max_milestones, "BAD_MILESTONE_COUNT"

      milestones = sp.cast({}, sp.map[sp.nat, t.milestone])
      total_pct = 0
      usd_left = params.budget_usd
      for m in params.milestones:
        assert m.pct_bps > 0, "BAD_MILESTONE_PCT"
        assert m.duration_days > 0, "BAD_MILESTONE_DURATION"
        total_pct += m.pct_bps
        assert total_pct <= 10000, "BAD_MILESTONE_PCT_SUM"
        i = sp.len(milestones)
        # the last milestone takes the rounding remainder
        usd = params.budget_usd * m.pct_bps / 10000
        if i + 1 == n:
          usd = usd_left
        usd_left = sp.as_nat(usd_left - usd)
        milestones[i] = sp.record(
          description=m.description,
          pct_bps=m.pct_bps,
          duration_days=m.duration_days,
          usd=usd,
          escrow_bro=0,
          due_at=None,
          approved_at=None,
          net_usd=0,
          late_fee_usd=0,
          claimed=False,
        )
      assert total_pct == 10000, "BAD_MILESTONE_PCT_SUM"

      self.data.projects[self.data.next_project_id] = sp.record(
        contractor=sp.sender,
        project_type=params.project_type,
        title=params.title,
        scope=params.scope,
        site=params.site,
        owner=params.owner,
        est_completion=params.est_completion,
        created_at=sp.now,
        funding_deadline=params.funding_deadline,
        budget_usd=params.budget_usd,
        interest_bps=params.interest_bps,
        term_months=params.term_months,
        late_fee_bps_per_day=self.data.late_fee_bps_per_day,
        funded_usd=0,
        funded_bro=0,
        funded_at=None,
        milestones=milestones,
        current_milestone=0,
        repaid_usd=0,
        repaid_bro=0,
        settled_pool_bro=0,
        uncovered_bro=0,
        status=sp.variant.Funding(),
      )
      self.data.next_project_id += 1

    @sp.entrypoint
    def claim_milestone(self, project_id):
      """Pay out every approved, unclaimed milestone: BRO worth their net
      USD at today's price. Surplus escrow goes to the market; a shortfall
      is paid by the market (the claim fails if its reserve is short)."""
      sp.cast(project_id, sp.nat)
      assert not self.data.paused, "PAUSED"
      p = self.data.projects.get(project_id, error="PROJECT_NOT_FOUND")
      assert sp.sender == p.contractor, "NOT_CONTRACTOR"
      assert p.status.is_variant.Active(), "NOT_ACTIVE"

      need_usd = 0
      escrow = 0
      for i in range(0, p.current_milestone):
        if not p.milestones[i].claimed:
          need_usd += p.milestones[i].net_usd
          escrow += p.milestones[i].escrow_bro
          p.milestones[i].claimed = True
      assert escrow > 0, "NOTHING_TO_CLAIM"

      need = usd_to_bro((need_usd, self.price_()))
      if p.current_milestone == sp.len(p.milestones):
        p.status = sp.variant.Repaying()
      self.data.projects[project_id] = p

      if escrow >= need:
        self.token_transfer_(
          sp.record(from_=sp.self_address, to_=p.contractor, amount=need)
        )
        self.token_transfer_(
          sp.record(
            from_=sp.self_address,
            to_=self.data.market,
            amount=sp.as_nat(escrow - need),
          )
        )
      else:
        self.token_transfer_(
          sp.record(from_=sp.self_address, to_=p.contractor, amount=escrow)
        )
        self.market_cover_(
          sp.record(to_=p.contractor, amount=sp.as_nat(need - escrow))
        )

    @sp.entrypoint
    def repay(self, params):
      """Pay an installment of budget + interest, in USD cents, converted
      at today's price. Anyone may pay; the sender must have made this
      contract an operator for their BRO. Settles once fully repaid."""
      sp.cast(params, sp.record(project_id=sp.nat, usd_cents=sp.nat))
      assert not self.data.paused, "PAUSED"
      p = self.data.projects.get(params.project_id, error="PROJECT_NOT_FOUND")
      assert p.status.is_variant.Repaying(), "NOT_REPAYING"
      due = amount_due(p)
      usd = min(params.usd_cents, sp.as_nat(due - p.repaid_usd))
      assert usd > 0, "AMOUNT_TOO_SMALL"
      bro = usd_to_bro_up((usd, self.price_()))

      p.repaid_usd += usd
      p.repaid_bro += bro
      if p.repaid_usd == due:
        p.status = sp.variant.Repaid()
      self.data.projects[params.project_id] = p

      self.token_transfer_(
        sp.record(from_=sp.sender, to_=sp.self_address, amount=bro)
      )
      if p.repaid_usd == due:
        settled = self.settle_(params.project_id)
        self.token_transfer_(
          sp.record(
            from_=sp.self_address, to_=self.data.market, amount=settled.surplus
          )
        )
        self.market_cover_(sp.record(to_=sp.self_address, amount=settled.cover))

    # ------------------------------------------------------------------
    # Investor
    # ------------------------------------------------------------------
    @sp.entrypoint
    def invest(self, params):
      """Deposit up to `max_bro`, capped at what is still needed to reach
      the budget at today's price. Requires this contract to be an
      operator for the sender's BRO."""
      sp.cast(params, sp.record(project_id=sp.nat, max_bro=sp.nat))
      assert not self.data.paused, "PAUSED"
      p = self.data.projects.get(params.project_id, error="PROJECT_NOT_FOUND")
      assert p.status.is_variant.Funding(), "NOT_FUNDING"
      assert sp.now <= p.funding_deadline, "FUNDING_CLOSED"

      price = self.price_()
      remaining_usd = sp.as_nat(p.budget_usd - p.funded_usd)
      remaining_bro = usd_to_bro_up((remaining_usd, price))
      bro = min(params.max_bro, remaining_bro)
      assert bro > 0, "AMOUNT_TOO_SMALL"
      usd = remaining_usd
      if bro < remaining_bro:
        usd = bro_to_usd((bro, price))

      key = (params.project_id, sp.sender)
      inv = self.data.investments.get(
        key, default=sp.record(usd=0, bro=0, settled_claimed=False)
      )
      inv.usd += usd
      inv.bro += bro
      self.data.investments[key] = inv

      p.funded_usd += usd
      p.funded_bro += bro
      if p.funded_usd == p.budget_usd:
        # funding closes: split the BRO into per-milestone escrow (the last
        # takes the rounding remainder) and start the first deadline
        p.status = sp.variant.Active()
        p.funded_at = sp.Some(sp.now)
        n = sp.len(p.milestones)
        left = p.funded_bro
        for i in range(0, n):
          share = p.funded_bro * p.milestones[i].pct_bps / 10000
          if i + 1 == n:
            share = left
          left = sp.as_nat(left - share)
          p.milestones[i].escrow_bro = share
        p.milestones[0].due_at = sp.Some(
          sp.add_seconds(sp.now, sp.to_int(p.milestones[0].duration_days) * 86400)
        )
      self.data.projects[params.project_id] = p

      self.token_transfer_(
        sp.record(from_=sp.sender, to_=sp.self_address, amount=bro)
      )

    @sp.entrypoint
    def refund(self, project_id):
      """Return the sender's deposit when funding missed its deadline or
      the project was cancelled."""
      sp.cast(project_id, sp.nat)
      assert not self.data.paused, "PAUSED"
      p = self.data.projects.get(project_id, error="PROJECT_NOT_FOUND")
      if p.status.is_variant.Funding():
        assert sp.now > p.funding_deadline, "FUNDING_OPEN"
        p.status = sp.variant.Failed()
      else:
        assert (
          p.status.is_variant.Failed() or p.status.is_variant.Cancelled()
        ), "NOT_REFUNDABLE"

      key = (project_id, sp.sender)
      inv = self.data.investments.get(key, error="INVESTMENT_NOT_FOUND")
      del self.data.investments[key]
      p.funded_usd = sp.as_nat(p.funded_usd - inv.usd)
      p.funded_bro = sp.as_nat(p.funded_bro - inv.bro)
      self.data.projects[project_id] = p

      self.token_transfer_(
        sp.record(from_=sp.self_address, to_=sp.sender, amount=inv.bro)
      )

    @sp.entrypoint
    def claim_payout(self, project_id):
      """Once settled, pay the sender their share of the pool."""
      sp.cast(project_id, sp.nat)
      assert not self.data.paused, "PAUSED"
      p = self.data.projects.get(project_id, error="PROJECT_NOT_FOUND")
      assert (
        p.status.is_variant.Repaid() or p.status.is_variant.Defaulted()
      ), "NOT_SETTLED"
      key = (project_id, sp.sender)
      inv = self.data.investments.get(key, error="INVESTMENT_NOT_FOUND")
      assert not inv.settled_claimed, "ALREADY_CLAIMED"
      inv.settled_claimed = True
      self.data.investments[key] = inv

      self.token_transfer_(
        sp.record(
          from_=sp.self_address,
          to_=sp.sender,
          amount=p.settled_pool_bro * inv.bro / p.funded_bro,
        )
      )

    # ------------------------------------------------------------------
    # Approver (admin or NFT holder)
    # ------------------------------------------------------------------
    @sp.entrypoint
    def approve_milestone(self, project_id):
      """Approve the current milestone. Each day (rounded up) past its due
      date costs `late_fee_bps_per_day` of its USD amount, capped at 100%.
      The next milestone falls due `duration_days` from now."""
      sp.cast(project_id, sp.nat)
      assert self.is_approver_(), "NOT_APPROVER"
      p = self.data.projects.get(project_id, error="PROJECT_NOT_FOUND")
      assert p.status.is_variant.Active(), "NOT_ACTIVE"
      i = p.current_milestone
      n = sp.len(p.milestones)
      assert i < n, "NO_PENDING_MILESTONE"

      ms = p.milestones[i]
      due = ms.due_at.unwrap_some()
      fee_bps = 0
      if sp.now > due:
        late_days = (sp.as_nat(sp.now - due) + 86399) / 86400
        fee_bps = min(10000, late_days * p.late_fee_bps_per_day)
      ms.net_usd = ms.usd * sp.as_nat(10000 - fee_bps) / 10000
      ms.late_fee_usd = sp.as_nat(ms.usd - ms.net_usd)
      ms.approved_at = sp.Some(sp.now)
      p.milestones[i] = ms
      p.current_milestone = i + 1
      if i + 1 < n:
        p.milestones[i + 1].due_at = sp.Some(
          sp.add_seconds(
            sp.now, sp.to_int(p.milestones[i + 1].duration_days) * 86400
          )
        )
      self.data.projects[project_id] = p

    @sp.entrypoint
    def mark_default(self, project_id):
      """Default a project past its term + grace, or past its current
      milestone's due date + grace. Unclaimed escrow joins the pool."""
      sp.cast(project_id, sp.nat)
      assert self.is_approver_(), "NOT_APPROVER"
      p = self.data.projects.get(project_id, error="PROJECT_NOT_FOUND")
      assert (
        p.status.is_variant.Active() or p.status.is_variant.Repaying()
      ), "NOT_DEFAULTABLE"

      grace = sp.to_int(self.data.grace_days) * 86400
      term_end = sp.add_seconds(
        p.funded_at.unwrap_some(),
        sp.to_int(p.term_months) * 30 * 86400 + grace,
      )
      overdue = sp.now > term_end
      if p.status.is_variant.Active() and p.current_milestone < sp.len(
        p.milestones
      ):
        due = p.milestones[p.current_milestone].due_at.unwrap_some()
        overdue = overdue or sp.now > sp.add_seconds(due, grace)
      assert overdue, "NOT_OVERDUE"

      p.status = sp.variant.Defaulted()
      self.data.projects[project_id] = p
      settled = self.settle_(project_id)
      self.token_transfer_(
        sp.record(
          from_=sp.self_address, to_=self.data.market, amount=settled.surplus
        )
      )
      self.market_cover_(sp.record(to_=sp.self_address, amount=settled.cover))

    # ------------------------------------------------------------------
    # Views
    # ------------------------------------------------------------------
    @sp.onchain_view()
    def get_project(self, project_id):
      sp.cast(project_id, sp.nat)
      return self.data.projects.get(project_id, error="PROJECT_NOT_FOUND")

    @sp.onchain_view()
    def get_investment(self, params):
      sp.cast(params, sp.record(project_id=sp.nat, investor=sp.address))
      return self.data.investments.get(
        (params.project_id, params.investor),
        default=sp.record(usd=0, bro=0, settled_claimed=False),
      )

    @sp.onchain_view()
    def get_amount_due(self, project_id):
      """Cents still owed (budget + interest - repaid)."""
      sp.cast(project_id, sp.nat)
      p = self.data.projects.get(project_id, error="PROJECT_NOT_FOUND")
      return sp.as_nat(amount_due(p) - p.repaid_usd)


DAY = 86400
T0 = 1_000_000


def _ts(seconds):
  return sp.timestamp(T0 + seconds)


def _project(deadline, budget, interest, term, milestones, project_type="residential"):
  return sp.record(
    project_type=project_type,
    title="Kitchen remodel",
    scope="Cabinets, counters and plumbing",
    site=sp.record(street="1 Main St", city="Austin", state="TX", zip="78701"),
    owner=sp.record(name="Pat Owner", phone="555-0100", email="pat@example.com"),
    est_completion=deadline.add_days(90),
    funding_deadline=deadline,
    budget_usd=budget,
    interest_bps=interest,
    term_months=term,
    milestones=[
      sp.record(description="Phase %d" % i, pct_bps=pct, duration_days=days)
      for i, (pct, days) in enumerate(milestones)
    ],
  )


@sp.add_test()
def test_ledger():
  admin = sp.test_account("Admin")
  oracle = sp.test_account("Oracle")
  contractor = sp.test_account("Contractor")
  alice = sp.test_account("Alice")
  bob = sp.test_account("Bob")
  carol = sp.test_account("Carol")
  approver = sp.test_account("Approver")
  dex = sp.test_account("Dex")

  scenario = sp.test_scenario(
    "build/BROLedger", [t, helpers, market, ledger]
  )
  scenario.h1("BRO Project Ledger")

  token = helpers.DummyFA2(admin.address)
  scenario += token
  # stands in for the approver NFT: only `get_balance_of` matters
  nft = helpers.DummyFA2(admin.address)
  scenario += nft
  for a, amount in [(admin, 10_000_000), (contractor, 5_000_000), (alice, 5_000_000), (bob, 5_000_000)]:
    token.mint(to_=a.address, amount=amount, _sender=admin)
  nft.mint(to_=approver.address, amount=1, _sender=admin)

  ma = market.BROMarketAssistant(
    metadata=sp.big_map(),
    admin=admin.address,
    oracle=oracle.address,
    dex=dex.address,
    token_address=token.address,
    token_id=0,
    max_price_age=3600,
  )
  scenario += ma
  bl = ledger.BROLedger(
    metadata=sp.big_map(),
    admin=admin.address,
    market=ma.address,
    token_address=token.address,
    token_id=0,
    late_fee_bps_per_day=100,
    grace_days=7,
    max_milestones=20,
  )
  scenario += bl
  ma.set_ledger(bl.address, _sender=admin.address)

  def bal(account):
    return token.data.balances.get(account, sp.nat(0))

  def price(p, now):
    ma.update_price(p, _sender=oracle.address, _now=now)

  def total():
    return (
      bal(admin.address)
      + bal(contractor.address)
      + bal(alice.address)
      + bal(bob.address)
      + bal(ma.address)
      + bal(bl.address)
    )

  token.transfer(
    [
      sp.record(
        from_=admin.address,
        txs=[sp.record(to_=ma.address, token_id=0, amount=2_000_000)],
      )
    ],
    _sender=admin,
  )
  scenario.verify(total() == 25_000_000)

  # ----------------------------------------------------------------------
  scenario.h2("Submission checks")
  deadline = _ts(30 * DAY)
  ms3 = [(5000, 10), (3000, 10), (2000, 10)]
  bad = [
    ("BAD_MILESTONE_PCT_SUM", _project(deadline, 100_000, 800, 12, [(5000, 10), (4000, 10)])),
    ("BAD_MILESTONE_PCT_SUM", _project(deadline, 100_000, 800, 12, [(6000, 10), (5000, 10)])),
    ("BAD_MILESTONE_PCT", _project(deadline, 100_000, 800, 12, [(10000, 10), (0, 10)])),
    ("BAD_MILESTONE_DURATION", _project(deadline, 100_000, 800, 12, [(10000, 0)])),
    ("BAD_MILESTONE_COUNT", _project(deadline, 100_000, 800, 12, [(500, 1)] * 20 + [(0, 1)])),
    ("BAD_MILESTONE_COUNT", _project(deadline, 100_000, 800, 12, [])),
    ("BAD_DEADLINE", _project(_ts(0), 100_000, 800, 12, ms3)),
    ("BAD_BUDGET", _project(deadline, 0, 800, 12, ms3)),
    ("BAD_INTEREST", _project(deadline, 100_000, 49, 12, ms3)),
    ("BAD_INTEREST", _project(deadline, 100_000, 5001, 12, ms3)),
    ("BAD_TERM", _project(deadline, 100_000, 800, 0, ms3)),
    ("BAD_TERM", _project(deadline, 100_000, 800, 61, ms3)),
    ("BAD_PROJECT_TYPE", _project(deadline, 100_000, 800, 12, ms3, "industrial")),
  ]
  for err, params in bad:
    bl.submit_project(
      params, _sender=contractor, _now=_ts(0), _valid=False, _exception=err
    )

  # ----------------------------------------------------------------------
  scenario.h2("Project 0: fund, three milestones, repay, settle with surplus")
  bl.submit_project(
    _project(deadline, 100_000, 800, 12, ms3), _sender=contractor, _now=_ts(0)
  )
  p0 = bl.data.projects[0]
  scenario.verify(p0.status == sp.variant.Funding(sp.unit))
  scenario.verify(p0.milestones[0].usd == 50_000)
  scenario.verify(p0.milestones[2].usd == 20_000)

  # 10 BRO units per cent
  price(10_000_000, _ts(0))
  bl.invest(
    sp.record(project_id=0, max_bro=0),
    _sender=alice,
    _now=_ts(0),
    _valid=False,
    _exception="AMOUNT_TOO_SMALL",
  )
  bl.invest(sp.record(project_id=0, max_bro=600_000), _sender=alice, _now=_ts(0))
  scenario.verify(bl.data.investments[(0, alice.address)].usd == 60_000)
  scenario.verify(bl.data.projects[0].status == sp.variant.Funding(sp.unit))
  # overfunding is capped at the 400,000 BRO still needed
  bl.invest(sp.record(project_id=0, max_bro=900_000), _sender=bob, _now=_ts(0))
  scenario.verify(bl.data.investments[(0, bob.address)].bro == 400_000)
  scenario.verify(bl.data.investments[(0, bob.address)].usd == 40_000)
  p0 = bl.data.projects[0]
  scenario.verify(p0.status == sp.variant.Active(sp.unit))
  scenario.verify(p0.funded_usd == 100_000)
  scenario.verify(p0.funded_bro == 1_000_000)
  scenario.verify(p0.milestones[0].escrow_bro == 500_000)
  scenario.verify(p0.milestones[1].escrow_bro == 300_000)
  scenario.verify(p0.milestones[2].escrow_bro == 200_000)
  scenario.verify(p0.milestones[0].due_at == sp.Some(_ts(10 * DAY)))
  scenario.verify(bal(bl.address) == 1_000_000)
  bl.invest(
    sp.record(project_id=0, max_bro=1),
    _sender=bob,
    _now=_ts(0),
    _valid=False,
    _exception="NOT_FUNDING",
  )

  scenario.p("Approvers: admin and NFT holders only")
  bl.approve_milestone(0, _sender=approver, _now=_ts(5 * DAY), _valid=False, _exception="NOT_APPROVER")
  bl.set_nft(sp.Some(sp.record(address=nft.address, token_id=0)), _sender=carol, _valid=False)
  bl.set_nft(sp.Some(sp.record(address=nft.address, token_id=0)), _sender=admin)
  bl.approve_milestone(0, _sender=carol, _now=_ts(5 * DAY), _valid=False, _exception="NOT_APPROVER")
  bl.claim_milestone(0, _sender=contractor, _now=_ts(5 * DAY), _valid=False, _exception="NOTHING_TO_CLAIM")

  scenario.p("M0 on time, price unchanged: escrow pays exactly")
  bl.approve_milestone(0, _sender=admin, _now=_ts(5 * DAY))
  p0 = bl.data.projects[0]
  scenario.verify(p0.milestones[0].net_usd == 50_000)
  scenario.verify(p0.milestones[0].late_fee_usd == 0)
  scenario.verify(p0.milestones[1].due_at == sp.Some(_ts(15 * DAY)))
  price(10_000_000, _ts(5 * DAY))
  bl.claim_milestone(0, _sender=carol, _now=_ts(5 * DAY), _valid=False, _exception="NOT_CONTRACTOR")
  bl.claim_milestone(0, _sender=contractor, _now=_ts(5 * DAY))
  scenario.verify(bal(contractor.address) == 5_500_000)
  scenario.verify(bal(ma.address) == 2_000_000)
  bl.claim_milestone(0, _sender=contractor, _now=_ts(5 * DAY), _valid=False, _exception="NOTHING_TO_CLAIM")

  scenario.p("M1 by an NFT holder after BRO doubled: surplus escrow to the market")
  bl.approve_milestone(0, _sender=approver, _now=_ts(6 * DAY))
  price(5_000_000, _ts(6 * DAY))
  bl.claim_milestone(0, _sender=contractor, _now=_ts(6 * DAY))
  scenario.verify(bal(contractor.address) == 5_650_000)
  scenario.verify(bal(ma.address) == 2_150_000)

  scenario.p("M2 approved 2 days + 1 second late (3 days fee) after BRO halved: market covers")
  late = _ts(18 * DAY + 1)
  bl.approve_milestone(0, _sender=admin, _now=late)
  p0 = bl.data.projects[0]
  scenario.verify(p0.milestones[2].net_usd == 19_400)
  scenario.verify(p0.milestones[2].late_fee_usd == 600)
  bl.approve_milestone(0, _sender=admin, _now=late, _valid=False, _exception="NO_PENDING_MILESTONE")
  bl.repay(sp.record(project_id=0, usd_cents=1), _sender=contractor, _now=late, _valid=False, _exception="NOT_REPAYING")
  price(20_000_000, late)
  bl.claim_milestone(0, _sender=contractor, _now=late)
  scenario.verify(bal(contractor.address) == 6_038_000)
  scenario.verify(bal(ma.address) == 1_962_000)
  scenario.verify(bal(bl.address) == 0)
  scenario.verify(bl.data.projects[0].status == sp.variant.Repaying(sp.unit))
  bl.claim_payout(0, _sender=alice, _now=late, _valid=False, _exception="NOT_SETTLED")

  scenario.p("Repay 108,000 cents in two installments at 20 BRO units per cent")
  scenario.verify(bl.get_amount_due(0) == 108_000)
  bl.repay(sp.record(project_id=0, usd_cents=50_000), _sender=contractor, _now=late)
  scenario.verify(bal(contractor.address) == 5_038_000)
  scenario.verify(bl.get_amount_due(0) == 58_000)
  scenario.verify(bl.data.projects[0].status == sp.variant.Repaying(sp.unit))
  # overpaying is capped at the 58,000 cents still owed
  bl.repay(sp.record(project_id=0, usd_cents=100_000), _sender=contractor, _now=late)
  scenario.verify(bal(contractor.address) == 3_878_000)
  p0 = bl.data.projects[0]
  scenario.verify(p0.status == sp.variant.Repaid(sp.unit))
  scenario.verify(p0.repaid_usd == 108_000)
  scenario.verify(p0.repaid_bro == 2_160_000)
  # entitlement is 1,080,000 BRO; the other 1,080,000 goes to the market
  scenario.verify(p0.settled_pool_bro == 1_080_000)
  scenario.verify(p0.uncovered_bro == 0)
  scenario.verify(bal(ma.address) == 3_042_000)
  scenario.verify(bl.get_amount_due(0) == 0)

  bl.claim_payout(0, _sender=alice, _now=late)
  bl.claim_payout(0, _sender=bob, _now=late)
  scenario.verify(bal(alice.address) == 5_048_000)
  scenario.verify(bal(bob.address) == 5_032_000)
  scenario.verify(bal(bl.address) == 0)
  bl.claim_payout(0, _sender=alice, _now=late, _valid=False, _exception="ALREADY_CLAIMED")
  bl.claim_payout(0, _sender=carol, _now=late, _valid=False, _exception="INVESTMENT_NOT_FOUND")
  scenario.verify(total() == 25_000_000)

  # ----------------------------------------------------------------------
  scenario.h2("Project 1: BRO rose before repayment, market covers the gap")
  t1 = 20 * DAY
  bl.submit_project(
    _project(_ts(t1 + 10 * DAY), 10_000, 1000, 6, [(10000, 5)]),
    _sender=contractor,
    _now=_ts(t1),
  )
  price(10_000_000, _ts(t1))
  bl.invest(sp.record(project_id=1, max_bro=1_000_000), _sender=alice, _now=_ts(t1))
  scenario.verify(bl.data.investments[(1, alice.address)].bro == 100_000)
  scenario.verify(bl.data.projects[1].status == sp.variant.Active(sp.unit))
  bl.approve_milestone(1, _sender=admin, _now=_ts(t1 + DAY))
  price(10_000_000, _ts(t1 + DAY))
  bl.claim_milestone(1, _sender=contractor, _now=_ts(t1 + DAY))
  scenario.verify(bal(contractor.address) == 3_978_000)
  price(5_000_000, _ts(t1 + 2 * DAY))
  bl.repay(sp.record(project_id=1, usd_cents=11_000), _sender=contractor, _now=_ts(t1 + 2 * DAY))
  p1 = bl.data.projects[1]
  scenario.verify(p1.repaid_bro == 55_000)
  scenario.verify(p1.settled_pool_bro == 110_000)
  scenario.verify(p1.uncovered_bro == 0)
  scenario.verify(bal(ma.address) == 2_987_000)
  bl.claim_payout(1, _sender=alice, _now=_ts(t1 + 2 * DAY))
  scenario.verify(bal(alice.address) == 5_058_000)
  scenario.verify(bal(bl.address) == 0)

  # ----------------------------------------------------------------------
  scenario.h2("Project 2: default with a thin market reserve")
  t2 = 25 * DAY
  bl.submit_project(
    _project(_ts(t2 + 10 * DAY), 10_000, 1000, 6, [(5000, 5), (5000, 5)]),
    _sender=contractor,
    _now=_ts(t2),
  )
  price(10_000_000, _ts(t2))
  bl.invest(sp.record(project_id=2, max_bro=100_000), _sender=bob, _now=_ts(t2))
  bl.approve_milestone(2, _sender=admin, _now=_ts(t2 + DAY))
  price(10_000_000, _ts(t2 + DAY))
  bl.claim_milestone(2, _sender=contractor, _now=_ts(t2 + DAY))
  scenario.verify(bal(contractor.address) == 3_973_000)
  # M1 falls due at t2 + 6 days and is never delivered
  ma.withdraw_token(sp.record(to_=admin.address, amount=2_977_000), _sender=admin)
  scenario.verify(bal(ma.address) == 10_000)
  bl.mark_default(2, _sender=admin, _now=_ts(t2 + 13 * DAY), _valid=False, _exception="NOT_OVERDUE")
  bl.mark_default(2, _sender=carol, _now=_ts(t2 + 13 * DAY + 1), _valid=False, _exception="NOT_APPROVER")
  bl.mark_default(0, _sender=admin, _now=_ts(t2 + 13 * DAY + 1), _valid=False, _exception="NOT_DEFAULTABLE")
  bl.mark_default(2, _sender=approver, _now=_ts(t2 + 13 * DAY + 1))
  p2 = bl.data.projects[2]
  scenario.verify(p2.status == sp.variant.Defaulted(sp.unit))
  # pool: 50,000 unclaimed escrow + 10,000 from the market; 50,000 short
  scenario.verify(p2.settled_pool_bro == 60_000)
  scenario.verify(p2.uncovered_bro == 50_000)
  scenario.verify(bal(ma.address) == 0)
  bl.claim_milestone(2, _sender=contractor, _now=_ts(t2 + 14 * DAY), _valid=False, _exception="NOT_ACTIVE")
  bl.approve_milestone(2, _sender=admin, _now=_ts(t2 + 14 * DAY), _valid=False, _exception="NOT_ACTIVE")
  bl.claim_payout(2, _sender=bob, _now=_ts(t2 + 14 * DAY))
  scenario.verify(bal(bob.address) == 4_992_000)
  scenario.verify(bal(bl.address) == 0)
  scenario.verify(total() == 25_000_000)

  # ----------------------------------------------------------------------
  scenario.h2("Project 3: funding misses its deadline, investors refund")
  t3 = 30 * DAY
  bl.submit_project(
    _project(_ts(t3 + 5 * DAY), 10_000, 800, 6, [(10000, 5)]),
    _sender=contractor,
    _now=_ts(t3),
  )
  price(10_000_000, _ts(t3))
  bl.invest(sp.record(project_id=3, max_bro=30_000), _sender=alice, _now=_ts(t3))
  scenario.verify(bal(alice.address) == 5_028_000)
  bl.refund(3, _sender=alice, _now=_ts(t3), _valid=False, _exception="FUNDING_OPEN")
  closed = _ts(t3 + 5 * DAY + 1)
  price(10_000_000, closed)
  bl.invest(sp.record(project_id=3, max_bro=70_000), _sender=bob, _now=closed, _valid=False, _exception="FUNDING_CLOSED")
  bl.refund(3, _sender=carol, _now=closed, _valid=False, _exception="INVESTMENT_NOT_FOUND")
  bl.refund(3, _sender=alice, _now=closed)
  scenario.verify(bl.data.projects[3].status == sp.variant.Failed(sp.unit))
  scenario.verify(bal(alice.address) == 5_058_000)
  bl.refund(3, _sender=alice, _now=closed, _valid=False, _exception="INVESTMENT_NOT_FOUND")

  # ----------------------------------------------------------------------
  scenario.h2("Project 4: stale price, cancellation and refund")
  t4 = 40 * DAY
  bl.submit_project(
    _project(_ts(t4 + 10 * DAY), 10_000, 800, 6, [(10000, 5)]),
    _sender=contractor,
    _now=_ts(t4),
  )
  price(10_000_000, _ts(t4))
  bl.invest(sp.record(project_id=4, max_bro=20_000), _sender=bob, _now=_ts(t4))
  bl.invest(
    sp.record(project_id=4, max_bro=20_000),
    _sender=bob,
    _now=_ts(t4 + 3601),
    _valid=False,
    _exception="PRICE_STALE",
  )
  bl.refund(4, _sender=bob, _now=_ts(t4), _valid=False, _exception="FUNDING_OPEN")
  bl.cancel_project(4, _sender=carol, _valid=False, _exception="NOT_ADMIN")
  bl.cancel_project(4, _sender=admin)
  bl.cancel_project(4, _sender=admin, _valid=False, _exception="NOT_FUNDING")
  bl.invest(sp.record(project_id=4, max_bro=20_000), _sender=bob, _now=_ts(t4), _valid=False, _exception="NOT_FUNDING")
  bl.refund(4, _sender=bob, _now=_ts(t4))
  scenario.verify(bl.data.projects[4].status == sp.variant.Cancelled(sp.unit))
  scenario.verify(bal(bob.address) == 4_992_000)
  scenario.verify(bal(bl.address) == 0)

  # ----------------------------------------------------------------------
  scenario.h2("Admin settings and pause")
  bl.set_late_fee(10_001, _sender=admin, _valid=False, _exception="FEE_TOO_HIGH")
  bl.set_late_fee(50, _sender=carol, _valid=False, _exception="NOT_ADMIN")
  bl.set_late_fee(50, _sender=admin)
  bl.set_grace_days(14, _sender=admin)
  scenario.verify(bl.data.grace_days == 14)
  bl.set_market(carol.address, _sender=carol, _valid=False, _exception="NOT_ADMIN")
  bl.set_admin(carol.address, _sender=carol, _valid=False, _exception="NOT_ADMIN")
  bl.pause(True, _sender=carol, _valid=False, _exception="NOT_ADMIN")
  bl.pause(True, _sender=admin)
  t5 = 50 * DAY
  bl.submit_project(
    _project(_ts(t5 + 10 * DAY), 10_000, 800, 6, [(10000, 5)]),
    _sender=contractor,
    _now=_ts(t5),
    _valid=False,
    _exception="PAUSED",
  )
  bl.claim_payout(0, _sender=alice, _now=_ts(t5), _valid=False, _exception="PAUSED")
  bl.pause(False, _sender=admin)
  bl.submit_project(
    _project(_ts(t5 + 10 * DAY), 10_000, 800, 6, [(10000, 5)]),
    _sender=contractor,
    _now=_ts(t5),
  )
  scenario.verify(bl.data.projects[5].late_fee_bps_per_day == 50)
  price(10_000_000, _ts(t5))
  bl.pause(True, _sender=admin)
  bl.invest(sp.record(project_id=5, max_bro=1_000), _sender=alice, _now=_ts(t5), _valid=False, _exception="PAUSED")
  bl.pause(False, _sender=admin)
  bl.invest(sp.record(project_id=5, max_bro=1_000), _sender=alice, _now=_ts(t5))

  scenario.verify(total() == 25_000_000)
