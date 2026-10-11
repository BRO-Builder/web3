"""BROFunding: lists BRO Builder projects and collects their funding.

- A contractor submits a project with a USD budget (cents), a fixed
  interest rate, a repayment term and milestones that split the budget.
  The listing (including site and owner details, in plain text) stays here.
- Investors deposit BRO. Each deposit is valued in USD at the current
  BRO/USD price (read from BROMarketAssistant), and funding closes when
  the USD total reaches the budget.
- When funding closes, the BRO and the project's financial terms are
  handed to BROProjects (`launch`), which runs milestones, repayment and
  settlement under the same project id. Investor shares stay here and
  BROProjects reads them through `get_investment` at payout time.
- If the deadline passes first, or the admin cancels, investors refund.

Deployment order:
   1. Originate BROMarketAssistant
   2. Originate BROFunding(..., market=<market address>)
   3. Originate BROProjects(..., funding=<funding address>, market=...)
   4. Admin calls funding.set_projects(<projects address>)  (one-time)
   5. Admin calls market.set_ledger(<projects address>)

This is illustrative / educational code. Have it audited before using it
with real funds.
"""

import smartpy as sp
from .utils.common import t, units
from .utils.helper import helpers
from .bromarket import market


@sp.module
def funding():
  import t # type: ignore
  import units # type: ignore

  class BROFunding(sp.Contract):
    """Project listings, investor deposits and refunds, in BRO."""

    def __init__(
      self,
      metadata,
      admin,
      market,
      token_address,
      token_id,
      late_fee_bps_per_day,
      max_milestones,
    ):
      self.data.metadata = sp.cast(metadata, t.metadata)
      self.data.admin = sp.cast(admin, sp.address)
      self.data.paused = False
      self.data.market = sp.cast(market, sp.address)
      # BROProjects, linked once after origination
      self.data.projects_contract = sp.cast(None, sp.option[sp.address])
      self.data.token_address = sp.cast(token_address, sp.address)
      self.data.token_id = sp.cast(token_id, sp.nat)
      # snapshotted into each project at submission
      self.data.late_fee_bps_per_day = sp.cast(late_fee_bps_per_day, sp.nat)
      self.data.max_milestones = sp.cast(max_milestones, sp.nat)
      self.data.next_project_id = sp.nat(0)
      self.data.projects = sp.cast(sp.big_map(), sp.big_map[sp.nat, t.listing])
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

    # ------------------------------------------------------------------
    # Admin
    # ------------------------------------------------------------------
    @sp.entrypoint
    def set_admin(self, new_admin):
      sp.cast(new_admin, sp.address)
      assert sp.sender == self.data.admin, "NOT_ADMIN"
      self.data.admin = new_admin

    @sp.entrypoint
    def set_projects(self, projects_contract):
      """One-time link to BROProjects (breaks the circular dependency at
      origination)."""
      sp.cast(projects_contract, sp.address)
      assert sp.sender == self.data.admin, "NOT_ADMIN"
      assert not self.data.projects_contract.is_some(), "PROJECTS_ALREADY_SET"
      self.data.projects_contract = sp.Some(projects_contract)

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
    def pause(self, new_paused):
      """Admin-only switch. When paused, submit_project, invest and refund
      are disabled."""
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

      milestones = sp.cast({}, sp.map[sp.nat, t.milestone_terms])
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
        milestones=milestones,
        funded_usd=0,
        funded_bro=0,
        funded_at=None,
        status=sp.variant.Funding(),
      )
      self.data.next_project_id += 1

    # ------------------------------------------------------------------
    # Investor
    # ------------------------------------------------------------------
    @sp.entrypoint
    def invest(self, params):
      """Deposit up to `max_bro`, capped at what is still needed to reach
      the budget at today's price. Requires this contract to be an
      operator for the sender's BRO. The deposit that closes funding
      launches the project on BROProjects."""
      sp.cast(params, sp.record(project_id=sp.nat, max_bro=sp.nat))
      assert not self.data.paused, "PAUSED"
      projects_contract = self.data.projects_contract.unwrap_some(
        error="PROJECTS_NOT_SET"
      )
      p = self.data.projects.get(params.project_id, error="PROJECT_NOT_FOUND")
      assert p.status.is_variant.Funding(), "NOT_FUNDING"
      assert sp.now <= p.funding_deadline, "FUNDING_CLOSED"

      price = units.market_price(self.data.market)
      remaining_usd = sp.as_nat(p.budget_usd - p.funded_usd)
      remaining_bro = units.usd_to_bro_up((remaining_usd, price))
      bro = min(params.max_bro, remaining_bro)
      assert bro > 0, "AMOUNT_TOO_SMALL"
      usd = remaining_usd
      if bro < remaining_bro:
        usd = units.bro_to_usd((bro, price))

      key = (params.project_id, sp.sender)
      inv = self.data.investments.get(key, default=sp.record(usd=0, bro=0))
      inv.usd += usd
      inv.bro += bro
      self.data.investments[key] = inv

      p.funded_usd += usd
      p.funded_bro += bro
      launched = p.funded_usd == p.budget_usd
      if launched:
        p.status = sp.variant.Launched()
        p.funded_at = sp.Some(sp.now)
      self.data.projects[params.project_id] = p

      self.token_transfer_(
        sp.record(from_=sp.sender, to_=sp.self_address, amount=bro)
      )
      if launched:
        # move all of the project's BRO, then hand over its terms
        self.token_transfer_(
          sp.record(
            from_=sp.self_address, to_=projects_contract, amount=p.funded_bro
          )
        )
        launch = sp.contract(
          t.launch_params, projects_contract, "launch"
        ).unwrap_some(error="PROJECTS_LAUNCH_NOT_FOUND")
        sp.transfer(
          sp.record(
            project_id=params.project_id,
            contractor=p.contractor,
            budget_usd=p.budget_usd,
            interest_bps=p.interest_bps,
            term_months=p.term_months,
            late_fee_bps_per_day=p.late_fee_bps_per_day,
            funded_bro=p.funded_bro,
            milestones=[
              sp.record(
                pct_bps=ms.pct_bps, duration_days=ms.duration_days, usd=ms.usd
              )
              for ms in p.milestones.values()
            ],
          ),
          sp.mutez(0),
          launch,
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

    # ------------------------------------------------------------------
    # Views
    # ------------------------------------------------------------------
    @sp.onchain_view()
    def get_listing(self, project_id):
      sp.cast(project_id, sp.nat)
      return self.data.projects.get(project_id, error="PROJECT_NOT_FOUND")

    @sp.onchain_view()
    def get_investment(self, params):
      """Zero when the investor has no deposit (or refunded)."""
      sp.cast(params, t.investment_key)
      return self.data.investments.get(
        (params.project_id, params.investor), default=sp.record(usd=0, bro=0)
      )


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
def test_funding():
  admin = sp.test_account("Admin")
  oracle = sp.test_account("Oracle")
  contractor = sp.test_account("Contractor")
  alice = sp.test_account("Alice")
  bob = sp.test_account("Bob")
  carol = sp.test_account("Carol")
  dex = sp.test_account("Dex")

  scenario = sp.test_scenario(
    "build/BROFunding", [t, units, helpers, market, funding]
  )
  scenario.h1("BRO Project Funding")

  token = helpers.DummyFA2(admin.address)
  scenario += token
  for a in [alice, bob]:
    token.mint(to_=a.address, amount=5_000_000, _sender=admin)
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
  bf = funding.BROFunding(
    metadata=sp.big_map(),
    admin=admin.address,
    market=ma.address,
    token_address=token.address,
    token_id=0,
    late_fee_bps_per_day=100,
    max_milestones=20,
  )
  scenario += bf
  stub = helpers.ProjectsStub()
  scenario += stub

  def bal(account):
    return token.data.balances.get(account, sp.nat(0))

  def price(p, now):
    ma.update_price(p, _sender=oracle.address, _now=now)

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
    bf.submit_project(
      params, _sender=contractor, _now=_ts(0), _valid=False, _exception=err
    )

  bf.submit_project(
    _project(deadline, 100_000, 800, 12, ms3), _sender=contractor, _now=_ts(0)
  )
  p0 = bf.data.projects[0]
  scenario.verify(p0.status == sp.variant.Funding(sp.unit))
  scenario.verify(p0.milestones[0].usd == 50_000)
  scenario.verify(p0.milestones[2].usd == 20_000)
  scenario.verify(p0.late_fee_bps_per_day == 100)

  scenario.h2("Linking BROProjects")
  price(10_000_000, _ts(0))
  bf.invest(
    sp.record(project_id=0, max_bro=1), _sender=alice, _now=_ts(0),
    _valid=False, _exception="PROJECTS_NOT_SET",
  )
  bf.set_projects(stub.address, _sender=carol, _valid=False, _exception="NOT_ADMIN")
  bf.set_projects(stub.address, _sender=admin)
  bf.set_projects(stub.address, _sender=admin, _valid=False, _exception="PROJECTS_ALREADY_SET")

  # ----------------------------------------------------------------------
  scenario.h2("Funding closes and launches the project")
  bf.invest(
    sp.record(project_id=0, max_bro=0), _sender=alice, _now=_ts(0),
    _valid=False, _exception="AMOUNT_TOO_SMALL",
  )
  bf.invest(sp.record(project_id=0, max_bro=600_000), _sender=alice, _now=_ts(0))
  scenario.verify(bf.data.investments[(0, alice.address)].usd == 60_000)
  scenario.verify(bf.data.projects[0].status == sp.variant.Funding(sp.unit))
  scenario.verify(stub.data.launched.is_none())
  # overfunding is capped at the 400,000 BRO still needed
  bf.invest(sp.record(project_id=0, max_bro=900_000), _sender=bob, _now=_ts(0))
  scenario.verify(bf.data.investments[(0, bob.address)].bro == 400_000)
  scenario.verify(bf.data.investments[(0, bob.address)].usd == 40_000)
  p0 = bf.data.projects[0]
  scenario.verify(p0.status == sp.variant.Launched(sp.unit))
  scenario.verify(p0.funded_at == sp.Some(_ts(0)))
  scenario.verify(p0.funded_bro == 1_000_000)
  # all BRO moved to BROProjects together with the terms
  scenario.verify(bal(bf.address) == 0)
  scenario.verify(bal(stub.address) == 1_000_000)
  launched = stub.data.launched.unwrap_some()
  scenario.verify(launched.project_id == 0)
  scenario.verify(launched.contractor == contractor.address)
  scenario.verify(launched.funded_bro == 1_000_000)
  scenario.verify(launched.late_fee_bps_per_day == 100)
  scenario.verify(sp.len(launched.milestones) == 3)
  scenario.verify(bf.get_investment(sp.record(project_id=0, investor=alice.address)).bro == 600_000)
  scenario.verify(bf.get_investment(sp.record(project_id=0, investor=carol.address)).bro == 0)
  bf.invest(
    sp.record(project_id=0, max_bro=1), _sender=bob, _now=_ts(0),
    _valid=False, _exception="NOT_FUNDING",
  )
  bf.refund(0, _sender=alice, _now=_ts(40 * DAY), _valid=False, _exception="NOT_REFUNDABLE")

  # ----------------------------------------------------------------------
  scenario.h2("Funding misses its deadline, investors refund")
  t1 = 30 * DAY
  bf.submit_project(
    _project(_ts(t1 + 5 * DAY), 10_000, 800, 6, [(10000, 5)]),
    _sender=contractor,
    _now=_ts(t1),
  )
  price(10_000_000, _ts(t1))
  bf.invest(sp.record(project_id=1, max_bro=30_000), _sender=alice, _now=_ts(t1))
  scenario.verify(bal(alice.address) == 4_370_000)
  bf.refund(1, _sender=alice, _now=_ts(t1), _valid=False, _exception="FUNDING_OPEN")
  closed = _ts(t1 + 5 * DAY + 1)
  price(10_000_000, closed)
  bf.invest(
    sp.record(project_id=1, max_bro=70_000), _sender=bob, _now=closed,
    _valid=False, _exception="FUNDING_CLOSED",
  )
  bf.refund(1, _sender=carol, _now=closed, _valid=False, _exception="INVESTMENT_NOT_FOUND")
  bf.refund(1, _sender=alice, _now=closed)
  scenario.verify(bf.data.projects[1].status == sp.variant.Failed(sp.unit))
  scenario.verify(bal(alice.address) == 4_400_000)
  bf.refund(1, _sender=alice, _now=closed, _valid=False, _exception="INVESTMENT_NOT_FOUND")

  # ----------------------------------------------------------------------
  scenario.h2("Stale price, cancellation and refund")
  t2 = 40 * DAY
  bf.submit_project(
    _project(_ts(t2 + 10 * DAY), 10_000, 800, 6, [(10000, 5)]),
    _sender=contractor,
    _now=_ts(t2),
  )
  price(10_000_000, _ts(t2))
  bf.invest(sp.record(project_id=2, max_bro=20_000), _sender=bob, _now=_ts(t2))
  bf.invest(
    sp.record(project_id=2, max_bro=20_000), _sender=bob, _now=_ts(t2 + 3601),
    _valid=False, _exception="PRICE_STALE",
  )
  bf.refund(2, _sender=bob, _now=_ts(t2), _valid=False, _exception="FUNDING_OPEN")
  bf.cancel_project(2, _sender=carol, _valid=False, _exception="NOT_ADMIN")
  bf.cancel_project(2, _sender=admin)
  bf.cancel_project(2, _sender=admin, _valid=False, _exception="NOT_FUNDING")
  bf.cancel_project(0, _sender=admin, _valid=False, _exception="NOT_FUNDING")
  bf.invest(
    sp.record(project_id=2, max_bro=20_000), _sender=bob, _now=_ts(t2),
    _valid=False, _exception="NOT_FUNDING",
  )
  bf.refund(2, _sender=bob, _now=_ts(t2))
  scenario.verify(bf.data.projects[2].status == sp.variant.Cancelled(sp.unit))
  scenario.verify(bal(bob.address) == 4_600_000)
  scenario.verify(bal(bf.address) == 0)

  # ----------------------------------------------------------------------
  scenario.h2("Admin settings and pause")
  bf.set_late_fee(10_001, _sender=admin, _valid=False, _exception="FEE_TOO_HIGH")
  bf.set_late_fee(50, _sender=carol, _valid=False, _exception="NOT_ADMIN")
  bf.set_late_fee(50, _sender=admin)
  bf.set_market(carol.address, _sender=carol, _valid=False, _exception="NOT_ADMIN")
  bf.set_admin(carol.address, _sender=carol, _valid=False, _exception="NOT_ADMIN")
  bf.pause(True, _sender=carol, _valid=False, _exception="NOT_ADMIN")
  bf.pause(True, _sender=admin)
  t3 = 50 * DAY
  bf.submit_project(
    _project(_ts(t3 + 10 * DAY), 10_000, 800, 6, [(10000, 5)]),
    _sender=contractor, _now=_ts(t3), _valid=False, _exception="PAUSED",
  )
  bf.refund(2, _sender=bob, _now=_ts(t3), _valid=False, _exception="PAUSED")
  bf.pause(False, _sender=admin)
  bf.submit_project(
    _project(_ts(t3 + 10 * DAY), 10_000, 800, 6, [(10000, 5)]),
    _sender=contractor,
    _now=_ts(t3),
  )
  scenario.verify(bf.data.projects[3].late_fee_bps_per_day == 50)
  price(10_000_000, _ts(t3))
  bf.pause(True, _sender=admin)
  bf.invest(
    sp.record(project_id=3, max_bro=1_000), _sender=alice, _now=_ts(t3),
    _valid=False, _exception="PAUSED",
  )
  bf.pause(False, _sender=admin)
  bf.invest(sp.record(project_id=3, max_bro=1_000), _sender=alice, _now=_ts(t3))
