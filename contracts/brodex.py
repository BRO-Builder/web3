"""Token <-> XTZ constant-product DEX

Written in SmartPy's new (0.17+) module syntax, matching the style of the
official FA2 library (https://smartpy.tezos.com/manual/libraries/FA2-lib).

- x * y = k constant-product swaps in both directions
- LP shares tracked so liquidity providers can add/remove liquidity
- Admin-configurable fee (in basis points) charged on every swap
- The fee stays in the pool: the full input amount is added to the
  reserves, but the output is computed from the fee-adjusted input.
  This grows k over time, so the fee accrues to liquidity providers
  when they redeem their shares.
- Interacts with a paired FA2 single-asset (or any single-token-id FA2)
  contract using the standard batched `transfer` entrypoint. Traders and
  liquidity providers must call `update_operators` on the token contract
  to authorize this DEX before it can pull their tokens.

This is illustrative / educational code. Have it audited before using it
with real funds.
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


@sp.module
def main():
  import t # type: ignore
  import smartpy.stdlib.utils as utils # type: ignore

  class BRODex(sp.Contract):
    """Constant-product AMM trading a single-asset FA2 token against XTZ."""

    def __init__(self, contract_metadata, admin, token_address, token_id, fee_bps):
      self.data.metadata = sp.cast(contract_metadata, t.metadata)
      self.data.admin = admin
      self.data.token_address = token_address
      self.data.token_id = sp.cast(token_id, sp.nat)
      self.data.fee_bps = sp.cast(fee_bps, sp.nat)
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
    def initialize_pool(self, token_amount):
      """One-time bootstrap of the pool. Caller sends XTZ as the
      transaction amount and specifies how much token to seed it with.
      Requires the DEX to already be an operator for the caller's
      tokens (FA2 `update_operators`)."""
      sp.cast(token_amount, sp.nat)
      assert self.data.total_shares == 0, "ALREADY_INITIALIZED"
      assert sp.amount > sp.mutez(0), "NEED_XTZ"
      assert token_amount > 0, "NEED_TOKEN"

      self.token_transfer_(
        sp.record(from_=sp.sender, to_=sp.self_address, amount=token_amount)
      )

      self.data.xtz_pool = sp.amount
      self.data.token_pool = token_amount
      initial_shares = token_amount
      self.data.total_shares = initial_shares
      self.data.shares[sp.sender] = initial_shares

    @sp.entrypoint
    def add_liquidity(self, min_shares):
      """Caller sends XTZ as the transaction amount. The matching amount
      of token (at the current pool ratio) is pulled from the caller
      via the FA2 contract's `transfer` entrypoint (requires the DEX
      to be a registered operator for the caller's tokens)."""
      sp.cast(min_shares, sp.nat)
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

      self.data.xtz_pool += sp.amount
      self.data.token_pool += token_required
      self.data.total_shares += new_shares

      current = self.data.shares.get(sp.sender, default=0)
      self.data.shares[sp.sender] = current + new_shares

    @sp.entrypoint
    def remove_liquidity(self, params):
      sp.cast(
        params,
        sp.record(shares=sp.nat, min_xtz=sp.mutez, min_token=sp.nat),
      )
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

      sp.send(sp.sender, xtz_out)
      self.token_transfer_(
        sp.record(from_=sp.self_address, to_=sp.sender, amount=token_out)
      )

    @sp.entrypoint
    def xtz_to_token(self, min_tokens_out):
      """Caller sends XTZ as the transaction amount, receives token back.
      The full XTZ input joins the pool; the fee portion is simply not
      counted when pricing the output, so it stays in the reserves."""
      sp.cast(min_tokens_out, sp.nat)
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

      self.token_transfer_(
        sp.record(from_=sp.self_address, to_=sp.sender, amount=tokens_out)
      )

    @sp.entrypoint
    def token_to_xtz(self, params):
      """Requires the DEX to be a registered operator for the caller's
      tokens (FA2 `update_operators`) so it can pull `token_amount`."""
      sp.cast(params, sp.record(token_amount=sp.nat, min_xtz_out=sp.mutez))
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

      sp.send(sp.sender, xtz_out)

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


@sp.module
def helpers():
  import t # type: ignore

  class DummyFA2(sp.Contract):
    """Minimal FA2 single-asset token stub, for testing only.
    A real FA2 contract also enforces operator permissions on
    `transfer`; this stub skips that check to keep tests short."""

    def __init__(self, admin):
      self.data.admin = admin
      self.data.balances = sp.cast(sp.big_map(), sp.big_map[sp.address, sp.nat])

    @sp.entrypoint
    def mint(self, params):
      sp.cast(params, sp.record(to_=sp.address, amount=sp.nat))
      assert sp.sender == self.data.admin, "NOT_ADMIN"
      current = self.data.balances.get(params.to_, default=0)
      self.data.balances[params.to_] = current + params.amount

    @sp.entrypoint
    def transfer(self, batch):
      sp.cast(batch, t.transfer_params)
      for transfer_ in batch:
        for tx in transfer_.txs:
          from_bal = self.data.balances.get(transfer_.from_, default=0)
          assert from_bal >= tx.amount, "FA2_INSUFFICIENT_BALANCE"
          self.data.balances[transfer_.from_] = sp.as_nat(from_bal - tx.amount)
          to_bal = self.data.balances.get(tx.to_, default=0)
          self.data.balances[tx.to_] = to_bal + tx.amount


@sp.add_test()
def test():
  admin = sp.test_account("Admin")
  alice = sp.test_account("Alice")
  bob = sp.test_account("Bob")

  scenario = sp.test_scenario("build/BRODex", [t, main, helpers])
  scenario.h1("Token (FA2 single-asset) <-> XTZ DEX")

  token = helpers.DummyFA2(admin.address)
  scenario += token

  dex = main.BRODex(
    contract_metadata=sp.big_map(),
    admin=admin.address,
    token_address=token.address,
    token_id=0,
    fee_bps=30,
  )
  scenario += dex

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

  # bootstrap pool: 10,000 tez <-> 100,000 token
  dex.initialize_pool(100_000, _sender=admin.address, _amount=sp.tez(10_000))

  # Bob swaps XTZ -> token; the full 100 tez (fee included) joins the pool
  dex.xtz_to_token(0, _sender=bob.address, _amount=sp.tez(100))
  scenario.verify(dex.data.xtz_pool == sp.tez(10_100))

  # Alice swaps token -> XTZ; the full 1,000 tokens (fee included) join the pool
  token_pool_before = scenario.compute(dex.data.token_pool)
  dex.token_to_xtz(
    sp.record(token_amount=1_000, min_xtz_out=sp.mutez(0)),
    _sender=alice.address,
  )
  scenario.verify(dex.data.token_pool == token_pool_before + 1_000)

  # admin updates fee
  dex.set_fee(50, _sender=admin.address)

  # non-admin cannot change fee
  dex.set_fee(10, _sender=alice.address, _valid=False)

  # fee above 100% is rejected
  dex.set_fee(10_001, _sender=admin.address, _valid=False)
