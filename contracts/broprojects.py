"""BROProjects: runs funded BRO Builder projects, from milestones to
settlement.

- BROFunding launches a project here once it is fully funded, sending its
  BRO and financial terms (same project id). The BRO is split into
  per-milestone escrow and the first milestone falls due.
- Milestones are approved by the admin or any holder of the configured
  NFT. On claim the contractor receives BRO worth exactly the milestone's
  USD amount. Surplus escrow goes to the funding wallet, and any shortfall
  is paid from it through the market assistant's `cover` entrypoint.
- End date: launch proposes the listing's `est_completion`; the
  contractor may propose other dates later. A date counts only once the
  admin approves it (the previous approved date stays in force until
  then). `term_months` is informational only.
- The contractor repays budget + interest in USD (converted at the price
  on the day of each installment), plus a late fee for each day (rounded
  up) past the approved end date + grace: `late_fee_bps_per_day` of
  budget + interest, capped at 100%. The late fee goes to the funding
  wallet. Investors are owed their deposit plus
  interest in BRO; the funding wallet takes the excess or covers the gap
  as far as its balance allows. Investor shares are read from
  BROFunding's `get_investment` view at payout time.
- The funding wallet is a plain tz wallet. Its address is read from the
  market assistant's `get_funding_wallet` view. The wallet must have made
  the market assistant an FA2 operator of its BRO so `cover` can work.

Units: USD is nat cents; price is BRO base units per cent, times 10^6.
See brofunding.py for the deployment order.

This is illustrative / educational code. Have it audited before using it
with real funds.
"""

import smartpy as sp
from .utils.common import t, units
from .utils.helper import helpers
from .bromarket import market
from .brofunding import funding, DAY, _ts, _project


@sp.module
def projects():
  import t # type: ignore
  import units # type: ignore

  def amount_due(p):
    """Budget plus interest, in cents (without the late fee)."""
    sp.cast(p, t.project)
    return p.budget_usd * (10000 + p.interest_bps) / 10000

  def late_fee(params):
    """Repayment late fee in cents at `now`, for a project worth `due`
    cents (budget + interest). No fee until the admin has approved an end
    date, and none up to the end date + grace. After that, every day
    (rounded up) since the end date itself, grace days included, costs
    `bps_per_day` of `due`, capped at 100%."""
    sp.cast(
      params,
      sp.record(
        end_date=sp.option[sp.timestamp],
        grace_days=sp.nat,
        bps_per_day=sp.nat,
        due=sp.nat,
        now=sp.timestamp,
      ),
    )
    fee = 0
    if params.end_date.is_some():
      end = params.end_date.unwrap_some()
      grace_end = sp.add_seconds(end, sp.to_int(params.grace_days) * 86400)
      if params.now > grace_end:
        late_days = (sp.as_nat(params.now - end) + 86399) / 86400
        fee = params.due * min(10000, late_days * params.bps_per_day) / 10000
    return fee

  class BROProjects(sp.Contract):
    """Milestones, repayment and settlement of funded projects, in BRO."""

    def __init__(
      self, metadata, admin, funding, market, token_address, token_id, grace_days
    ):
      self.data.metadata = sp.cast(metadata, t.metadata)
      self.data.admin = sp.cast(admin, sp.address)
      self.data.paused = False
      self.data.funding = sp.cast(funding, sp.address)
      self.data.market = sp.cast(market, sp.address)
      self.data.token_address = sp.cast(token_address, sp.address)
      self.data.token_id = sp.cast(token_id, sp.nat)
      # holders of this token may approve milestones
      self.data.nft = sp.cast(None, sp.option[t.nft_ref])
      self.data.grace_days = sp.cast(grace_days, sp.nat)
      self.data.projects = sp.cast(sp.big_map(), sp.big_map[sp.nat, t.project])
      self.data.payouts_claimed = sp.cast(
        sp.big_map(), sp.big_map[sp.pair[sp.nat, sp.address], sp.unit]
      )

    @sp.private(with_storage="read-only", with_operations=True)
    def token_transfer_(self, params):
      """Send BRO from this contract (skipped for zero amounts)."""
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
      """Have the market assistant pay BRO out of the funding wallet
      (skipped for zero amounts)."""
      sp.cast(params, t.cover_params)
      if params.amount > 0:
        contract = sp.contract(
          t.cover_params, self.data.market, "cover"
        ).unwrap_some(error="MARKET_COVER_NOT_FOUND")
        sp.transfer(params, sp.mutez(0), contract)

    @sp.private(with_storage="read-only")
    def is_approver_(self):
      """True for the admin, or a holder of the configured NFT."""
      ok = sp.sender == self.data.admin
      if not ok:
        if self.data.nft.is_some():
          nft = self.data.nft.unwrap_some()
          ok = (
            units.token_balance(
              sp.record(
                token=nft.address, owner=sp.sender, token_id=nft.token_id
              )
            )
            > 0
          )
      return ok

    @sp.private(with_storage="read-write")
    def settle_(self, params):
      """Fix the pool investors split: repaid BRO plus unclaimed escrow,
      trimmed to their entitlement or topped up from the funding wallet as
      far as its balance allows. `wallet` is the funding wallet address,
      read by the caller from the market assistant. Returns the BRO the
      caller must send to the wallet (`surplus`) and request from it
      (`cover`)."""
      sp.cast(params, sp.record(project_id=sp.nat, wallet=sp.address))
      p = self.data.projects[params.project_id]
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
        reserve = units.token_balance(
          sp.record(
            token=self.data.token_address,
            owner=params.wallet,
            token_id=self.data.token_id,
          )
        )
        cover = min(shortfall, reserve)
        p.uncovered_bro = sp.as_nat(shortfall - cover)
        pool += cover
      p.settled_pool_bro = pool
      self.data.projects[params.project_id] = p
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
    def set_grace_days(self, days):
      sp.cast(days, sp.nat)
      assert sp.sender == self.data.admin, "NOT_ADMIN"
      self.data.grace_days = days

    @sp.entrypoint
    def pause(self, new_paused):
      """Admin-only switch. When paused, claim_milestone, repay and
      claim_payout are disabled."""
      sp.cast(new_paused, sp.bool)
      assert sp.sender == self.data.admin, "NOT_ADMIN"
      self.data.paused = new_paused

    # ------------------------------------------------------------------
    # BROFunding
    # ------------------------------------------------------------------
    @sp.entrypoint
    def launch(self, params):
      """Funding-only. Start a fully funded project: split its BRO (sent
      just before this call) into per-milestone escrow, the last taking
      the rounding remainder, and start the first deadline."""
      sp.cast(params, t.launch_params)
      assert sp.sender == self.data.funding, "NOT_FUNDING_CONTRACT"
      assert not params.project_id in self.data.projects, "ALREADY_LAUNCHED"

      milestones = sp.cast({}, sp.map[sp.nat, t.milestone])
      n = sp.len(params.milestones)
      left = params.funded_bro
      for m in params.milestones:
        i = sp.len(milestones)
        share = params.funded_bro * m.pct_bps / 10000
        if i + 1 == n:
          share = left
        left = sp.as_nat(left - share)
        due_at = None
        if i == 0:
          due_at = sp.Some(sp.add_seconds(sp.now, sp.to_int(m.duration_days) * 86400))
        milestones[i] = sp.record(
          pct_bps=m.pct_bps,
          duration_days=m.duration_days,
          usd=m.usd,
          escrow_bro=share,
          due_at=due_at,
          approved_at=None,
          claimed=False,
        )

      self.data.projects[params.project_id] = sp.record(
        contractor=params.contractor,
        budget_usd=params.budget_usd,
        interest_bps=params.interest_bps,
        term_months=params.term_months,
        late_fee_bps_per_day=params.late_fee_bps_per_day,
        funded_bro=params.funded_bro,
        funded_at=sp.now,
        end_date=None,
        proposed_end_date=sp.Some(params.est_completion),
        milestones=milestones,
        current_milestone=0,
        repaid_usd=0,
        repaid_bro=0,
        late_fee_usd=0,
        settled_pool_bro=0,
        uncovered_bro=0,
        status=sp.variant.Active(),
      )

    # ------------------------------------------------------------------
    # Contractor
    # ------------------------------------------------------------------
    @sp.entrypoint
    def claim_milestone(self, project_id):
      """Pay out every approved, unclaimed milestone: BRO worth their USD
      amount at today's price. Surplus escrow goes to the funding wallet; a
      shortfall is paid from the wallet via the market assistant (the
      claim fails if the wallet is short or has not approved the market
      as FA2 operator)."""
      sp.cast(project_id, sp.nat)
      assert not self.data.paused, "PAUSED"
      p = self.data.projects.get(project_id, error="PROJECT_NOT_FOUND")
      assert sp.sender == p.contractor, "NOT_CONTRACTOR"
      assert p.status.is_variant.Active(), "NOT_ACTIVE"

      need_usd = 0
      escrow = 0
      for i in range(0, p.current_milestone):
        if not p.milestones[i].claimed:
          need_usd += p.milestones[i].usd
          escrow += p.milestones[i].escrow_bro
          p.milestones[i].claimed = True
      assert escrow > 0, "NOTHING_TO_CLAIM"

      need = units.usd_to_bro((need_usd, units.market_price(self.data.market)))
      if p.current_milestone == sp.len(p.milestones):
        p.status = sp.variant.Repaying()
      self.data.projects[project_id] = p

      if escrow >= need:
        wallet = sp.view(
          "get_funding_wallet", self.data.market, (), sp.address
        ).unwrap_some(error="MARKET_VIEW_UNAVAILABLE")
        self.token_transfer_(
          sp.record(from_=sp.self_address, to_=p.contractor, amount=need)
        )
        self.token_transfer_(
          sp.record(
            from_=sp.self_address,
            to_=wallet,
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
      """Pay an installment of budget + interest + late fee, in USD cents,
      converted at today's price. Anyone may pay; the sender must have made
      this contract an operator for their BRO. Settles once fully repaid.
      The late fee BRO ends up with the funding wallet as settlement
      surplus (investors are owed deposit + interest only)."""
      sp.cast(params, sp.record(project_id=sp.nat, usd_cents=sp.nat))
      assert not self.data.paused, "PAUSED"
      p = self.data.projects.get(params.project_id, error="PROJECT_NOT_FOUND")
      assert p.status.is_variant.Repaying(), "NOT_REPAYING"
      fee = late_fee(
        sp.record(
          end_date=p.end_date,
          grace_days=self.data.grace_days,
          bps_per_day=p.late_fee_bps_per_day,
          due=amount_due(p),
          now=sp.now,
        )
      )
      due = amount_due(p) + fee
      # a raised grace_days can lower the fee below what is already repaid
      owed = 0
      if due > p.repaid_usd:
        owed = sp.as_nat(due - p.repaid_usd)
      usd = min(params.usd_cents, owed)
      assert usd > 0 or owed == 0, "AMOUNT_TOO_SMALL"
      bro = units.usd_to_bro_up((usd, units.market_price(self.data.market)))

      p.repaid_usd += usd
      p.repaid_bro += bro
      p.late_fee_usd = fee
      repaid = p.repaid_usd >= due
      if repaid:
        p.status = sp.variant.Repaid()
      self.data.projects[params.project_id] = p

      self.token_transfer_(
        sp.record(from_=sp.sender, to_=sp.self_address, amount=bro)
      )
      if repaid:
        wallet = sp.view(
          "get_funding_wallet", self.data.market, (), sp.address
        ).unwrap_some(error="MARKET_VIEW_UNAVAILABLE")
        settled = self.settle_(
          sp.record(project_id=params.project_id, wallet=wallet)
        )
        self.token_transfer_(
          sp.record(
            from_=sp.self_address, to_=wallet, amount=settled.surplus
          )
        )
        self.market_cover_(sp.record(to_=sp.self_address, amount=settled.cover))

    # ------------------------------------------------------------------
    # Investor
    # ------------------------------------------------------------------
    @sp.entrypoint
    def claim_payout(self, project_id):
      """Once settled, pay the sender their share of the pool, in
      proportion to their BRO deposit on BROFunding."""
      sp.cast(project_id, sp.nat)
      assert not self.data.paused, "PAUSED"
      p = self.data.projects.get(project_id, error="PROJECT_NOT_FOUND")
      assert (
        p.status.is_variant.Repaid() or p.status.is_variant.Defaulted()
      ), "NOT_SETTLED"
      key = (project_id, sp.sender)
      assert not key in self.data.payouts_claimed, "ALREADY_CLAIMED"
      inv = sp.view(
        "get_investment",
        self.data.funding,
        sp.record(project_id=project_id, investor=sp.sender),
        t.investment,
      ).unwrap_some(error="FUNDING_VIEW_UNAVAILABLE")
      assert inv.bro > 0, "INVESTMENT_NOT_FOUND"
      self.data.payouts_claimed[key] = ()

      self.token_transfer_(
        sp.record(
          from_=sp.self_address,
          to_=sp.sender,
          amount=p.settled_pool_bro * inv.bro / p.funded_bro,
        )
      )

    # ------------------------------------------------------------------
    # End date: the contractor proposes, the admin approves
    # ------------------------------------------------------------------
    @sp.entrypoint
    def propose_end_date(self, params):
      """Contractor-only. Replaces any pending proposal. The approved end
      date (if any) stays in force until the admin approves this one."""
      sp.cast(params, sp.record(project_id=sp.nat, end_date=sp.timestamp))
      p = self.data.projects.get(params.project_id, error="PROJECT_NOT_FOUND")
      assert sp.sender == p.contractor, "NOT_CONTRACTOR"
      assert (
        p.status.is_variant.Active() or p.status.is_variant.Repaying()
      ), "NOT_OPEN"
      p.proposed_end_date = sp.Some(params.end_date)
      self.data.projects[params.project_id] = p

    @sp.entrypoint
    def approve_end_date(self, params):
      """Admin-only. `end_date` must equal the pending proposal, so a
      proposal replaced just before approval is not approved by mistake."""
      sp.cast(params, sp.record(project_id=sp.nat, end_date=sp.timestamp))
      assert sp.sender == self.data.admin, "NOT_ADMIN"
      p = self.data.projects.get(params.project_id, error="PROJECT_NOT_FOUND")
      assert (
        p.status.is_variant.Active() or p.status.is_variant.Repaying()
      ), "NOT_OPEN"
      proposed = p.proposed_end_date.unwrap_some(error="NO_PROPOSAL")
      assert proposed == params.end_date, "PROPOSAL_MISMATCH"
      p.end_date = sp.Some(proposed)
      p.proposed_end_date = None
      self.data.projects[params.project_id] = p

    @sp.entrypoint
    def reject_end_date(self, project_id):
      """Admin-only. Drops the pending proposal; the approved end date (if
      any) is unchanged."""
      sp.cast(project_id, sp.nat)
      assert sp.sender == self.data.admin, "NOT_ADMIN"
      p = self.data.projects.get(project_id, error="PROJECT_NOT_FOUND")
      assert p.proposed_end_date.is_some(), "NO_PROPOSAL"
      p.proposed_end_date = None
      self.data.projects[project_id] = p

    # ------------------------------------------------------------------
    # Approver (admin or NFT holder)
    # ------------------------------------------------------------------
    @sp.entrypoint
    def approve_milestone(self, project_id):
      """Approve the current milestone (no fee, even when late). The next
      milestone falls due `duration_days` from now."""
      sp.cast(project_id, sp.nat)
      assert self.is_approver_(), "NOT_APPROVER"
      p = self.data.projects.get(project_id, error="PROJECT_NOT_FOUND")
      assert p.status.is_variant.Active(), "NOT_ACTIVE"
      i = p.current_milestone
      n = sp.len(p.milestones)
      assert i < n, "NO_PENDING_MILESTONE"

      p.milestones[i].approved_at = sp.Some(sp.now)
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
      """Default a project past its approved end date + grace, or, while
      Active, past its current milestone's due date + grace. Without an
      approved end date only the milestone rule applies. Unclaimed escrow
      joins the pool. The late fee owed so far is recorded but not
      collected."""
      sp.cast(project_id, sp.nat)
      assert self.is_approver_(), "NOT_APPROVER"
      p = self.data.projects.get(project_id, error="PROJECT_NOT_FOUND")
      assert (
        p.status.is_variant.Active() or p.status.is_variant.Repaying()
      ), "NOT_DEFAULTABLE"

      grace = sp.to_int(self.data.grace_days) * 86400
      overdue = False
      if p.end_date.is_some():
        overdue = sp.now > sp.add_seconds(p.end_date.unwrap_some(), grace)
      if p.status.is_variant.Active() and p.current_milestone < sp.len(
        p.milestones
      ):
        due = p.milestones[p.current_milestone].due_at.unwrap_some()
        overdue = overdue or sp.now > sp.add_seconds(due, grace)
      assert overdue, "NOT_OVERDUE"

      p.late_fee_usd = late_fee(
        sp.record(
          end_date=p.end_date,
          grace_days=self.data.grace_days,
          bps_per_day=p.late_fee_bps_per_day,
          due=amount_due(p),
          now=sp.now,
        )
      )
      p.status = sp.variant.Defaulted()
      self.data.projects[project_id] = p
      wallet = sp.view(
        "get_funding_wallet", self.data.market, (), sp.address
      ).unwrap_some(error="MARKET_VIEW_UNAVAILABLE")
      settled = self.settle_(sp.record(project_id=project_id, wallet=wallet))
      self.token_transfer_(
        sp.record(from_=sp.self_address, to_=wallet, amount=settled.surplus)
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
    def get_amount_due(self, project_id):
      """Cents still owed (budget + interest + late fee - repaid). The late
      fee is live while Active/Repaying and fixed once settled."""
      sp.cast(project_id, sp.nat)
      p = self.data.projects.get(project_id, error="PROJECT_NOT_FOUND")
      fee = p.late_fee_usd
      if p.status.is_variant.Active() or p.status.is_variant.Repaying():
        fee = late_fee(
          sp.record(
            end_date=p.end_date,
            grace_days=self.data.grace_days,
            bps_per_day=p.late_fee_bps_per_day,
            due=amount_due(p),
            now=sp.now,
          )
        )
      due = amount_due(p) + fee
      owed = 0
      if due > p.repaid_usd:
        owed = sp.as_nat(due - p.repaid_usd)
      return owed


@sp.add_test()
def test_projects():
  admin = sp.test_account("Admin")
  oracle = sp.test_account("Oracle")
  contractor = sp.test_account("Contractor")
  alice = sp.test_account("Alice")
  bob = sp.test_account("Bob")
  carol = sp.test_account("Carol")
  approver = sp.test_account("Approver")
  wallet = sp.test_account("FundingWallet")

  scenario = sp.test_scenario(
    "build/BROProjects", [t, units, helpers, market, funding, projects]
  )
  scenario.h1("BRO Projects: milestones, repayment and settlement")

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
    funding_wallet=wallet.address,
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
  bp = projects.BROProjects(
    metadata=sp.big_map(),
    admin=admin.address,
    funding=bf.address,
    market=ma.address,
    token_address=token.address,
    token_id=0,
    grace_days=7,
  )
  scenario += bp
  bf.set_projects(bp.address, _sender=admin)
  ma.set_ledger(bp.address, _sender=admin)
  # the funding wallet lets the market assistant pull BRO for `cover`
  token.update_operators(
    [sp.variant.add_operator(
      sp.record(owner=wallet.address, operator=ma.address, token_id=0)
    )],
    _sender=wallet.address,
  )

  def approve(owner, operator):
    """Make `operator` an FA2 operator of the owner's BRO."""
    token.update_operators(
      [sp.variant.add_operator(
        sp.record(owner=owner.address, operator=operator.address, token_id=0)
      )],
      _sender=owner,
    )

  # investors let BROFunding pull their deposits
  approve(alice, bf)
  approve(bob, bf)

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
      + bal(wallet.address)
      + bal(bf.address)
      + bal(bp.address)
    )

  token.transfer(
    [
      sp.record(
        from_=admin.address,
        txs=[sp.record(to_=wallet.address, token_id=0, amount=2_000_000)],
      )
    ],
    _sender=admin,
  )
  scenario.verify(total() == 25_000_000)

  bp.launch(
    sp.record(
      project_id=99, contractor=carol.address, budget_usd=1, interest_bps=50,
      term_months=1, late_fee_bps_per_day=0, funded_bro=1, est_completion=_ts(0),
      milestones=[sp.record(pct_bps=10000, duration_days=1, usd=1)],
    ),
    _sender=carol,
    _valid=False,
    _exception="NOT_FUNDING_CONTRACT",
  )

  # ----------------------------------------------------------------------
  scenario.h2("Project 0: fund, three milestones, repay, settle with surplus")
  deadline = _ts(30 * DAY)
  ms3 = [(5000, 10), (3000, 10), (2000, 10)]
  bf.submit_project(
    _project(deadline, 100_000, 800, 12, ms3), _sender=contractor, _now=_ts(0)
  )
  # 10 BRO units per cent
  price(10_000_000, _ts(0))
  bf.invest(sp.record(project_id=0, max_bro=600_000), _sender=alice, _now=_ts(0))
  bf.invest(sp.record(project_id=0, max_bro=900_000), _sender=bob, _now=_ts(0))
  p0 = bp.data.projects[0]
  scenario.verify(p0.status == sp.variant.Active(sp.unit))
  scenario.verify(p0.funded_bro == 1_000_000)
  scenario.verify(p0.funded_at == _ts(0))
  scenario.verify(p0.milestones[0].escrow_bro == 500_000)
  scenario.verify(p0.milestones[1].escrow_bro == 300_000)
  scenario.verify(p0.milestones[2].escrow_bro == 200_000)
  scenario.verify(p0.milestones[0].due_at == sp.Some(_ts(10 * DAY)))
  scenario.verify(p0.milestones[1].due_at.is_none())
  scenario.verify(bal(bf.address) == 0)
  scenario.verify(bal(bp.address) == 1_000_000)

  scenario.p("Approvers: admin and NFT holders only")
  bp.approve_milestone(0, _sender=approver, _now=_ts(5 * DAY), _valid=False, _exception="NOT_APPROVER")
  bp.set_nft(sp.Some(sp.record(address=nft.address, token_id=0)), _sender=carol, _valid=False)
  bp.set_nft(sp.Some(sp.record(address=nft.address, token_id=0)), _sender=admin)
  bp.approve_milestone(0, _sender=carol, _now=_ts(5 * DAY), _valid=False, _exception="NOT_APPROVER")
  bp.claim_milestone(0, _sender=contractor, _now=_ts(5 * DAY), _valid=False, _exception="NOTHING_TO_CLAIM")

  scenario.p("M0 on time, price unchanged: escrow pays exactly")
  bp.approve_milestone(0, _sender=admin, _now=_ts(5 * DAY))
  p0 = bp.data.projects[0]
  scenario.verify(p0.milestones[0].approved_at == sp.Some(_ts(5 * DAY)))
  scenario.verify(p0.milestones[1].due_at == sp.Some(_ts(15 * DAY)))
  price(10_000_000, _ts(5 * DAY))
  bp.claim_milestone(0, _sender=carol, _now=_ts(5 * DAY), _valid=False, _exception="NOT_CONTRACTOR")
  bp.claim_milestone(0, _sender=contractor, _now=_ts(5 * DAY))
  scenario.verify(bal(contractor.address) == 5_500_000)
  scenario.verify(bal(wallet.address) == 2_000_000)
  bp.claim_milestone(0, _sender=contractor, _now=_ts(5 * DAY), _valid=False, _exception="NOTHING_TO_CLAIM")

  scenario.p("M1 by an NFT holder after BRO doubled: surplus escrow to the funding wallet")
  bp.approve_milestone(0, _sender=approver, _now=_ts(6 * DAY))
  price(5_000_000, _ts(6 * DAY))
  bp.claim_milestone(0, _sender=contractor, _now=_ts(6 * DAY))
  scenario.verify(bal(contractor.address) == 5_650_000)
  scenario.verify(bal(wallet.address) == 2_150_000)

  scenario.p("M2 approved 2 days + 1 second late (no milestone fee) after BRO halved: wallet covers")
  late = _ts(18 * DAY + 1)
  bp.approve_milestone(0, _sender=admin, _now=late)
  bp.approve_milestone(0, _sender=admin, _now=late, _valid=False, _exception="NO_PENDING_MILESTONE")
  bp.repay(sp.record(project_id=0, usd_cents=1), _sender=contractor, _now=late, _valid=False, _exception="NOT_REPAYING")
  price(20_000_000, late)
  bp.claim_milestone(0, _sender=contractor, _now=late)
  # the full 20,000 cents = 400,000 BRO: 200,000 escrow + 200,000 covered
  scenario.verify(bal(contractor.address) == 6_050_000)
  scenario.verify(bal(wallet.address) == 1_950_000)
  scenario.verify(bal(bp.address) == 0)
  scenario.verify(bp.data.projects[0].status == sp.variant.Repaying(sp.unit))
  bp.claim_payout(0, _sender=alice, _now=late, _valid=False, _exception="NOT_SETTLED")

  scenario.p("Repay 108,000 cents in two installments at 20 BRO units per cent, before the end date (M2 due 16 days + 7 grace)")
  scenario.verify(bp.get_amount_due(0) == 108_000)
  # without operator approval the BRO pull fails and nothing changes
  bp.repay(
    sp.record(project_id=0, usd_cents=50_000), _sender=contractor, _now=late,
    _valid=False,
  )
  scenario.verify(bp.get_amount_due(0) == 108_000)
  scenario.verify(bal(contractor.address) == 6_050_000)
  approve(contractor, bp)
  bp.repay(sp.record(project_id=0, usd_cents=50_000), _sender=contractor, _now=late)
  scenario.verify(bal(contractor.address) == 5_050_000)
  # RESTORED: second installment, capped at the 58,000 cents still owed
  scenario.verify(bp.get_amount_due(0) == 58_000)
  bp.repay(sp.record(project_id=0, usd_cents=100_000), _sender=contractor, _now=late)
  scenario.verify(bal(contractor.address) == 3_890_000)
  p0 = bp.data.projects[0]
  scenario.verify(p0.status == sp.variant.Repaid(sp.unit))
  scenario.verify(p0.late_fee_usd == 0)
  scenario.verify(p0.repaid_bro == 2_160_000)
  # entitlement is 1,080,000 BRO; the other 1,080,000 goes to the funding wallet
  scenario.verify(p0.settled_pool_bro == 1_080_000)
  scenario.verify(p0.uncovered_bro == 0)
  scenario.verify(bal(wallet.address) == 3_030_000)
  scenario.verify(bp.get_amount_due(0) == 0)

  bp.claim_payout(0, _sender=alice, _now=late)
  bp.claim_payout(0, _sender=bob, _now=late)
  scenario.verify(bal(alice.address) == 5_048_000)
  scenario.verify(bal(bob.address) == 5_032_000)
  scenario.verify(bal(bp.address) == 0)
  bp.claim_payout(0, _sender=alice, _now=late, _valid=False, _exception="ALREADY_CLAIMED")
  bp.claim_payout(0, _sender=carol, _now=late, _valid=False, _exception="INVESTMENT_NOT_FOUND")
  scenario.verify(total() == 25_000_000)

  # ----------------------------------------------------------------------
  scenario.h2("Project 1: BRO rose before repayment, wallet covers the gap")
  t1 = 20 * DAY
  bf.submit_project(
    _project(_ts(t1 + 10 * DAY), 10_000, 1000, 6, [(10000, 5)]),
    _sender=contractor,
    _now=_ts(t1),
  )
  price(10_000_000, _ts(t1))
  bf.invest(sp.record(project_id=1, max_bro=1_000_000), _sender=alice, _now=_ts(t1))
  scenario.verify(bf.data.investments[(1, alice.address)].bro == 100_000)
  scenario.verify(bp.data.projects[1].status == sp.variant.Active(sp.unit))
  bp.approve_milestone(1, _sender=admin, _now=_ts(t1 + DAY))
  price(10_000_000, _ts(t1 + DAY))
  bp.claim_milestone(1, _sender=contractor, _now=_ts(t1 + DAY))
  scenario.verify(bal(contractor.address) == 3_990_000)
  price(5_000_000, _ts(t1 + 2 * DAY))
  bp.repay(sp.record(project_id=1, usd_cents=11_000), _sender=contractor, _now=_ts(t1 + 2 * DAY))
  p1 = bp.data.projects[1]
  scenario.verify(p1.repaid_bro == 55_000)
  scenario.verify(p1.settled_pool_bro == 110_000)
  scenario.verify(p1.uncovered_bro == 0)
  scenario.verify(bal(wallet.address) == 2_975_000)
  bp.claim_payout(1, _sender=alice, _now=_ts(t1 + 2 * DAY))
  scenario.verify(bal(alice.address) == 5_058_000)
  scenario.verify(bal(bp.address) == 0)

  # ----------------------------------------------------------------------
  scenario.h2("Project 2: default with a thin funding wallet")
  t2 = 25 * DAY
  bf.submit_project(
    _project(_ts(t2 + 10 * DAY), 10_000, 1000, 6, [(5000, 5), (5000, 5)]),
    _sender=contractor,
    _now=_ts(t2),
  )
  price(10_000_000, _ts(t2))
  bf.invest(sp.record(project_id=2, max_bro=100_000), _sender=bob, _now=_ts(t2))
  bp.approve_milestone(2, _sender=admin, _now=_ts(t2 + DAY))
  price(10_000_000, _ts(t2 + DAY))
  bp.claim_milestone(2, _sender=contractor, _now=_ts(t2 + DAY))
  scenario.verify(bal(contractor.address) == 3_985_000)
  # M1 falls due at t2 + 6 days and is never delivered
  # the wallet owner moves most of its BRO out directly
  token.transfer(
    [
      sp.record(
        from_=wallet.address,
        txs=[sp.record(to_=admin.address, token_id=0, amount=2_965_000)],
      )
    ],
    _sender=wallet,
  )
  scenario.verify(bal(wallet.address) == 10_000)
  bp.mark_default(2, _sender=admin, _now=_ts(t2 + 13 * DAY), _valid=False, _exception="NOT_OVERDUE")
  bp.mark_default(2, _sender=carol, _now=_ts(t2 + 13 * DAY + 1), _valid=False, _exception="NOT_APPROVER")
  bp.mark_default(0, _sender=admin, _now=_ts(t2 + 13 * DAY + 1), _valid=False, _exception="NOT_DEFAULTABLE")
  bp.mark_default(2, _sender=approver, _now=_ts(t2 + 13 * DAY + 1))
  p2 = bp.data.projects[2]
  scenario.verify(p2.status == sp.variant.Defaulted(sp.unit))
  # pool: 50,000 unclaimed escrow + 10,000 from the wallet; 50,000 short
  scenario.verify(p2.settled_pool_bro == 60_000)
  scenario.verify(p2.uncovered_bro == 50_000)
  # no approved end date, so no late fee
  scenario.verify(p2.end_date.is_none())
  scenario.verify(p2.late_fee_usd == 0)
  scenario.verify(bp.get_amount_due(2) == 11_000)
  scenario.verify(bal(wallet.address) == 0)
  bp.claim_milestone(2, _sender=contractor, _now=_ts(t2 + 14 * DAY), _valid=False, _exception="NOT_ACTIVE")
  bp.approve_milestone(2, _sender=admin, _now=_ts(t2 + 14 * DAY), _valid=False, _exception="NOT_ACTIVE")
  bp.claim_payout(2, _sender=bob, _now=_ts(t2 + 14 * DAY))
  scenario.verify(bal(bob.address) == 4_992_000)
  scenario.verify(bal(bp.address) == 0)
  scenario.verify(total() == 25_000_000)

  # ----------------------------------------------------------------------
  scenario.h2("Project 3: end date approved, repaid late, fee to the funding wallet")
  t3 = 40 * DAY
  bf.submit_project(
    _project(_ts(t3 + 10 * DAY), 10_000, 1000, 6, [(10000, 5)]),
    _sender=contractor,
    _now=_ts(t3),
  )
  price(10_000_000, _ts(t3))
  bf.invest(sp.record(project_id=3, max_bro=1_000_000), _sender=alice, _now=_ts(t3))
  scenario.verify(bal(alice.address) == 4_958_000)
  est = _ts(t3 + 100 * DAY)
  p3 = bp.data.projects[3]
  scenario.verify(p3.end_date.is_none())
  scenario.verify(p3.proposed_end_date == sp.Some(est))

  scenario.p("Approving the proposal from launch (est_completion)")
  bp.approve_end_date(sp.record(project_id=3, end_date=est), _sender=carol, _valid=False, _exception="NOT_ADMIN")
  bp.approve_end_date(sp.record(project_id=3, end_date=_ts(t3)), _sender=admin, _valid=False, _exception="PROPOSAL_MISMATCH")
  bp.approve_end_date(sp.record(project_id=3, end_date=est), _sender=admin)
  p3 = bp.data.projects[3]
  scenario.verify(p3.end_date == sp.Some(est))
  scenario.verify(p3.proposed_end_date.is_none())
  bp.approve_end_date(sp.record(project_id=3, end_date=est), _sender=admin, _valid=False, _exception="NO_PROPOSAL")
  bp.reject_end_date(3, _sender=admin, _valid=False, _exception="NO_PROPOSAL")

  scenario.p("The contractor proposes t3 + 5 days and the admin approves it")
  end_date = _ts(t3 + 5 * DAY)
  bp.propose_end_date(sp.record(project_id=3, end_date=end_date), _sender=carol, _valid=False, _exception="NOT_CONTRACTOR")
  bp.propose_end_date(sp.record(project_id=3, end_date=end_date), _sender=contractor)
  bp.approve_end_date(sp.record(project_id=3, end_date=end_date), _sender=admin)
  scenario.verify(bp.data.projects[3].end_date == sp.Some(end_date))

  # M0 due t3 + 5 days, approved a day late: still paid in full
  bp.approve_milestone(3, _sender=admin, _now=_ts(t3 + 6 * DAY))
  price(10_000_000, _ts(t3 + 6 * DAY))
  bp.claim_milestone(3, _sender=contractor, _now=_ts(t3 + 6 * DAY))
  scenario.verify(bal(contractor.address) == 4_085_000)
  scenario.verify(bal(wallet.address) == 0)

  scenario.p("End date + 7 grace = t3 + 12 days: no fee and no default up to it")
  fee_start = t3 + 12 * DAY
  bp.mark_default(3, _sender=admin, _now=_ts(fee_start), _valid=False, _exception="NOT_OVERDUE")
  price(10_000_000, _ts(fee_start))
  bp.repay(sp.record(project_id=3, usd_cents=5_000), _sender=contractor, _now=_ts(fee_start))
  scenario.verify(bp.data.projects[3].late_fee_usd == 0)
  scenario.verify(bal(contractor.address) == 4_035_000)

  scenario.p("A pending proposal does not stop the fee: the approved date stays in force")
  later = _ts(t3 + 30 * DAY)
  bp.propose_end_date(sp.record(project_id=3, end_date=later), _sender=contractor)
  bp.reject_end_date(3, _sender=carol, _valid=False, _exception="NOT_ADMIN")

  scenario.p("1 second past grace: all 7 grace days + 1 count from the end date = 8 days at 1%: 880 cents")
  bp.repay(sp.record(project_id=3, usd_cents=1), _sender=contractor, _now=_ts(fee_start + 1))
  scenario.verify(bp.data.projects[3].late_fee_usd == 880)

  scenario.p("Past grace, days count from the end date: 9 days + 1 second = 10 days at 1%: 1,100 cents on 11,000")
  late3 = _ts(fee_start + 2 * DAY + 1)
  price(10_000_000, late3)
  bp.repay(sp.record(project_id=3, usd_cents=100_000), _sender=contractor, _now=late3)
  p3 = bp.data.projects[3]
  scenario.verify(p3.status == sp.variant.Repaid(sp.unit))
  scenario.verify(p3.end_date == sp.Some(end_date))
  scenario.verify(p3.late_fee_usd == 1_100)
  scenario.verify(p3.repaid_usd == 12_100)
  scenario.verify(p3.repaid_bro == 121_000)
  scenario.verify(bal(contractor.address) == 3_964_000)
  # investors get deposit + interest (110,000); the 11,000 BRO fee is surplus
  scenario.verify(p3.settled_pool_bro == 110_000)
  scenario.verify(bal(wallet.address) == 11_000)
  scenario.verify(bp.get_amount_due(3) == 0)
  bp.approve_end_date(sp.record(project_id=3, end_date=later), _sender=admin, _valid=False, _exception="NOT_OPEN")
  bp.propose_end_date(sp.record(project_id=3, end_date=later), _sender=contractor, _valid=False, _exception="NOT_OPEN")
  bp.reject_end_date(3, _sender=admin)
  scenario.verify(bp.data.projects[3].proposed_end_date.is_none())
  bp.claim_payout(3, _sender=alice, _now=late3)
  scenario.verify(bal(alice.address) == 5_068_000)
  scenario.verify(bal(bp.address) == 0)
  scenario.verify(total() == 25_000_000)

  scenario.p("The fee is capped at 100% of budget + interest")
  t4 = 60 * DAY
  bf.submit_project(
    _project(_ts(t4 + 10 * DAY), 10_000, 1000, 6, [(10000, 5)]),
    _sender=contractor,
    _now=_ts(t4),
  )
  price(10_000_000, _ts(t4))
  bf.invest(sp.record(project_id=4, max_bro=1_000_000), _sender=bob, _now=_ts(t4))
  bp.approve_milestone(4, _sender=admin, _now=_ts(t4 + DAY))
  price(10_000_000, _ts(t4 + DAY))
  bp.claim_milestone(4, _sender=contractor, _now=_ts(t4 + DAY))
  bp.propose_end_date(sp.record(project_id=4, end_date=_ts(t4 + 5 * DAY)), _sender=contractor)
  bp.approve_end_date(sp.record(project_id=4, end_date=_ts(t4 + 5 * DAY)), _sender=admin)
  # 157 days after the end date the fee would be 157% without the cap
  late4 = _ts(t4 + 162 * DAY)
  price(10_000_000, late4)
  bp.repay(sp.record(project_id=4, usd_cents=1_000_000), _sender=contractor, _now=late4)
  p4 = bp.data.projects[4]
  scenario.verify(p4.late_fee_usd == 11_000)
  scenario.verify(p4.repaid_usd == 22_000)
  scenario.verify(p4.status == sp.variant.Repaid(sp.unit))
  bp.claim_payout(4, _sender=bob, _now=late4)
  scenario.verify(bal(bp.address) == 0)
  scenario.verify(total() == 25_000_000)

  # ----------------------------------------------------------------------
  scenario.h2("Admin settings and pause")
  bp.set_grace_days(14, _sender=carol, _valid=False, _exception="NOT_ADMIN")
  bp.set_grace_days(14, _sender=admin)
  scenario.verify(bp.data.grace_days == 14)
  bp.set_market(carol.address, _sender=carol, _valid=False, _exception="NOT_ADMIN")
  bp.set_admin(carol.address, _sender=carol, _valid=False, _exception="NOT_ADMIN")
  bp.pause(True, _sender=carol, _valid=False, _exception="NOT_ADMIN")
  bp.pause(True, _sender=admin)
  bp.claim_payout(0, _sender=alice, _now=_ts(50 * DAY), _valid=False, _exception="PAUSED")
  bp.pause(False, _sender=admin)
