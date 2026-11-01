"""BROMarketAssistant: the BRO/USD price feed and the gatekeeper for the
BRO funding wallet that backs BROFunding and BROProjects.

- A system oracle wallet pushes the BRO/USD price (`update_price`). The
  contracts read it through the `get_price` on-chain view, which fails once
  the price is older than `max_price_age`.
- The funds sit in a plain tz wallet (`funding_wallet`), not in this
  contract. BROProjects sends surplus BRO straight to that wallet (plain
  FA2 transfers) and calls `cover` here when it is short. `cover` pulls BRO
  out of the wallet, which works only if the wallet has made THIS contract
  an FA2 operator of its BRO.
- This contract handles BRO only. It never holds, receives or swaps XTZ:
  every entrypoint rejects attached tez.
- The wallet's owner manages the funds directly with their own key.

Price unit: BRO base units per 1 USD cent, times PRICE_SCALE (10^6).

Setup:
   1. Originate BROMarketAssistant(..., funding_wallet=<tz wallet>)
   2. Originate BROFunding and BROProjects (see brofunding.py)
   3. Admin calls market.set_ledger(<BROProjects address>)
   4. The funding wallet calls update_operators on the BRO FA2 contract,
      adding owner=<funding wallet>, operator=<market address>,
      token_id=<id>

This is illustrative / educational code. Have it audited before using it
with real funds.
"""

import smartpy as sp
from .utils.common import t
from .utils.helper import helpers


@sp.module
def market():
  import t # type: ignore

  class BROMarketAssistant(sp.Contract):
    """BRO/USD price feed and gate to the BRO funding wallet."""

    def __init__(
      self,
      metadata,
      admin,
      oracle,
      funding_wallet,
      token_address,
      token_id,
      max_price_age,
    ):
      self.data.metadata = sp.cast(metadata, t.metadata)
      self.data.admin = sp.cast(admin, sp.address)
      self.data.oracle = sp.cast(oracle, sp.address)
      self.data.ledger = sp.cast(None, sp.option[sp.address])
      # tz wallet that holds the surplus / loss-cover BRO
      self.data.funding_wallet = sp.cast(funding_wallet, sp.address)
      self.data.token_address = sp.cast(token_address, sp.address)
      self.data.token_id = sp.cast(token_id, sp.nat)
      # BRO base units per USD cent, times 10^6
      self.data.price = sp.nat(0)
      self.data.price_updated_at = sp.timestamp(0)
      # seconds after which `get_price` refuses the price
      self.data.max_price_age = sp.cast(max_price_age, sp.int)

    @sp.private(with_storage="read-only", with_operations=True)
    def token_transfer_(self, params):
      """Pull BRO from the funding wallet. Requires this contract to be an
      FA2 operator of the wallet's BRO."""
      sp.cast(params, sp.record(to_=sp.address, amount=sp.nat))
      if params.amount > 0:
        contract = sp.contract(
          t.transfer_params, self.data.token_address, "transfer"
        ).unwrap_some(error="FA2_CONTRACT_NOT_FOUND")
        arg = [
          sp.record(
            from_=self.data.funding_wallet,
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
      assert sp.amount == sp.mutez(0), "NO_XTZ"
      assert sp.sender == self.data.admin, "NOT_ADMIN"
      self.data.admin = new_admin

    @sp.entrypoint
    def set_oracle(self, new_oracle):
      sp.cast(new_oracle, sp.address)
      assert sp.amount == sp.mutez(0), "NO_XTZ"
      assert sp.sender == self.data.admin, "NOT_ADMIN"
      self.data.oracle = new_oracle

    @sp.entrypoint
    def set_max_price_age(self, seconds):
      sp.cast(seconds, sp.int)
      assert sp.amount == sp.mutez(0), "NO_XTZ"
      assert sp.sender == self.data.admin, "NOT_ADMIN"
      assert seconds > 0, "BAD_PRICE_AGE"
      self.data.max_price_age = seconds

    @sp.entrypoint
    def set_ledger(self, ledger):
      sp.cast(ledger, sp.address)
      assert sp.amount == sp.mutez(0), "NO_XTZ"
      assert sp.sender == self.data.admin, "NOT_ADMIN"
      self.data.ledger = sp.Some(ledger)

    @sp.entrypoint
    def set_funding_wallet(self, new_wallet):
      """Point to a new funding wallet. The new wallet must also make this
      contract an FA2 operator before `cover` can work again."""
      sp.cast(new_wallet, sp.address)
      assert sp.amount == sp.mutez(0), "NO_XTZ"
      assert sp.sender == self.data.admin, "NOT_ADMIN"
      self.data.funding_wallet = new_wallet

    # ------------------------------------------------------------------
    # Oracle
    # ------------------------------------------------------------------
    @sp.entrypoint
    def update_price(self, price):
      sp.cast(price, sp.nat)
      assert sp.amount == sp.mutez(0), "NO_XTZ"
      assert sp.sender == self.data.oracle, "NOT_ORACLE"
      assert price > 0, "BAD_PRICE"
      self.data.price = price
      self.data.price_updated_at = sp.now

    # ------------------------------------------------------------------
    # Ledger
    # ------------------------------------------------------------------
    @sp.entrypoint
    def cover(self, params):
      """Ledger-only. Pay BRO out of the funding wallet; the FA2 transfer
      fails if the wallet is short or has not approved this contract as
      operator."""
      sp.cast(params, t.cover_params)
      assert sp.amount == sp.mutez(0), "NO_XTZ"
      assert (
        sp.sender == self.data.ledger.unwrap_some(error="LEDGER_NOT_SET")
      ), "NOT_LEDGER"
      self.token_transfer_(params)

    # ------------------------------------------------------------------
    # Views
    # ------------------------------------------------------------------
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

    @sp.onchain_view()
    def get_funding_wallet(self):
      """The wallet that receives surplus BRO and funds `cover`."""
      return self.data.funding_wallet


@sp.add_test()
def test_market():
  admin = sp.test_account("Admin")
  oracle = sp.test_account("Oracle")
  ledger = sp.test_account("Ledger")
  wallet = sp.test_account("FundingWallet")
  alice = sp.test_account("Alice")

  scenario = sp.test_scenario("build/BROMarket", [t, helpers, market])
  scenario.h1("BRO Market Assistant (BRO only, external funding wallet)")

  token = helpers.DummyFA2(admin.address)
  scenario += token
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
  token.mint(to_=wallet.address, amount=100_000, _sender=admin.address)

  scenario.h2("No XTZ accepted")
  ma.update_price(
    5_000_000, _sender=oracle.address, _amount=sp.tez(1),
    _valid=False, _exception="NO_XTZ",
  )
  ma.set_ledger(
    ledger.address, _sender=admin.address, _amount=sp.tez(1),
    _valid=False, _exception="NO_XTZ",
  )
  scenario.verify(ma.balance == sp.mutez(0))

  scenario.h2("Admin settings")
  ma.set_oracle(alice.address, _sender=alice.address, _valid=False)
  ma.set_max_price_age(0, _sender=admin.address, _valid=False)
  ma.set_max_price_age(7200, _sender=admin.address)
  scenario.verify(ma.data.max_price_age == 7200)
  ma.set_admin(alice.address, _sender=alice.address, _valid=False)
  ma.set_funding_wallet(alice.address, _sender=alice.address, _valid=False)

  scenario.h2("Price feed")
  ma.update_price(5_000_000, _sender=alice.address, _valid=False)
  ma.update_price(0, _sender=oracle.address, _valid=False)
  ma.update_price(5_000_000, _sender=oracle.address, _now=sp.timestamp(100))
  scenario.verify(ma.data.price == 5_000_000)
  scenario.verify(ma.data.price_updated_at == sp.timestamp(100))

  scenario.h2("Cover is ledger-only and needs operator approval")
  ma.cover(
    sp.record(to_=alice.address, amount=1), _sender=ledger.address,
    _valid=False, _exception="LEDGER_NOT_SET",
  )
  ma.set_ledger(ledger.address, _sender=alice.address, _valid=False)
  ma.set_ledger(ledger.address, _sender=admin.address)
  ma.cover(
    sp.record(to_=alice.address, amount=1), _sender=alice.address,
    _valid=False, _exception="NOT_LEDGER",
  )
  # wallet has not approved the market as operator yet
  ma.cover(
    sp.record(to_=alice.address, amount=1_000), _sender=ledger.address,
    _valid=False,
  )

  token.update_operators(
    [sp.variant.add_operator(
      sp.record(owner=wallet.address, operator=ma.address, token_id=0)
    )],
    _sender=wallet.address,
  )
  ma.cover(sp.record(to_=alice.address, amount=1_000), _sender=ledger.address)
  scenario.verify(token.data.balances[alice.address] == 1_000)
  scenario.verify(token.data.balances[wallet.address] == 99_000)
  ma.cover(
    sp.record(to_=alice.address, amount=1_000_000),
    _sender=ledger.address,
    _valid=False,
  )  # wallet too small

  scenario.h2("Funding wallet view")
  scenario.verify(ma.get_funding_wallet() == wallet.address)
