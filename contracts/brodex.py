"""Token <-> XTZ constant-product DEX (FA2 single-asset vs XTZ).

All XTZ lives in the paired BRODelegator vault (see bro_delegator.py):
incoming XTZ is forwarded to the vault, outgoing XTZ is paid by the vault.
Invariant: vault.accounted == dex.xtz_pool.

- x * y = k swaps in both directions; LP shares for liquidity providers
- Admin-configurable fee (bps); the fee stays in the pool and accrues to LPs
- Admin pause switch
- Reports LP share changes to the vault so LP votes follow liquidity

This is illustrative / educational code. Have it audited before using it
with real funds.
"""

import smartpy as sp
from .utils.common import t
from .utils.helper import helpers
from .brodelegator import delegator


@sp.module
def main():
  import t # type: ignore
  import smartpy.stdlib.utils as utils # type: ignore

  class BRODex(sp.Contract):
    """Constant-product AMM trading a single-asset FA2 token against XTZ.
    All XTZ lives in the paired BRODelegator vault."""

    def __init__(
      self, contract_metadata, admin, token_address, token_id, fee_bps, vault
    ):
      self.data.metadata = sp.cast(contract_metadata, t.metadata)
      self.data.admin = admin
      self.data.vault = sp.cast(vault, sp.address)
      self.data.token_address = token_address
      self.data.token_id = sp.cast(token_id, sp.nat)
      self.data.fee_bps = sp.cast(fee_bps, sp.nat)
      self.data.paused = False
      self.data.xtz_pool = sp.mutez(0)
      self.data.token_pool = sp.nat(0)
      self.data.total_shares = sp.nat(0)
      self.data.shares = sp.cast(sp.big_map(), sp.big_map[sp.address, sp.nat])

    @sp.private(with_storage="read-only", with_operations=True)
    def token_transfer_(self, params):
      """Call the paired FA2 contract's `transfer` entrypoint."""
      sp.cast(params, sp.record(from_=sp.address, to_=sp.address, amount=sp.nat))
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
    def vault_deposit_(self, amount):
      """Forward incoming XTZ to the vault."""
      sp.cast(amount, sp.mutez)
      vault = sp.contract(sp.unit, self.data.vault, "deposit").unwrap_some(
        error="VAULT_DEPOSIT_NOT_FOUND"
      )
      sp.transfer((), amount, vault)

    @sp.private(with_storage="read-only", with_operations=True)
    def vault_withdraw_(self, params):
      """Have the vault pay XTZ directly to `to_`."""
      sp.cast(params, t.withdraw_params)
      vault = sp.contract(
        t.withdraw_params, self.data.vault, "withdraw"
      ).unwrap_some(error="VAULT_WITHDRAW_NOT_FOUND")
      sp.transfer(params, sp.mutez(0), vault)

    @sp.private(with_storage="read-only", with_operations=True)
    def vault_sync_(self, owner):
      """Tell the vault `owner`'s current shares (call AFTER updating
      storage) so vote weights follow liquidity changes."""
      sp.cast(owner, sp.address)
      vault = sp.contract(
        t.sync_params, self.data.vault, "sync_shares"
      ).unwrap_some(error="VAULT_SYNC_NOT_FOUND")
      sp.transfer(
        sp.record(
          owner=owner,
          shares=self.data.shares.get(owner, default=0),
          total_shares=self.data.total_shares,
        ),
        sp.mutez(0),
        vault,
      )

    @sp.entrypoint
    def set_admin(self, new_admin):
      sp.cast(new_admin, sp.address)
      assert sp.sender == self.data.admin, "NOT_ADMIN"
      self.data.admin = new_admin

    @sp.entrypoint
    def set_fee(self, new_fee_bps):
      sp.cast(new_fee_bps, sp.nat)
      assert sp.sender == self.data.admin, "NOT_ADMIN"
      assert new_fee_bps <= 10000, "FEE_TOO_HIGH"
      self.data.fee_bps = new_fee_bps

    @sp.entrypoint
    def pause(self, new_paused):
      """Admin-only switch. When paused, initialize_pool, add_liquidity,
      remove_liquidity, xtz_to_token, and token_to_xtz are disabled."""
      sp.cast(new_paused, sp.bool)
      assert sp.sender == self.data.admin, "NOT_ADMIN"
      self.data.paused = new_paused

    @sp.entrypoint
    def credit_rewards(self, amount):
      """Vault-only. Baker rewards already sitting in the vault are added
      to the pool's XTZ reserve (no transfer needed). This raises k, so
      LPs capture the rewards when they redeem shares. Intentionally not
      blocked by `paused`."""
      sp.cast(amount, sp.mutez)
      assert sp.sender == self.data.vault, "NOT_VAULT"
      self.data.xtz_pool += amount

    @sp.entrypoint
    def initialize_pool(self, token_amount):
      """One-time bootstrap of the pool. Caller sends XTZ as the
      transaction amount and specifies how much token to seed it with.
      Requires the DEX to already be an operator for the caller's
      tokens (FA2 `update_operators`)."""
      sp.cast(token_amount, sp.nat)
      assert not self.data.paused, "PAUSED"
      assert self.data.total_shares == 0, "ALREADY_INITIALIZED"
      assert sp.amount > sp.mutez(0), "NEED_XTZ"
      assert token_amount > 0, "NEED_TOKEN"

      self.token_transfer_(
        sp.record(from_=sp.sender, to_=sp.self_address, amount=token_amount)
      )
      self.vault_deposit_(sp.amount)

      self.data.xtz_pool = sp.amount
      self.data.token_pool = token_amount
      initial_shares = token_amount
      self.data.total_shares = initial_shares
      self.data.shares[sp.sender] = initial_shares

      self.vault_sync_(sp.sender)

    @sp.entrypoint
    def add_liquidity(self, min_shares):
      """Caller sends XTZ as the transaction amount. The matching amount
      of token (at the current pool ratio) is pulled from the caller
      via the FA2 contract's `transfer` entrypoint (requires the DEX
      to be a registered operator for the caller's tokens)."""
      sp.cast(min_shares, sp.nat)
      assert not self.data.paused, "PAUSED"
      assert self.data.total_shares > 0, "POOL_NOT_INITIALIZED"
      assert sp.amount > sp.mutez(0), "NEED_XTZ"

      xtz_in_nat = utils.mutez_to_nat(sp.amount)
      xtz_pool_nat = utils.mutez_to_nat(self.data.xtz_pool)

      token_required = (self.data.token_pool * xtz_in_nat) / xtz_pool_nat
      new_shares = (self.data.total_shares * xtz_in_nat) / xtz_pool_nat
      assert new_shares >= min_shares, "SLIPPAGE"
      assert token_required > 0, "AMOUNT_TOO_SMALL"

      self.token_transfer_(
        sp.record(from_=sp.sender, to_=sp.self_address, amount=token_required)
      )
      self.vault_deposit_(sp.amount)

      self.data.xtz_pool += sp.amount
      self.data.token_pool += token_required
      self.data.total_shares += new_shares

      current = self.data.shares.get(sp.sender, default=0)
      self.data.shares[sp.sender] = current + new_shares

      self.vault_sync_(sp.sender)

    @sp.entrypoint
    def remove_liquidity(self, params):
      sp.cast(
        params,
        sp.record(shares=sp.nat, min_xtz=sp.mutez, min_token=sp.nat),
      )
      assert not self.data.paused, "PAUSED"
      assert self.data.total_shares > 0, "POOL_NOT_INITIALIZED"
      user_shares = self.data.shares.get(sp.sender, default=0)
      assert user_shares >= params.shares, "INSUFFICIENT_SHARES"

      xtz_pool_nat = utils.mutez_to_nat(self.data.xtz_pool)
      xtz_out_nat = (xtz_pool_nat * params.shares) / self.data.total_shares
      token_out = (self.data.token_pool * params.shares) / self.data.total_shares
      xtz_out = utils.nat_to_mutez(xtz_out_nat)

      assert xtz_out >= params.min_xtz, "SLIPPAGE_XTZ"
      assert token_out >= params.min_token, "SLIPPAGE_TOKEN"

      self.data.shares[sp.sender] = sp.as_nat(user_shares - params.shares)
      self.data.total_shares = sp.as_nat(self.data.total_shares - params.shares)
      self.data.xtz_pool -= xtz_out
      self.data.token_pool = sp.as_nat(self.data.token_pool - token_out)

      self.vault_withdraw_(sp.record(to_=sp.sender, amount=xtz_out))
      self.token_transfer_(
        sp.record(from_=sp.self_address, to_=sp.sender, amount=token_out)
      )
      self.vault_sync_(sp.sender)

    @sp.entrypoint
    def xtz_to_token(self, min_tokens_out):
      """Caller sends XTZ as the transaction amount, receives token back.
      The full XTZ input joins the pool (forwarded to the vault); the fee
      portion is simply not counted when pricing the output."""
      sp.cast(min_tokens_out, sp.nat)
      assert not self.data.paused, "PAUSED"
      assert self.data.total_shares > 0, "POOL_NOT_INITIALIZED"
      assert sp.amount > sp.mutez(0), "NEED_XTZ"

      xtz_in_nat = utils.mutez_to_nat(sp.amount)
      # fee-adjusted input, used for pricing only (rounds down => favors pool)
      net_in_nat = (xtz_in_nat * sp.as_nat(10000 - self.data.fee_bps)) / 10000

      xtz_pool_nat = utils.mutez_to_nat(self.data.xtz_pool)

      tokens_out = (self.data.token_pool * net_in_nat) / (xtz_pool_nat + net_in_nat)
      assert tokens_out >= min_tokens_out, "SLIPPAGE"
      assert tokens_out < self.data.token_pool, "INSUFFICIENT_LIQUIDITY"

      # full input (fee included) is added to the pool
      self.data.xtz_pool += sp.amount
      self.data.token_pool = sp.as_nat(self.data.token_pool - tokens_out)

      self.vault_deposit_(sp.amount)
      self.token_transfer_(
        sp.record(from_=sp.self_address, to_=sp.sender, amount=tokens_out)
      )

    @sp.entrypoint
    def token_to_xtz(self, params):
      """Requires the DEX to be a registered operator for the caller's
      tokens (FA2 `update_operators`) so it can pull `token_amount`."""
      sp.cast(params, sp.record(token_amount=sp.nat, min_xtz_out=sp.mutez))
      assert not self.data.paused, "PAUSED"
      assert self.data.total_shares > 0, "POOL_NOT_INITIALIZED"
      assert params.token_amount > 0, "NEED_TOKEN"

      self.token_transfer_(
        sp.record(
          from_=sp.sender, to_=sp.self_address, amount=params.token_amount
        )
      )

      # fee-adjusted input, used for pricing only (rounds down => favors pool)
      net_in_nat = (
        params.token_amount * sp.as_nat(10000 - self.data.fee_bps)
      ) / 10000

      xtz_pool_nat = utils.mutez_to_nat(self.data.xtz_pool)

      xtz_out_nat = (xtz_pool_nat * net_in_nat) / (self.data.token_pool + net_in_nat)
      xtz_out = utils.nat_to_mutez(xtz_out_nat)
      assert xtz_out >= params.min_xtz_out, "SLIPPAGE"
      assert xtz_out < self.data.xtz_pool, "INSUFFICIENT_LIQUIDITY"

      # full input (fee included) is added to the pool
      self.data.token_pool += params.token_amount
      self.data.xtz_pool -= xtz_out

      self.vault_withdraw_(sp.record(to_=sp.sender, amount=xtz_out))

    @sp.onchain_view()
    def get_shares(self, owner):
      sp.cast(owner, sp.address)
      return self.data.shares.get(owner, default=0)

    @sp.onchain_view()
    def get_price_xtz_to_token(self, xtz_in):
      sp.cast(xtz_in, sp.mutez)
      xtz_in_nat = utils.mutez_to_nat(xtz_in)
      net_in_nat = (xtz_in_nat * sp.as_nat(10000 - self.data.fee_bps)) / 10000
      xtz_pool_nat = utils.mutez_to_nat(self.data.xtz_pool)
      return (self.data.token_pool * net_in_nat) / (xtz_pool_nat + net_in_nat)

    @sp.onchain_view()
    def get_price_token_to_xtz(self, token_in):
      sp.cast(token_in, sp.nat)
      net_in_nat = (token_in * sp.as_nat(10000 - self.data.fee_bps)) / 10000
      xtz_pool_nat = utils.mutez_to_nat(self.data.xtz_pool)
      return utils.nat_to_mutez(
        (xtz_pool_nat * net_in_nat) / (self.data.token_pool + net_in_nat)
      )


@sp.add_test()
def test_dex():
  admin = sp.test_account("Admin")
  alice = sp.test_account("Alice")
  bob = sp.test_account("Bob")
  baker1 = sp.test_account("Baker1")
  bakers = {baker1.public_key_hash: 0}

  scenario = sp.test_scenario("build/BRODex", [t, delegator, main, helpers])
  scenario.h1("Token (FA2 single-asset) <-> XTZ DEX")

  token = helpers.DummyFA2(admin.address)
  scenario += token
  vault = delegator.BRODelegator(metadata=sp.big_map(), admin=admin.address, quorum_bps=1000)
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

  token.mint(to_=admin.address, amount=2_000_000, _sender=admin.address)
  token.transfer(
    [
      sp.record(
        from_=admin.address,
        txs=[sp.record(to_=alice.address, token_id=0, amount=1_000_000)],
      )
    ],
    _sender=admin.address,
  )

  scenario.h2("Before the pool exists")
  dex.xtz_to_token(0, _sender=bob.address, _amount=sp.tez(1), _valid=False)
  dex.add_liquidity(0, _sender=bob.address, _amount=sp.tez(1), _valid=False)
  dex.initialize_pool(100, _sender=admin.address, _valid=False)  # NEED_XTZ
  dex.initialize_pool(0, _sender=admin.address, _amount=sp.tez(1), _valid=False)

  scenario.h2("Bootstrap: 10,000 tez <-> 100,000 token")
  dex.initialize_pool(100_000, _sender=admin.address, _amount=sp.tez(10_000))
  scenario.verify(dex.balance == sp.tez(0))  # DEX holds no XTZ itself
  scenario.verify(vault.balance == sp.tez(10_000))
  scenario.verify(vault.data.accounted == dex.data.xtz_pool)
  scenario.verify(dex.data.shares[admin.address] == 100_000)
  scenario.verify(vault.data.shares[admin.address] == 100_000)
  dex.initialize_pool(
    1, _sender=admin.address, _amount=sp.tez(1), _valid=False
  )  # ALREADY_INITIALIZED

  scenario.h2("XTZ -> token")
  dex.xtz_to_token(0, _sender=bob.address, _amount=sp.tez(100))
  scenario.verify(dex.data.xtz_pool == sp.tez(10_100))
  scenario.verify(vault.balance == sp.tez(10_100))
  scenario.verify(dex.balance == sp.tez(0))
  # slippage guard
  dex.xtz_to_token(
    10_000_000, _sender=bob.address, _amount=sp.tez(1), _valid=False
  )

  scenario.h2("Token -> XTZ")
  token_pool_before = scenario.compute(dex.data.token_pool)
  dex.token_to_xtz(
    sp.record(token_amount=1_000, min_xtz_out=sp.mutez(0)),
    _sender=alice.address,
  )
  scenario.verify(dex.data.token_pool == token_pool_before + 1_000)
  scenario.verify(vault.balance == dex.data.xtz_pool)
  scenario.verify(dex.balance == sp.tez(0))
  # slippage guard
  dex.token_to_xtz(
    sp.record(token_amount=1_000, min_xtz_out=sp.tez(1_000)),
    _sender=alice.address,
    _valid=False,
  )
  dex.token_to_xtz(
    sp.record(token_amount=0, min_xtz_out=sp.mutez(0)),
    _sender=alice.address,
    _valid=False,
  )

  scenario.h2("Add / remove liquidity")
  dex.add_liquidity(0, _sender=alice.address, _amount=sp.tez(1_000))
  scenario.verify(vault.balance == dex.data.xtz_pool)
  scenario.verify(vault.data.total_shares == dex.data.total_shares)
  scenario.verify(
    vault.data.shares[alice.address] == dex.data.shares[alice.address]
  )
  alice_shares = scenario.compute(dex.data.shares[alice.address])
  # can't redeem more than owned, nor with an impossible minimum
  dex.remove_liquidity(
    sp.record(shares=alice_shares + 1, min_xtz=sp.mutez(0), min_token=0),
    _sender=alice.address,
    _valid=False,
  )
  dex.remove_liquidity(
    sp.record(shares=alice_shares, min_xtz=sp.tez(1_000_000), min_token=0),
    _sender=alice.address,
    _valid=False,
  )
  dex.remove_liquidity(
    sp.record(shares=alice_shares, min_xtz=sp.mutez(0), min_token=0),
    _sender=alice.address,
  )
  scenario.verify(dex.data.shares[alice.address] == 0)
  scenario.verify(vault.data.shares[alice.address] == 0)
  scenario.verify(vault.balance == dex.data.xtz_pool)
  scenario.verify(vault.data.total_shares == dex.data.total_shares)

  scenario.h2("Share changes reach the vault's vote tally")
  vault.vote(baker1.public_key_hash, _sender=admin.address)
  scenario.verify(vault.data.tally[baker1.public_key_hash] == 100_000)
  dex.remove_liquidity(
    sp.record(shares=40_000, min_xtz=sp.mutez(0), min_token=0),
    _sender=admin.address,
  )
  scenario.verify(vault.data.tally[baker1.public_key_hash] == 60_000)
  dex.add_liquidity(0, _sender=admin.address, _amount=sp.tez(1_000))
  scenario.verify(
    vault.data.tally[baker1.public_key_hash] == dex.data.shares[admin.address]
  )
  scenario.verify(vault.balance == dex.data.xtz_pool)

  scenario.h2("Vault rewards raise the pool reserve (credit_rewards)")
  dex.credit_rewards(sp.tez(1), _sender=alice.address, _valid=False)
  dex.credit_rewards(sp.tez(1), _sender=admin.address, _valid=False)
  pool_before = scenario.compute(dex.data.xtz_pool)
  vault.default(_sender=bob.address, _amount=sp.tez(50))
  vault.harvest(_sender=bob.address)
  scenario.verify(dex.data.xtz_pool == pool_before + sp.tez(50))
  scenario.verify(vault.balance == dex.data.xtz_pool)

  scenario.h2("Admin: fee / admin / pause")
  dex.set_fee(50, _sender=admin.address)
  scenario.verify(dex.data.fee_bps == 50)
  dex.set_fee(10, _sender=alice.address, _valid=False)
  dex.set_fee(10_001, _sender=admin.address, _valid=False)
  dex.set_admin(alice.address, _sender=bob.address, _valid=False)
  dex.pause(True, _sender=alice.address, _valid=False)

  dex.pause(True, _sender=admin.address)
  scenario.verify(dex.data.paused)
  dex.xtz_to_token(0, _sender=bob.address, _amount=sp.tez(10), _valid=False)
  dex.token_to_xtz(
    sp.record(token_amount=100, min_xtz_out=sp.mutez(0)),
    _sender=alice.address,
    _valid=False,
  )
  dex.add_liquidity(0, _sender=bob.address, _amount=sp.tez(10), _valid=False)
  dex.remove_liquidity(
    sp.record(shares=1, min_xtz=sp.mutez(0), min_token=0),
    _sender=admin.address,
    _valid=False,
  )
  # reward crediting is accounting only, so it still works while paused
  vault.default(_sender=bob.address, _amount=sp.tez(5))
  vault.harvest(_sender=bob.address)
  scenario.verify(vault.balance == dex.data.xtz_pool)

  dex.pause(False, _sender=admin.address)
  dex.xtz_to_token(0, _sender=bob.address, _amount=sp.tez(10))
  scenario.verify(vault.balance == dex.data.xtz_pool)
  scenario.verify(dex.balance == sp.tez(0))
