"""BROMarketAssistant: the BRO/USD price feed and the BRO/XTZ reserve that
backs BROFunding and BROProjects.

- A system oracle wallet pushes the BRO/USD price (`update_price`). The
  contracts read it through the `get_price` on-chain view, which fails once
  the price is older than `max_price_age`.
- The reserve absorbs the gap between USD-denominated obligations and BRO
  token amounts: BROProjects (the `ledger`) sends surplus BRO here (plain
  FA2 transfers) and calls `cover` when it is short.
- The admin manages the reserve: withdraws BRO / XTZ and trades on BRODex.

Price unit: BRO base units per 1 USD cent, times PRICE_SCALE (10^6).

Deployment order:
   1. Originate BROMarketAssistant(..., dex=<BRODex address>)
   2. Originate BROFunding and BROProjects (see brofunding.py)
   3. Admin calls market.set_ledger(<BROProjects address>)

This is illustrative / educational code. Have it audited before using it
with real funds.
"""

import smartpy as sp
from .utils.common import t
from .utils.helper import helpers
from .brodelegator import delegator
from .brodex import main


@sp.module
def market():
  import t # type: ignore

  class BROMarketAssistant(sp.Contract):
    """Holds the BRO/USD price and a BRO/XTZ reserve for one BROProjects."""

    def __init__(
      self,
      metadata,
      admin,
      oracle,
      dex,
      token_address,
      token_id,
      max_price_age,
    ):
      self.data.metadata = sp.cast(metadata, t.metadata)
      self.data.admin = sp.cast(admin, sp.address)
      self.data.oracle = sp.cast(oracle, sp.address)
      self.data.ledger = sp.cast(None, sp.option[sp.address])
      self.data.dex = sp.cast(dex, sp.address)
      self.data.token_address = sp.cast(token_address, sp.address)
      self.data.token_id = sp.cast(token_id, sp.nat)
      # BRO base units per USD cent, times 10^6
      self.data.price = sp.nat(0)
      self.data.price_updated_at = sp.timestamp(0)
      # seconds after which `get_price` refuses the price
      self.data.max_price_age = sp.cast(max_price_age, sp.int)

    @sp.private(with_storage="read-only", with_operations=True)
    def token_transfer_(self, params):
      """Send BRO from this contract's reserve."""
      sp.cast(params, sp.record(to_=sp.address, amount=sp.nat))
      contract = sp.contract(
        t.transfer_params, self.data.token_address, "transfer"
      ).unwrap_some(error="FA2_CONTRACT_NOT_FOUND")
      arg = [
        sp.record(
          from_=sp.self_address,
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
    def dex_operator_(self, add):
      """Add or remove the DEX as operator for this contract's BRO."""
      sp.cast(add, sp.bool)
      contract = sp.contract(
        t.update_operators_params, self.data.token_address, "update_operators"
      ).unwrap_some(error="FA2_CONTRACT_NOT_FOUND")
      permission = sp.record(
        owner=sp.self_address,
        operator=self.data.dex,
        token_id=self.data.token_id,
      )
      if add:
        sp.transfer(
          [sp.variant.add_operator(permission)], sp.mutez(0), contract
        )
      else:
        sp.transfer(
          [sp.variant.remove_operator(permission)], sp.mutez(0), contract
        )

    # ------------------------------------------------------------------
    # Admin
    # ------------------------------------------------------------------
    @sp.entrypoint
    def set_admin(self, new_admin):
      sp.cast(new_admin, sp.address)
      assert sp.sender == self.data.admin, "NOT_ADMIN"
      self.data.admin = new_admin

    @sp.entrypoint
    def set_oracle(self, new_oracle):
      sp.cast(new_oracle, sp.address)
      assert sp.sender == self.data.admin, "NOT_ADMIN"
      self.data.oracle = new_oracle

    @sp.entrypoint
    def set_max_price_age(self, seconds):
      sp.cast(seconds, sp.int)
      assert sp.sender == self.data.admin, "NOT_ADMIN"
      assert seconds > 0, "BAD_PRICE_AGE"
      self.data.max_price_age = seconds

    @sp.entrypoint
    def set_ledger(self, ledger):
      sp.cast(ledger, sp.address)
      assert sp.sender == self.data.admin, "NOT_ADMIN"
      self.data.ledger = sp.Some(ledger)

    @sp.entrypoint
    def set_dex(self, dex):
      sp.cast(dex, sp.address)
      assert sp.sender == self.data.admin, "NOT_ADMIN"
      self.data.dex = dex

    @sp.entrypoint
    def withdraw_token(self, params):
      sp.cast(params, sp.record(to_=sp.address, amount=sp.nat))
      assert sp.sender == self.data.admin, "NOT_ADMIN"
      self.token_transfer_(params)

    @sp.entrypoint
    def withdraw_xtz(self, params):
      sp.cast(params, sp.record(to_=sp.address, amount=sp.mutez))
      assert sp.sender == self.data.admin, "NOT_ADMIN"
      sp.send(params.to_, params.amount)

    @sp.entrypoint
    def swap_xtz_to_bro(self, params):
      """Buy BRO on BRODex with `xtz` from the reserve."""
      sp.cast(params, sp.record(xtz=sp.mutez, min_out=sp.nat))
      assert sp.sender == self.data.admin, "NOT_ADMIN"
      dex = sp.contract(sp.nat, self.data.dex, "xtz_to_token").unwrap_some(
        error="DEX_NOT_FOUND"
      )
      sp.transfer(params.min_out, params.xtz, dex)

    @sp.entrypoint
    def swap_bro_to_xtz(self, params):
      """Sell `amount` BRO on BRODex. FA2 operators have no allowance, so
      the DEX is made an operator only for the duration of the swap."""
      sp.cast(params, sp.record(amount=sp.nat, min_xtz_out=sp.mutez))
      assert sp.sender == self.data.admin, "NOT_ADMIN"
      dex = sp.contract(
        sp.record(token_amount=sp.nat, min_xtz_out=sp.mutez),
        self.data.dex,
        "token_to_xtz",
      ).unwrap_some(error="DEX_NOT_FOUND")
      self.dex_operator_(True)
      sp.transfer(
        sp.record(token_amount=params.amount, min_xtz_out=params.min_xtz_out),
        sp.mutez(0),
        dex,
      )
      self.dex_operator_(False)

    # ------------------------------------------------------------------
    # Oracle
    # ------------------------------------------------------------------
    @sp.entrypoint
    def update_price(self, price):
      sp.cast(price, sp.nat)
      assert sp.sender == self.data.oracle, "NOT_ORACLE"
      assert price > 0, "BAD_PRICE"
      self.data.price = price
      self.data.price_updated_at = sp.now

    # ------------------------------------------------------------------
    # Ledger
    # ------------------------------------------------------------------
    @sp.entrypoint
    def cover(self, params):
      """Ledger-only. Pay BRO from the reserve; the FA2 transfer fails if
      the reserve is short."""
      sp.cast(params, t.cover_params)
      assert (
        sp.sender == self.data.ledger.unwrap_some(error="LEDGER_NOT_SET")
      ), "NOT_LEDGER"
      self.token_transfer_(params)

    @sp.entrypoint
    def default(self):
      """Accept XTZ (admin top-ups and DEX swap proceeds)."""
      pass

    @sp.onchain_view()
    def get_price(self):
      assert self.data.price > 0, "PRICE_NOT_SET"
      assert (
        sp.now - self.data.price_updated_at <= self.data.max_price_age
      ), "PRICE_STALE"
      return self.data.price

    @sp.onchain_view()
    def get_price_info(self):
      return sp.record(
        price=self.data.price, updated_at=self.data.price_updated_at
      )


@sp.add_test()
def test_market():
  admin = sp.test_account("Admin")
  oracle = sp.test_account("Oracle")
  ledger = sp.test_account("Ledger")
  alice = sp.test_account("Alice")

  scenario = sp.test_scenario(
    "build/BROMarket", [t, delegator, main, helpers, market]
  )
  scenario.h1("BRO Market Assistant")

  token = helpers.DummyFA2(admin.address)
  scenario += token
  vault = delegator.BRODelegator(
    metadata=sp.big_map(), admin=admin.address, quorum_bps=1000
  )
  scenario += vault
  dex = main.BRODex(
    contract_metadata=sp.big_map(),
    admin=admin.address,
    token_address=token.address,
    token_id=0,
    fee_bps=30,
    vault=vault.address,
  )
  scenario += dex
  vault.set_dex(dex.address, _sender=admin.address)

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

  token.mint(to_=admin.address, amount=1_000_000, _sender=admin.address)
  token.mint(to_=ma.address, amount=100_000, _sender=admin.address)
  dex.initialize_pool(100_000, _sender=admin.address, _amount=sp.tez(10_000))

  scenario.h2("Admin settings")
  ma.set_oracle(alice.address, _sender=alice.address, _valid=False)
  ma.set_max_price_age(0, _sender=admin.address, _valid=False)
  ma.set_max_price_age(7200, _sender=admin.address)
  scenario.verify(ma.data.max_price_age == 7200)
  ma.set_dex(alice.address, _sender=alice.address, _valid=False)
  ma.set_admin(alice.address, _sender=alice.address, _valid=False)

  scenario.h2("Price feed")
  ma.update_price(5_000_000, _sender=alice.address, _valid=False)
  ma.update_price(0, _sender=oracle.address, _valid=False)
  ma.update_price(5_000_000, _sender=oracle.address, _now=sp.timestamp(100))
  scenario.verify(ma.data.price == 5_000_000)
  scenario.verify(ma.data.price_updated_at == sp.timestamp(100))
  ma.set_oracle(alice.address, _sender=admin.address)
  ma.update_price(6_000_000, _sender=oracle.address, _valid=False)
  ma.update_price(6_000_000, _sender=alice.address, _now=sp.timestamp(200))
  scenario.verify(ma.data.price == 6_000_000)

  scenario.h2("Cover is ledger-only")
  ma.cover(
    sp.record(to_=alice.address, amount=1), _sender=ledger.address, _valid=False
  )  # LEDGER_NOT_SET
  ma.set_ledger(ledger.address, _sender=alice.address, _valid=False)
  ma.set_ledger(ledger.address, _sender=admin.address)
  ma.cover(
    sp.record(to_=alice.address, amount=1), _sender=alice.address, _valid=False
  )
  ma.cover(sp.record(to_=alice.address, amount=1_000), _sender=ledger.address)
  scenario.verify(token.data.balances[alice.address] == 1_000)
  scenario.verify(token.data.balances[ma.address] == 99_000)
  ma.cover(
    sp.record(to_=alice.address, amount=1_000_000),
    _sender=ledger.address,
    _valid=False,
  )  # reserve too small

  scenario.h2("Reserve: deposits and withdrawals")
  ma.default(_sender=admin.address, _amount=sp.tez(100))
  scenario.verify(ma.balance == sp.tez(100))
  ma.withdraw_xtz(
    sp.record(to_=alice.address, amount=sp.tez(10)),
    _sender=alice.address,
    _valid=False,
  )
  ma.withdraw_xtz(sp.record(to_=alice.address, amount=sp.tez(10)), _sender=admin.address)
  scenario.verify(ma.balance == sp.tez(90))
  ma.withdraw_token(
    sp.record(to_=alice.address, amount=1_000),
    _sender=alice.address,
    _valid=False,
  )
  ma.withdraw_token(sp.record(to_=alice.address, amount=1_000), _sender=admin.address)
  scenario.verify(token.data.balances[ma.address] == 98_000)

  scenario.h2("Swaps against BRODex")
  ma.swap_xtz_to_bro(
    sp.record(xtz=sp.tez(10), min_out=0), _sender=alice.address, _valid=False
  )
  ma.swap_xtz_to_bro(
    sp.record(xtz=sp.tez(10), min_out=1_000_000),
    _sender=admin.address,
    _valid=False,
  )  # SLIPPAGE
  ma.swap_xtz_to_bro(sp.record(xtz=sp.tez(10), min_out=0), _sender=admin.address)
  scenario.verify(ma.balance == sp.tez(80))
  scenario.verify(token.data.balances[ma.address] > 98_000)
  scenario.verify(vault.balance == dex.data.xtz_pool)

  bro_before = scenario.compute(token.data.balances[ma.address])
  ma.swap_bro_to_xtz(
    sp.record(amount=1_000, min_xtz_out=sp.mutez(0)),
    _sender=alice.address,
    _valid=False,
  )
  ma.swap_bro_to_xtz(
    sp.record(amount=1_000, min_xtz_out=sp.mutez(0)), _sender=admin.address
  )
  scenario.verify(token.data.balances[ma.address] == sp.as_nat(bro_before - 1_000))
  scenario.verify(ma.balance > sp.tez(80))
  scenario.verify(vault.balance == dex.data.xtz_pool)
