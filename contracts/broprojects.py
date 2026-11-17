"""BROProjects: runs funded BRO Builder projects, from draws to
settlement.

Contractors deal only in dollars (cents); BRO moves the value at the
oracle price on the day of each payment, and the funding wallet keeps any
surplus or covers any shortfall.

- BROFunding launches a project here once it is fully funded, sending its
  BRO and financial terms (same project id). The BRO is split into
  per-milestone escrow and the first milestone falls due.
- Milestones are approved in order by the admin or any holder of the
  configured NFT. Claiming approved milestones is a draw: the contractor
  receives BRO worth their USD amount, minus the interest hold.
- Interest hold: budget x monthly rate x `term_months`, withheld from the
  first draws (all of a draw until the hold is complete) and kept as BRO
  at that day's price.
- Interest: monthly rate / 30 per day, only on drawn cents still
  outstanding, from the day of each draw until repaid (a partial day
  counts in full). Every 30 days from launch, anyone can call
  `pay_interest` to pay the interest earned up to that mark out of the
  hold: the project's `builder_share_bps` (saved at submission) to the
  funding wallet, the rest to investors. Draws and repayments do this
  first, so a mark's interest always uses the balances as they stood.
- End date: launch proposes the listing's `est_completion`; the
  contractor may propose other dates later. A date counts only once the
  admin approves it; it ends the contract period. No draws after it, and
  anyone can then `release_undrawn` to hand the undrawn escrow back to
  investors (in BRO, as deposited).
- Repayment, in installments, any time: each one pays the late fee first,
  then interest above the hold, then principal (oldest draws first, which
  stops their interest). The unused hold comes off the debt, so the total
  repaid is drawn + interest - hold. Late fee: once the approved end
  date + grace has passed, every day since the end date costs
  `late_fee_bps_per_day` of what each installment pays, capped at 100%; it
  goes to the funding wallet.
- Settlement on full repayment or default: the undrawn escrow goes back
  to investors, then investors are owed their deposited BRO plus (on
  default) their share of the unpaid interest. The wallet takes the
  excess or covers the gap as far as its balance allows.
- Investors claim their share of everything allotted to them so far at
  any time, in proportion to their deposit on BROFunding.
- `flows` (per project and in total) tracks what went to the funding
  wallet (builder fee, late fee, price surplus) and what it covered.
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

  def interest(params):
    """Interest in cents up to `to`: cent-days already closed by
    repayments, plus each draw's outstanding cents times the days (rounded
    up) since it was drawn, at monthly rate / 30 per day, rounded down."""
    sp.cast(
      params,
      sp.record(
        milestones=sp.map[sp.nat, t.milestone],
        closed=sp.nat,
        rate=sp.nat,
        to=sp.timestamp,
      ),
    )
    usd_days = params.closed
    for ms in params.milestones.values():
      if ms.drawn_at.is_some():
        drawn = ms.drawn_at.unwrap_some()
        if params.to > drawn:
          days = (sp.as_nat(params.to - drawn) + 86399) / 86400
          usd_days += ms.outstanding_usd * days
    return usd_days * params.rate / 300000

  def late_bps(params):
    """Late fee rate in bps of what is paid: none until the approved end
    date + grace has passed; then every day (rounded up) since the end
    date itself, grace days included, capped at 100%."""
    sp.cast(
      params,
      sp.record(
        end_date=sp.option[sp.timestamp],
        grace_days=sp.nat,
        bps_per_day=sp.nat,
        now=sp.timestamp,
      ),
    )
    rate = 0
    if params.end_date.is_some():
      end = params.end_date.unwrap_some()
      grace_end = sp.add_seconds(end, sp.to_int(params.grace_days) * 86400)
      if params.now > grace_end:
        late_days = (sp.as_nat(params.now - end) + 86399) / 86400
        rate = min(10000, late_days * params.bps_per_day)
    return rate

  def owed(params):
    """What the contractor owes now, before the late fee: outstanding
    principal + interest - hold - interest already paid above the hold
    (never below 0). `interest` is the part of it that is interest above
    the hold; `fee_bps` the late fee rate on whatever is paid now."""
    sp.cast(params, sp.record(p=t.project, grace_days=sp.nat, now=sp.timestamp))
    p = params.p
    i = interest(
      sp.record(
        milestones=p.milestones,
        closed=p.closed_usd_days,
        rate=p.monthly_rate_bps,
        to=params.now,
      )
    )
    principal = 0
    for ms in p.milestones.values():
      principal += ms.outstanding_usd
    extra = sp.to_int(i) - sp.to_int(p.hold_usd + p.interest_paid_usd)
    base = 0
    if sp.to_int(principal) + extra > 0:
      base = sp.as_nat(sp.to_int(principal) + extra)
    beyond = 0
    if extra > 0:
      beyond = sp.as_nat(extra)
    return sp.record(
      base=base,
      interest=beyond,
      fee_bps=late_bps(
        sp.record(
          end_date=p.end_date,
          grace_days=params.grace_days,
          bps_per_day=p.late_fee_bps_per_day,
          now=params.now,
        )
      ),
    )

  def add_flows(params):
    (a, b) = params
    sp.cast(a, t.flows)
    sp.cast(b, t.flows)
    return sp.record(
      builder_fee_bro=a.builder_fee_bro + b.builder_fee_bro,
      late_fee_bro=a.late_fee_bro + b.late_fee_bro,
      surplus_bro=a.surplus_bro + b.surplus_bro,
      covered_bro=a.covered_bro + b.covered_bro,
    )

  class BROProjects(sp.Contract):
    """Draws, interest, repayment and settlement of funded projects, in
    BRO."""

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
      # BRO each investor has claimed so far, per project
      self.data.payouts_claimed = sp.cast(
        sp.big_map(), sp.big_map[sp.pair[sp.nat, sp.address], sp.nat]
      )
      # totals of every project's `flows`
      self.data.flows = sp.cast(
        sp.record(builder_fee_bro=0, late_fee_bro=0, surplus_bro=0, covered_bro=0),
        t.flows,
      )

    @sp.private(with_storage="read-only", with_operations=True)
    def pay_(self, params):
      """Move BRO, in this order: `cover` from the funding wallet into this
      contract (via the market assistant), then one FA2 batch: `pull` from
      the sender, `out` to `to_`, `wallet` to the funding wallet. `wallet`
      and `cover` are netted against each other first. Zero amounts are
      skipped."""
      sp.cast(
        params,
        sp.record(
          pull=sp.nat, to_=sp.address, out=sp.nat, wallet=sp.nat, cover=sp.nat
        ),
      )
      cover = params.cover
      wallet = params.wallet
      if cover > wallet:
        cover = sp.as_nat(cover - wallet)
        wallet = 0
      else:
        wallet = sp.as_nat(wallet - cover)
        cover = 0
      if cover > 0:
        market = sp.contract(
          t.cover_params, self.data.market, "cover"
        ).unwrap_some(error="MARKET_COVER_NOT_FOUND")
        sp.transfer(
          sp.record(to_=sp.self_address, amount=cover), sp.mutez(0), market
        )
      outs = sp.cast([], list[t.tx])
      if wallet > 0:
        wallet_address = sp.view(
          "get_funding_wallet", self.data.market, (), sp.address
        ).unwrap_some(error="MARKET_VIEW_UNAVAILABLE")
        outs.push(
          sp.record(to_=wallet_address, token_id=self.data.token_id, amount=wallet)
        )
      if params.out > 0:
        outs.push(
          sp.record(to_=params.to_, token_id=self.data.token_id, amount=params.out)
        )
      batches = sp.cast([], t.transfer_params)
      if sp.len(outs) > 0:
        batches.push(sp.record(from_=sp.self_address, txs=outs))
      # pushed last so it runs first: the pulled BRO can fund the outs
      if params.pull > 0:
        batches.push(
          sp.record(
            from_=sp.sender,
            txs=[
              sp.record(
                to_=sp.self_address,
                token_id=self.data.token_id,
                amount=params.pull,
              )
            ],
          )
        )
      if sp.len(batches) > 0:
        token = sp.contract(
          t.transfer_params, self.data.token_address, "transfer"
        ).unwrap_some(error="FA2_CONTRACT_NOT_FOUND")
        sp.transfer(batches, sp.mutez(0), token)

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
    def accrue_(self, params):
      """Pay interest out of the hold, up to the latest 30-day mark since
      launch (or up to now when `final`), at `price`. Capped at the hold
      withheld so far; interest above it is paid by the contractor. The
      builder share goes to the wallet and the rest is allotted to
      investors. When the hold BRO is short (BRO fell), investors are paid
      first and the wallet covers their gap; when `final`, that gap is
      returned as `short` for `settle_` to cover as far as the wallet
      allows. Returns the BRO to send to / cover from the wallet, and the
      cents paid."""
      sp.cast(params, sp.record(project_id=sp.nat, price=sp.nat, final=sp.bool))
      p = self.data.projects[params.project_id]
      to = sp.now
      if not params.final:
        periods = sp.as_nat(sp.now - p.funded_at) / 2592000
        to = sp.add_seconds(p.funded_at, sp.to_int(periods * 2592000))
      wallet = 0
      cover = 0
      short = 0
      usd = 0
      # a mark is paid once: balances changed after it belong to the next
      if params.final or to > p.paid_until:
        p.paid_until = to
        target = min(
          interest(
            sp.record(
              milestones=p.milestones,
              closed=p.closed_usd_days,
              rate=p.monthly_rate_bps,
              to=to,
            )
          ),
          p.hold_usd,
        )
        if target > p.hold_used_usd:
          usd = sp.as_nat(target - p.hold_used_usd)
          p.hold_used_usd = target
          bro = units.usd_to_bro((usd, params.price))
          builder = bro * p.builder_share_bps / 10000
          inv = sp.as_nat(bro - builder)
          take = min(p.hold_bro, bro)
          p.hold_bro = sp.as_nat(p.hold_bro - take)
          inv_from_hold = min(take, inv)
          wallet = sp.as_nat(take - inv_from_hold)
          cover = sp.as_nat(inv - inv_from_hold)
          if params.final:
            short = cover
            cover = 0
          p.investor_bro += sp.as_nat(inv - short)
          d = sp.record(
            builder_fee_bro=wallet, late_fee_bro=0, surplus_bro=0, covered_bro=cover
          )
          p.flows = add_flows((p.flows, d))
          self.data.flows = add_flows((self.data.flows, d))
      self.data.projects[params.project_id] = p
      return sp.record(wallet=wallet, cover=cover, short=short, usd=usd)

    @sp.private(with_storage="read-write")
    def release_(self, project_id):
      """Allot the escrow of undrawn milestones back to investors (once).
      No more draws afterwards."""
      sp.cast(project_id, sp.nat)
      p = self.data.projects[project_id]
      if not p.released:
        p.released = True
        for ms in p.milestones.values():
          if ms.drawn_at.is_none():
            p.investor_bro += ms.escrow_bro
        if p.status.is_variant.Active():
          p.status = sp.variant.Repaying()
        self.data.projects[project_id] = p

    @sp.private(with_storage="read-write")
    def settle_(self, params):
      """Close a project (after `accrue_` final and `release_`): investors
      are owed the BRO deposited for the drawn milestones, the last hold
      payout the hold BRO could not fund (`short`), and on default their
      share of the unpaid interest above the hold (`unpaid_usd`). They get
      the repaid principal BRO and what is left of the hold BRO, trimmed to
      that (the excess goes to the wallet) or topped up by the wallet as
      far as its balance, less the `committed` covers of the same call,
      allows. Returns the BRO to send to / cover from the wallet."""
      sp.cast(
        params,
        sp.record(
          project_id=sp.nat,
          price=sp.nat,
          unpaid_usd=sp.nat,
          short=sp.nat,
          committed=sp.nat,
          defaulted=sp.bool,
        ),
      )
      p = self.data.projects[params.project_id]
      target = params.short
      for ms in p.milestones.values():
        if ms.drawn_at.is_some():
          target += ms.escrow_bro
      unpaid = units.usd_to_bro((params.unpaid_usd, params.price))
      target += sp.as_nat(unpaid - unpaid * p.builder_share_bps / 10000)
      pool = p.repaid_bro + p.hold_bro
      p.repaid_bro = 0
      p.hold_bro = 0
      wallet = 0
      cover = 0
      if pool > target:
        wallet = sp.as_nat(pool - target)
        p.investor_bro += target
      else:
        shortfall = sp.as_nat(target - pool)
        wallet_address = sp.view(
          "get_funding_wallet", self.data.market, (), sp.address
        ).unwrap_some(error="MARKET_VIEW_UNAVAILABLE")
        balance = units.token_balance(
          sp.record(
            token=self.data.token_address,
            owner=wallet_address,
            token_id=self.data.token_id,
          )
        )
        available = 0
        if balance > params.committed:
          available = sp.as_nat(balance - params.committed)
        cover = min(shortfall, available)
        p.uncovered_bro = sp.as_nat(shortfall - cover)
        p.investor_bro += pool + cover
      d = sp.record(
        builder_fee_bro=0, late_fee_bro=0, surplus_bro=wallet, covered_bro=cover
      )
      p.flows = add_flows((p.flows, d))
      self.data.flows = add_flows((self.data.flows, d))
      if params.defaulted:
        p.status = sp.variant.Defaulted()
      else:
        p.status = sp.variant.Repaid()
      self.data.projects[params.project_id] = p
      return sp.record(wallet=wallet, cover=cover)

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
      """Admin-only switch. When paused, claim_milestone, pay_interest,
      repay and claim_payout are disabled."""
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
          drawn_at=None,
          outstanding_usd=0,
        )

      self.data.projects[params.project_id] = sp.record(
        contractor=params.contractor,
        budget_usd=params.budget_usd,
        monthly_rate_bps=params.monthly_rate_bps,
        term_months=params.term_months,
        late_fee_bps_per_day=params.late_fee_bps_per_day,
        builder_share_bps=params.builder_share_bps,
        funded_bro=params.funded_bro,
        funded_at=sp.now,
        end_date=None,
        proposed_end_date=sp.Some(params.est_completion),
        milestones=milestones,
        current_milestone=0,
        hold_usd=0,
        hold_bro=0,
        hold_used_usd=0,
        paid_until=sp.now,
        closed_usd_days=0,
        interest_paid_usd=0,
        repaid_usd=0,
        repaid_bro=0,
        late_fee_usd=0,
        released=False,
        investor_bro=0,
        uncovered_bro=0,
        default_due_usd=0,
        flows=sp.record(
          builder_fee_bro=0, late_fee_bro=0, surplus_bro=0, covered_bro=0
        ),
        status=sp.variant.Active(),
      )

    # ------------------------------------------------------------------
    # Contractor
    # ------------------------------------------------------------------
    @sp.entrypoint
    def claim_milestone(self, project_id):
      """Draw every approved, undrawn milestone: BRO worth their USD amount
      at today's price, minus what is still missing from the interest hold
      (kept here as BRO). Interest on them starts now. Surplus escrow goes
      to the funding wallet; a shortfall is covered from it via the market
      assistant (the draw fails if the wallet is short or has not approved
      the market as FA2 operator). Closed after the approved end date."""
      sp.cast(project_id, sp.nat)
      assert not self.data.paused, "PAUSED"
      p = self.data.projects.get(project_id, error="PROJECT_NOT_FOUND")
      assert sp.sender == p.contractor, "NOT_CONTRACTOR"
      # Active also means the undrawn escrow has not been released
      assert p.status.is_variant.Active(), "NOT_ACTIVE"
      if p.end_date.is_some():
        assert sp.now <= p.end_date.unwrap_some(), "PERIOD_ENDED"
      price = units.market_price(self.data.market)
      # pay the marks passed so far before the balances change
      paid = self.accrue_(
        sp.record(project_id=project_id, price=price, final=False)
      )
      p = self.data.projects[project_id]

      need_usd = 0
      escrow = 0
      count = 0
      for i in range(0, p.current_milestone):
        if p.milestones[i].drawn_at.is_none():
          need_usd += p.milestones[i].usd
          escrow += p.milestones[i].escrow_bro
          p.milestones[i].drawn_at = sp.Some(sp.now)
          p.milestones[i].outstanding_usd = p.milestones[i].usd
          count += 1
      assert count > 0, "NOTHING_TO_CLAIM"

      hold_target = p.budget_usd * p.monthly_rate_bps * p.term_months / 10000
      withheld = min(need_usd, sp.as_nat(hold_target - p.hold_usd))
      p.hold_usd += withheld
      out = units.usd_to_bro((sp.as_nat(need_usd - withheld), price))
      kept = units.usd_to_bro((withheld, price))
      p.hold_bro += kept
      need = out + kept
      surplus = 0
      shortfall = 0
      if escrow >= need:
        surplus = sp.as_nat(escrow - need)
      else:
        shortfall = sp.as_nat(need - escrow)
      d = sp.record(
        builder_fee_bro=0, late_fee_bro=0, surplus_bro=surplus, covered_bro=shortfall
      )
      p.flows = add_flows((p.flows, d))
      self.data.flows = add_flows((self.data.flows, d))
      if p.current_milestone == sp.len(p.milestones):
        p.status = sp.variant.Repaying()
      self.data.projects[project_id] = p

      self.pay_(
        sp.record(
          pull=0,
          to_=p.contractor,
          out=out,
          wallet=paid.wallet + surplus,
          cover=paid.cover + shortfall,
        )
      )

    @sp.entrypoint
    def repay(self, params):
      """Pay an installment, in USD cents, converted at today's price (each
      part rounded up). It pays the late fee on what it pays, then interest
      above the hold, then principal (oldest draws first). Anyone may pay;
      the sender must have made this contract an operator for their BRO.
      Paying everything owed (drawn + interest - hold) settles the project;
      while undrawn milestones remain and the period is open, only the
      contractor may do that."""
      sp.cast(params, sp.record(project_id=sp.nat, usd_cents=sp.nat))
      assert not self.data.paused, "PAUSED"
      p = self.data.projects.get(params.project_id, error="PROJECT_NOT_FOUND")
      assert p.status.is_variant.Active() or p.status.is_variant.Repaying(), "NOT_OPEN"
      price = units.market_price(self.data.market)
      paid = self.accrue_(
        sp.record(project_id=params.project_id, price=price, final=False)
      )
      p = self.data.projects[params.project_id]

      debt = owed(sp.record(p=p, grace_days=self.data.grace_days, now=sp.now))
      due = debt.base + debt.base * debt.fee_bps / 10000
      usd = min(params.usd_cents, due)
      assert usd > 0 or due == 0, "AMOUNT_TOO_SMALL"
      base = debt.base
      if usd < due:
        base = usd * 10000 / (10000 + debt.fee_bps)
      fee = sp.as_nat(usd - base)
      interest_part = min(base, debt.interest)
      principal = sp.as_nat(base - interest_part)

      # principal stops earning interest, oldest draws first
      left = principal
      for i in range(0, sp.len(p.milestones)):
        take = min(left, p.milestones[i].outstanding_usd)
        if take > 0:
          drawn = p.milestones[i].drawn_at.unwrap_some()
          days = (sp.as_nat(sp.now - drawn) + 86399) / 86400
          p.closed_usd_days += take * days
          p.milestones[i].outstanding_usd = sp.as_nat(
            p.milestones[i].outstanding_usd - take
          )
          left = sp.as_nat(left - take)

      fee_bro = units.usd_to_bro_up((fee, price))
      interest_bro = units.usd_to_bro_up((interest_part, price))
      principal_bro = units.usd_to_bro_up((principal, price))
      builder = interest_bro * p.builder_share_bps / 10000
      p.investor_bro += sp.as_nat(interest_bro - builder)
      p.repaid_bro += principal_bro
      p.interest_paid_usd += interest_part
      p.late_fee_usd += fee
      p.repaid_usd += usd
      d = sp.record(
        builder_fee_bro=builder, late_fee_bro=fee_bro, surplus_bro=0, covered_bro=0
      )
      p.flows = add_flows((p.flows, d))
      self.data.flows = add_flows((self.data.flows, d))

      done = usd == due
      if done and not p.released:
        undrawn = False
        for ms in p.milestones.values():
          undrawn = undrawn or ms.drawn_at.is_none()
        period_open = True
        if p.end_date.is_some():
          period_open = sp.now <= p.end_date.unwrap_some()
        if undrawn and period_open:
          assert sp.sender == p.contractor, "NOT_CONTRACTOR"
      self.data.projects[params.project_id] = p

      wallet = paid.wallet + fee_bro + builder
      cover = paid.cover
      if done:
        last = self.accrue_(
          sp.record(project_id=params.project_id, price=price, final=True)
        )
        self.release_(params.project_id)
        settled = self.settle_(
          sp.record(
            project_id=params.project_id,
            price=price,
            unpaid_usd=0,
            short=last.short,
            committed=cover,
            defaulted=False,
          )
        )
        wallet += last.wallet + settled.wallet
        cover += last.cover + settled.cover
      self.pay_(
        sp.record(
          pull=fee_bro + interest_bro + principal_bro,
          to_=sp.sender,
          out=0,
          wallet=wallet,
          cover=cover,
        )
      )

    # ------------------------------------------------------------------
    # Anyone
    # ------------------------------------------------------------------
    @sp.entrypoint
    def pay_interest(self, project_id):
      """Pay the interest earned up to the latest 30-day mark since launch
      out of the hold, at today's price: the builder share to the funding
      wallet, the rest allotted to investors (claimed with
      `claim_payout`)."""
      sp.cast(project_id, sp.nat)
      assert not self.data.paused, "PAUSED"
      p = self.data.projects.get(project_id, error="PROJECT_NOT_FOUND")
      assert p.status.is_variant.Active() or p.status.is_variant.Repaying(), "NOT_OPEN"
      paid = self.accrue_(
        sp.record(
          project_id=project_id,
          price=units.market_price(self.data.market),
          final=False,
        )
      )
      assert paid.usd > 0, "NOTHING_TO_PAY"
      self.pay_(
        sp.record(
          pull=0, to_=sp.sender, out=0, wallet=paid.wallet, cover=paid.cover
        )
      )

    @sp.entrypoint
    def release_undrawn(self, project_id):
      """After the approved end date, hand the escrow of undrawn
      milestones back to investors (claimed with `claim_payout`)."""
      sp.cast(project_id, sp.nat)
      p = self.data.projects.get(project_id, error="PROJECT_NOT_FOUND")
      assert p.status.is_variant.Active() or p.status.is_variant.Repaying(), "NOT_OPEN"
      assert not p.released, "ALREADY_RELEASED"
      end = p.end_date.unwrap_some(error="PERIOD_OPEN")
      assert sp.now > end, "PERIOD_OPEN"
      self.release_(project_id)

    # ------------------------------------------------------------------
    # Investor
    # ------------------------------------------------------------------
    @sp.entrypoint
    def claim_payout(self, project_id):
      """Pay the sender their share of everything allotted to investors so
      far (interest, undrawn escrow, settlement), in proportion to their
      BRO deposit on BROFunding, minus what they already claimed."""
      sp.cast(project_id, sp.nat)
      assert not self.data.paused, "PAUSED"
      p = self.data.projects.get(project_id, error="PROJECT_NOT_FOUND")
      inv = sp.view(
        "get_investment",
        self.data.funding,
        sp.record(project_id=project_id, investor=sp.sender),
        t.investment,
      ).unwrap_some(error="FUNDING_VIEW_UNAVAILABLE")
      assert inv.bro > 0, "INVESTMENT_NOT_FOUND"
      key = (project_id, sp.sender)
      claimed = self.data.payouts_claimed.get(key, default=0)
      share = p.investor_bro * inv.bro / p.funded_bro
      assert share > claimed, "NOTHING_TO_CLAIM"
      self.data.payouts_claimed[key] = share
      self.pay_(
        sp.record(
          pull=0, to_=sp.sender, out=sp.as_nat(share - claimed), wallet=0, cover=0
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
      approved end date only the milestone rule applies. Needs a fresh
      price: the hold pays the interest earned so far, the undrawn escrow
      goes back to investors, and the wallet tops investors up to their
      deposit plus their share of the unpaid interest as far as it can.
      What is owed (with the late fee) is recorded but not collected."""
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

      price = units.market_price(self.data.market)
      debt = owed(sp.record(p=p, grace_days=self.data.grace_days, now=sp.now))
      p.default_due_usd = debt.base + debt.base * debt.fee_bps / 10000
      self.data.projects[project_id] = p
      last = self.accrue_(
        sp.record(project_id=project_id, price=price, final=True)
      )
      self.release_(project_id)
      settled = self.settle_(
        sp.record(
          project_id=project_id,
          price=price,
          unpaid_usd=debt.interest,
          short=last.short,
          committed=0,
          defaulted=True,
        )
      )
      self.pay_(
        sp.record(
          pull=0,
          to_=sp.sender,
          out=0,
          wallet=last.wallet + settled.wallet,
          cover=last.cover + settled.cover,
        )
      )

    # ------------------------------------------------------------------
    # Views
    # ------------------------------------------------------------------
    @sp.onchain_view()
    def get_project(self, project_id):
      sp.cast(project_id, sp.nat)
      return self.data.projects.get(project_id, error="PROJECT_NOT_FOUND")

    @sp.onchain_view()
    def get_amount_due(self, project_id):
      """Cents to pay now to settle: drawn + interest - hold - repaid,
      plus the late fee on it. 0 once repaid; what was owed at default
      once defaulted."""
      sp.cast(project_id, sp.nat)
      p = self.data.projects.get(project_id, error="PROJECT_NOT_FOUND")
      due = p.default_due_usd
      if p.status.is_variant.Active() or p.status.is_variant.Repaying():
        debt = owed(sp.record(p=p, grace_days=self.data.grace_days, now=sp.now))
        due = debt.base + debt.base * debt.fee_bps / 10000
      return due


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
  scenario.h1("BRO Projects: draws, daily interest, hold, repayment, settlement")

  token = helpers.DummyFA2(admin.address)
  scenario += token
  # stands in for the approver NFT: only `get_balance_of` matters
  nft = helpers.DummyFA2(admin.address)
  scenario += nft
  for a, amount in [
    (admin, 100_000_000), (contractor, 50_000_000), (alice, 50_000_000), (bob, 50_000_000)
  ]:
    token.mint(to_=a.address, amount=amount, _sender=admin)
  nft.mint(to_=approver.address, amount=1, _sender=admin)
  TOTAL = 250_000_000

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
    builder_share_bps=3000,
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
    grace_days=3,
  )
  scenario += bp
  bf.set_projects(bp.address, _sender=admin)
  ma.set_ledger(bp.address, _sender=admin)

  def approve(owner, operator):
    """Make `operator` an FA2 operator of the owner's BRO."""
    token.update_operators(
      [sp.variant.add_operator(
        sp.record(owner=owner.address, operator=operator.address, token_id=0)
      )],
      _sender=owner,
    )

  # the funding wallet lets the market assistant pull BRO for `cover`
  approve(wallet, ma)
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
      + bal(carol.address)
      + bal(wallet.address)
      + bal(bf.address)
      + bal(bp.address)
    )

  def send(sender, to, amount):
    token.transfer(
      [sp.record(from_=sender.address, txs=[sp.record(to_=to.address, token_id=0, amount=amount)])],
      _sender=sender,
    )

  send(admin, wallet, 20_000_000)
  scenario.verify(total() == TOTAL)

  # 10 BRO units per cent; $10,000 budget = 1,000,000 cents = 10,000,000 BRO
  P = 10_000_000

  def fund(pid, start, milestones, budget=1_000_000, rate=400, term=2):
    """List a project and fund it 60% Alice / 40% Bob at price P."""
    bf.submit_project(
      _project(_ts(start + 10 * DAY), budget, rate, term, milestones),
      _sender=contractor,
      _now=_ts(start),
    )
    price(P, _ts(start))
    bro = budget * 10
    bf.invest(sp.record(project_id=pid, max_bro=bro * 6 // 10), _sender=alice, _now=_ts(start))
    bf.invest(sp.record(project_id=pid, max_bro=bro), _sender=bob, _now=_ts(start))
    scenario.verify(bp.data.projects[pid].funded_bro == bro)

  def set_end(pid, end, now):
    bp.propose_end_date(sp.record(project_id=pid, end_date=end), _sender=contractor, _now=now)
    bp.approve_end_date(sp.record(project_id=pid, end_date=end), _sender=admin, _now=now)

  def flows(pid):
    return bp.data.projects[pid].flows

  bp.launch(
    sp.record(
      project_id=99, contractor=carol.address, budget_usd=1, monthly_rate_bps=400,
      term_months=1, late_fee_bps_per_day=0, builder_share_bps=3000, funded_bro=1,
      est_completion=_ts(0), milestones=[sp.record(pct_bps=10000, duration_days=1, usd=1)],
    ),
    _sender=carol,
    _valid=False,
    _exception="NOT_FUNDING_CONTRACT",
  )

  # ----------------------------------------------------------------------
  scenario.h2("Case A: $4,000 on day 0, $6,000 on day 30, repaid on day 60")
  L = 0
  fund(0, L, [(4000, 10), (6000, 40)])
  p0 = bp.data.projects[0]
  scenario.verify(p0.status == sp.variant.Active(sp.unit))
  scenario.verify(p0.builder_share_bps == 3000)
  scenario.verify(p0.paid_until == _ts(L))
  scenario.verify(p0.milestones[0].escrow_bro == 4_000_000)
  scenario.verify(p0.milestones[1].escrow_bro == 6_000_000)
  scenario.verify(bal(bp.address) == 10_000_000)

  scenario.p("Approvers: admin and NFT holders only")
  bp.approve_milestone(0, _sender=approver, _now=_ts(L), _valid=False, _exception="NOT_APPROVER")
  bp.set_nft(sp.Some(sp.record(address=nft.address, token_id=0)), _sender=carol, _valid=False, _exception="NOT_ADMIN")
  bp.set_nft(sp.Some(sp.record(address=nft.address, token_id=0)), _sender=admin)
  bp.approve_milestone(0, _sender=carol, _now=_ts(L), _valid=False, _exception="NOT_APPROVER")
  bp.claim_milestone(0, _sender=contractor, _now=_ts(L), _valid=False, _exception="NOTHING_TO_CLAIM")
  bp.pay_interest(0, _sender=carol, _now=_ts(L), _valid=False, _exception="NOTHING_TO_PAY")

  scenario.p("Day 0: draw $4,000; the $800 hold (budget x 4% x 2 months) is kept, $3,200 paid")
  bp.approve_milestone(0, _sender=approver, _now=_ts(L))
  bp.claim_milestone(0, _sender=carol, _now=_ts(L), _valid=False, _exception="NOT_CONTRACTOR")
  bp.claim_milestone(0, _sender=contractor, _now=_ts(L))
  p0 = bp.data.projects[0]
  scenario.verify(p0.hold_usd == 80_000)
  scenario.verify(p0.hold_bro == 800_000)
  scenario.verify(p0.milestones[0].drawn_at == sp.Some(_ts(L)))
  scenario.verify(p0.milestones[0].outstanding_usd == 400_000)
  scenario.verify(bal(contractor.address) == 53_200_000)
  scenario.verify(bal(bp.address) == 6_800_000)
  scenario.verify(bp.get_amount_due(0) == 320_000)
  set_end(0, _ts(L + 60 * DAY), _ts(L))

  scenario.p("Before day 30 nothing is due; day 30 pays $160: $112 to investors, $48 to the wallet")
  price(P, _ts(L + 30 * DAY - 1))
  bp.pay_interest(0, _sender=carol, _now=_ts(L + 30 * DAY - 1), _valid=False, _exception="NOTHING_TO_PAY")
  price(P, _ts(L + 30 * DAY))
  bp.pay_interest(0, _sender=carol, _now=_ts(L + 30 * DAY))
  p0 = bp.data.projects[0]
  scenario.verify(p0.hold_used_usd == 16_000)
  scenario.verify(p0.paid_until == _ts(L + 30 * DAY))
  scenario.verify(p0.investor_bro == 112_000)
  scenario.verify(p0.hold_bro == 640_000)
  scenario.verify(p0.flows.builder_fee_bro == 48_000)
  scenario.verify(bal(wallet.address) == 20_048_000)
  bp.pay_interest(0, _sender=carol, _now=_ts(L + 30 * DAY), _valid=False, _exception="NOTHING_TO_PAY")

  scenario.p("Investors claim as they go")
  bp.claim_payout(0, _sender=alice, _now=_ts(L + 30 * DAY))
  scenario.verify(bal(alice.address) == 44_000_000 + 67_200)
  bp.claim_payout(0, _sender=alice, _now=_ts(L + 30 * DAY), _valid=False, _exception="NOTHING_TO_CLAIM")
  bp.claim_payout(0, _sender=carol, _now=_ts(L + 30 * DAY), _valid=False, _exception="INVESTMENT_NOT_FOUND")

  scenario.p("Day 30: draw $6,000 in full (the hold is complete)")
  bp.approve_milestone(0, _sender=admin, _now=_ts(L + 30 * DAY))
  bp.claim_milestone(0, _sender=contractor, _now=_ts(L + 30 * DAY))
  scenario.verify(bal(contractor.address) == 59_200_000)
  scenario.verify(bp.data.projects[0].status == sp.variant.Repaying(sp.unit))
  bp.approve_milestone(0, _sender=admin, _now=_ts(L + 30 * DAY), _valid=False, _exception="NOT_ACTIVE")

  scenario.p("Day 60: real interest $560, so the contractor repays $10,000 + $560 - $800 = $9,760")
  approve(contractor, bp)
  price(P, _ts(L + 60 * DAY))
  scenario.verify(bp.get_amount_due(0) == 976_000)
  bp.repay(sp.record(project_id=0, usd_cents=2_000_000), _sender=contractor, _now=_ts(L + 60 * DAY))
  p0 = bp.data.projects[0]
  scenario.verify(p0.status == sp.variant.Repaid(sp.unit))
  scenario.verify(p0.repaid_usd == 976_000)
  scenario.verify(p0.hold_used_usd == 56_000)
  scenario.verify(p0.late_fee_usd == 0)
  # contractor: received $9,200, repaid $9,760: net cost = $560 of interest
  scenario.verify(bal(contractor.address) == 59_200_000 - 9_760_000)
  # investors: 10,000,000 principal + $392 (70% of $560); wallet: $168
  scenario.verify(p0.investor_bro == 10_392_000)
  scenario.verify(p0.flows.builder_fee_bro == 168_000)
  scenario.verify(p0.flows.surplus_bro == 0)
  scenario.verify(p0.flows.covered_bro == 0)
  scenario.verify(p0.uncovered_bro == 0)
  scenario.verify(bp.get_amount_due(0) == 0)
  bp.claim_payout(0, _sender=alice, _now=_ts(L + 60 * DAY))
  bp.claim_payout(0, _sender=bob, _now=_ts(L + 60 * DAY))
  scenario.verify(bal(alice.address) == 50_000_000 + 235_200)
  scenario.verify(bal(bob.address) == 50_000_000 + 156_800)
  scenario.verify(bal(bp.address) == 0)
  scenario.verify(total() == TOTAL)

  # ----------------------------------------------------------------------
  scenario.h2("Case B: $4,000 on day 0, repaid early on day 45")
  L = 100 * DAY
  fund(1, L, [(4000, 10), (6000, 40)])
  bp.approve_milestone(1, _sender=admin, _now=_ts(L))
  bp.claim_milestone(1, _sender=contractor, _now=_ts(L))
  scenario.verify(bal(contractor.address) == 49_440_000 + 3_200_000)
  price(P, _ts(L + 30 * DAY))
  bp.pay_interest(1, _sender=bob, _now=_ts(L + 30 * DAY))
  scenario.verify(bp.data.projects[1].investor_bro == 112_000)

  scenario.p("Day 45: owed $4,000 + $240 - $800 = $3,440; only the contractor may end it early")
  price(P, _ts(L + 45 * DAY))
  scenario.verify(bp.get_amount_due(1) == 344_000)
  approve(bob, bp)
  bp.repay(sp.record(project_id=1, usd_cents=344_000), _sender=bob, _now=_ts(L + 45 * DAY), _valid=False, _exception="NOT_CONTRACTOR")
  bp.repay(sp.record(project_id=1, usd_cents=344_000), _sender=contractor, _now=_ts(L + 45 * DAY))
  p1 = bp.data.projects[1]
  scenario.verify(p1.status == sp.variant.Repaid(sp.unit))
  scenario.verify(p1.released)
  # last payout $80: $56 to investors, $24 to the wallet
  scenario.verify(p1.hold_used_usd == 24_000)
  scenario.verify(p1.flows.builder_fee_bro == 72_000)
  # undrawn $6,000 + principal $4,000 + interest $168
  scenario.verify(p1.investor_bro == 10_168_000)
  scenario.verify(bal(contractor.address) == 49_440_000 + 3_200_000 - 3_440_000)
  bp.claim_payout(1, _sender=alice, _now=_ts(L + 45 * DAY))
  bp.claim_payout(1, _sender=bob, _now=_ts(L + 45 * DAY))
  # deposited 6,000,000; gets 60% of 10,168,000
  scenario.verify(bal(alice.address) == 50_235_200 - 6_000_000 + 6_100_800)
  # statement for a 10% investor: $24 earned, $7.20 fee, $16.80 interest
  scenario.verify(bal(bp.address) == 0)
  scenario.verify(total() == TOTAL)

  # ----------------------------------------------------------------------
  scenario.h2("Case C with installments: $4,000 drawn, period ends day 60, repaid on day 62")
  L = 200 * DAY
  fund(2, L, [(4000, 10), (6000, 40)])
  bp.approve_milestone(2, _sender=admin, _now=_ts(L))
  bp.claim_milestone(2, _sender=contractor, _now=_ts(L))
  set_end(2, _ts(L + 60 * DAY), _ts(L))
  price(P, _ts(L + 30 * DAY))
  bp.pay_interest(2, _sender=carol, _now=_ts(L + 30 * DAY))

  scenario.p("Day 40: $1,000 installment, all principal (interest is within the hold)")
  price(P, _ts(L + 40 * DAY))
  # interest so far 21,333 cents: owed 400,000 + 21,333 - 80,000
  scenario.verify(bp.get_amount_due(2) == 341_333)
  bp.repay(sp.record(project_id=2, usd_cents=0), _sender=contractor, _now=_ts(L + 40 * DAY), _valid=False, _exception="AMOUNT_TOO_SMALL")
  bp.repay(sp.record(project_id=2, usd_cents=100_000), _sender=contractor, _now=_ts(L + 40 * DAY))
  p2 = bp.data.projects[2]
  scenario.verify(p2.milestones[0].outstanding_usd == 300_000)
  scenario.verify(p2.closed_usd_days == 4_000_000)
  scenario.verify(p2.repaid_bro == 1_000_000)
  scenario.verify(p2.status == sp.variant.Active(sp.unit))

  scenario.p("M1 approved but not drawn by the end date: no draws, then undrawn goes back")
  bp.approve_milestone(2, _sender=admin, _now=_ts(L + 55 * DAY))
  price(P, _ts(L + 61 * DAY))
  bp.release_undrawn(2, _sender=carol, _now=_ts(L + 60 * DAY), _valid=False, _exception="PERIOD_OPEN")
  bp.claim_milestone(2, _sender=contractor, _now=_ts(L + 61 * DAY), _valid=False, _exception="PERIOD_ENDED")
  bp.release_undrawn(2, _sender=carol, _now=_ts(L + 61 * DAY))
  p2 = bp.data.projects[2]
  scenario.verify(p2.released)
  scenario.verify(p2.status == sp.variant.Repaying(sp.unit))
  # $112 interest + 6,000,000 undrawn
  scenario.verify(p2.investor_bro == 6_112_000)
  bp.release_undrawn(2, _sender=carol, _now=_ts(L + 61 * DAY), _valid=False, _exception="ALREADY_RELEASED")
  bp.claim_payout(2, _sender=bob, _now=_ts(L + 61 * DAY))
  # 50,224,000 after case B, deposited 4,000,000; 40% of 6,112,000
  scenario.verify(bal(bob.address) == 50_224_000 - 4_000_000 + 2_444_800)

  scenario.p("Day 62, within grace: no late fee; the day-60 mark is paid first")
  price(P, _ts(L + 62 * DAY))
  # 4,000,000 closed + 300,000 x 62 days = 22,600,000 cent-days: 30,133 cents
  scenario.verify(bp.get_amount_due(2) == 300_000 + 30_133 - 80_000)
  bp.repay(sp.record(project_id=2, usd_cents=500_000), _sender=contractor, _now=_ts(L + 62 * DAY))
  p2 = bp.data.projects[2]
  scenario.verify(p2.status == sp.variant.Repaid(sp.unit))
  # repaid in all: drawn + interest - hold
  scenario.verify(p2.repaid_usd == 400_000 + 30_133 - 80_000)
  scenario.verify(p2.hold_used_usd == 30_133)
  scenario.verify(p2.late_fee_usd == 0)
  scenario.verify(p2.investor_bro == 10_000_000 + 210_931)
  scenario.verify(p2.flows.builder_fee_bro == 90_399)
  bp.claim_payout(2, _sender=alice, _now=_ts(L + 62 * DAY))
  bp.claim_payout(2, _sender=bob, _now=_ts(L + 62 * DAY))
  scenario.verify(bal(bp.address) <= 1)
  scenario.verify(total() == TOTAL)

  # ----------------------------------------------------------------------
  scenario.h2("Late fee: one milestone, end date day 30, 3 grace days, 1% a day")
  L = 300 * DAY
  # $4,000 budget for 1 month: hold $160
  fund(3, L, [(10000, 10)], budget=400_000, term=1)
  bp.approve_milestone(3, _sender=admin, _now=_ts(L))
  bp.claim_milestone(3, _sender=contractor, _now=_ts(L))
  scenario.verify(bp.data.projects[3].hold_usd == 16_000)
  set_end(3, _ts(L + 30 * DAY), _ts(L))

  scenario.p("Up to the end of grace there is no fee")
  price(P, _ts(L + 33 * DAY))
  # 400,000 x 33 days: 17,600 cents of interest, 1,600 above the hold
  scenario.verify(bp.get_amount_due(3) == 401_600)
  bp.mark_default(3, _sender=admin, _now=_ts(L + 33 * DAY), _valid=False, _exception="NOT_OVERDUE")

  scenario.p("1 second later the 3 grace days + 1 count since the end date: 4% on what is paid")
  late = _ts(L + 33 * DAY + 1)
  price(P, late)
  # 34 days of interest since the draw: 18,133 cents, 2,133 above the hold
  scenario.verify(bp.get_amount_due(3) == 402_133 + 402_133 * 400 // 10000)
  scenario.p("A partial payment: 100,000 cents = 96,153 owed + 3,847 fee")
  bp.repay(sp.record(project_id=3, usd_cents=100_000), _sender=contractor, _now=late)
  p3 = bp.data.projects[3]
  scenario.verify(p3.late_fee_usd == 3_847)
  scenario.verify(p3.interest_paid_usd == 2_133)
  scenario.verify(p3.milestones[0].outstanding_usd == 400_000 - 94_020)
  scenario.verify(p3.flows.late_fee_bro == 38_470)
  # the day-30 payout ($160) plus 70% of the $21.33 paid above the hold
  scenario.verify(p3.investor_bro == 112_000 + 14_931)
  # the rest of the debt: 305,980 cents plus 4%
  scenario.verify(bp.get_amount_due(3) == 305_980 + 305_980 * 400 // 10000)
  bp.repay(sp.record(project_id=3, usd_cents=1_000_000), _sender=contractor, _now=late)
  p3 = bp.data.projects[3]
  scenario.verify(p3.status == sp.variant.Repaid(sp.unit))
  scenario.verify(p3.late_fee_usd == 3_847 + 12_239)
  scenario.verify(p3.repaid_usd == 402_133 + 3_847 + 12_239)
  scenario.verify(p3.flows.late_fee_bro == 160_860)
  bp.claim_payout(3, _sender=alice, _now=late)
  bp.claim_payout(3, _sender=bob, _now=late)
  scenario.verify(bal(bp.address) <= 2)
  scenario.verify(total() == TOTAL)

  scenario.p("The late fee is capped at 100%")
  L = 400 * DAY
  fund(4, L, [(10000, 10)], budget=400_000, term=1)
  bp.approve_milestone(4, _sender=admin, _now=_ts(L))
  bp.claim_milestone(4, _sender=contractor, _now=_ts(L))
  set_end(4, _ts(L + 30 * DAY), _ts(L))
  # 200 days after the end date: 200% without the cap
  late4 = _ts(L + 230 * DAY)
  price(P, late4)
  # 230 days: 122,666 cents of interest, 106,666 above the hold
  scenario.verify(bp.get_amount_due(4) == 2 * (400_000 + 106_666))
  bp.repay(sp.record(project_id=4, usd_cents=2_000_000), _sender=contractor, _now=late4)
  p4 = bp.data.projects[4]
  scenario.verify(p4.status == sp.variant.Repaid(sp.unit))
  scenario.verify(p4.late_fee_usd == 506_666)
  # the hold paid $160; the contractor $1,066.66 more; investors get 70% of all
  scenario.verify(p4.hold_used_usd == 16_000)
  scenario.verify(p4.interest_paid_usd == 106_666)
  bp.claim_payout(4, _sender=alice, _now=late4)
  bp.claim_payout(4, _sender=bob, _now=late4)
  scenario.verify(total() == TOTAL)

  # ----------------------------------------------------------------------
  scenario.h2("BRO rose and fell: draws and payouts at each day's price")
  L = 700 * DAY
  fund(5, L, [(4000, 10), (6000, 40)])
  bp.approve_milestone(5, _sender=admin, _now=_ts(L))
  scenario.p("BRO doubled: the draw needs half the escrow, the rest goes to the wallet")
  price(P // 2, _ts(L))
  w = scenario.compute(bal(wallet.address))
  bp.claim_milestone(5, _sender=contractor, _now=_ts(L))
  p5 = bp.data.projects[5]
  scenario.verify(p5.hold_bro == 400_000)
  scenario.verify(p5.flows.surplus_bro == 2_000_000)
  scenario.verify(bal(wallet.address) == w + 2_000_000)
  scenario.p("BRO then fell to a quarter: the hold BRO falls short, the wallet covers investors")
  # $160 = 640,000 BRO at 40 units per cent; the hold has 400,000
  price(4 * P, _ts(L + 30 * DAY))
  bp.pay_interest(5, _sender=carol, _now=_ts(L + 30 * DAY))
  p5 = bp.data.projects[5]
  scenario.verify(p5.hold_bro == 0)
  scenario.verify(p5.investor_bro == 448_000)
  scenario.verify(p5.flows.covered_bro == 48_000)
  scenario.verify(p5.flows.builder_fee_bro == 0)
  scenario.verify(bal(wallet.address) + 48_000 == w + 2_000_000)
  scenario.verify(total() == TOTAL)

  scenario.h2("Default: M1 overdue, BRO fell, a thin funding wallet")
  # M1 fell due 40 days after M0's approval and is never delivered
  bp.mark_default(5, _sender=admin, _now=_ts(L + 43 * DAY), _valid=False, _exception="NOT_OVERDUE")
  bp.mark_default(5, _sender=carol, _now=_ts(L + 43 * DAY + 1), _valid=False, _exception="NOT_APPROVER")
  bp.mark_default(0, _sender=admin, _now=_ts(L + 43 * DAY + 1), _valid=False, _exception="NOT_DEFAULTABLE")
  send(wallet, admin, sp.as_nat(bal(wallet.address) - 1_000_000))
  dflt = _ts(L + 43 * DAY + 1)
  price(4 * P, dflt)
  bp.mark_default(5, _sender=approver, _now=dflt)
  p5 = bp.data.projects[5]
  scenario.verify(p5.status == sp.variant.Defaulted(sp.unit))
  scenario.verify(p5.released)
  # 44 days on $4,000: 23,466 cents of interest; owed 400,000 + 23,466 - 80,000
  scenario.verify(p5.default_due_usd == 343_466)
  scenario.verify(bp.get_amount_due(5) == 343_466)
  # the last hold payout: 7,466 cents = 298,640 BRO; 70% = 209,048 to investors.
  # Investors are owed that plus 4,000,000 principal; the wallet has 1,000,000
  scenario.verify(p5.uncovered_bro == 209_048 + 4_000_000 - 1_000_000)
  scenario.verify(p5.investor_bro == 448_000 + 6_000_000 + 1_000_000)
  scenario.verify(bal(wallet.address) == 0)
  bp.claim_milestone(5, _sender=contractor, _now=dflt, _valid=False, _exception="NOT_ACTIVE")
  bp.repay(sp.record(project_id=5, usd_cents=1), _sender=contractor, _now=dflt, _valid=False, _exception="NOT_OPEN")
  bp.claim_payout(5, _sender=alice, _now=dflt)
  bp.claim_payout(5, _sender=bob, _now=dflt)
  scenario.verify(bal(bp.address) <= 3)
  scenario.verify(total() == TOTAL)

  # ----------------------------------------------------------------------
  scenario.h2("Admin settings and pause")
  bp.set_grace_days(14, _sender=carol, _valid=False, _exception="NOT_ADMIN")
  bp.set_grace_days(14, _sender=admin)
  scenario.verify(bp.data.grace_days == 14)
  bp.set_market(carol.address, _sender=carol, _valid=False, _exception="NOT_ADMIN")
  bp.set_admin(carol.address, _sender=carol, _valid=False, _exception="NOT_ADMIN")
  bp.pause(True, _sender=carol, _valid=False, _exception="NOT_ADMIN")
  bp.pause(True, _sender=admin)
  bp.claim_payout(0, _sender=alice, _now=_ts(900 * DAY), _valid=False, _exception="PAUSED")
  bp.pay_interest(0, _sender=alice, _now=_ts(900 * DAY), _valid=False, _exception="PAUSED")
  bp.pause(False, _sender=admin)

  scenario.h2("Flow totals add up across projects")
  f = bp.data.flows
  scenario.verify(
    f.builder_fee_bro
    == flows(0).builder_fee_bro + flows(1).builder_fee_bro + flows(2).builder_fee_bro
    + flows(3).builder_fee_bro + flows(4).builder_fee_bro + flows(5).builder_fee_bro
  )
  scenario.verify(f.late_fee_bro == flows(3).late_fee_bro + flows(4).late_fee_bro)
  scenario.verify(f.surplus_bro == flows(5).surplus_bro + flows(2).surplus_bro + flows(3).surplus_bro + flows(4).surplus_bro)
