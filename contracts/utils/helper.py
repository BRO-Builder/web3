"""Test-only helpers (not for deployment)."""

import smartpy as sp


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


  class DexStub(sp.Contract):
    """Stand-in for the DEX, so BRODelegator can be tested in isolation.
    Relays calls to the vault from a contract address (the vault only
    accepts deposit / withdraw / sync_shares from its linked DEX) and
    records what `credit_rewards` receives from `harvest`."""

    def __init__(self):
      self.data.credited = sp.mutez(0)

    @sp.entrypoint
    def credit_rewards(self, amount):
      sp.cast(amount, sp.mutez)
      self.data.credited += amount

    @sp.entrypoint
    def deposit(self, vault):
      """Forward the XTZ sent with this call to the vault."""
      sp.cast(vault, sp.address)
      c = sp.contract(sp.unit, vault, "deposit").unwrap_some()
      sp.transfer((), sp.amount, c)

    @sp.entrypoint
    def withdraw(self, params):
      sp.cast(
        params, sp.record(vault=sp.address, to_=sp.address, amount=sp.mutez)
      )
      c = sp.contract(t.withdraw_params, params.vault, "withdraw").unwrap_some()
      sp.transfer(
        sp.record(to_=params.to_, amount=params.amount), sp.mutez(0), c
      )

    @sp.entrypoint
    def sync(self, params):
      sp.cast(
        params,
        sp.record(
          vault=sp.address,
          owner=sp.address,
          shares=sp.nat,
          total_shares=sp.nat,
        ),
      )
      c = sp.contract(t.sync_params, params.vault, "sync_shares").unwrap_some()
      sp.transfer(
        sp.record(
          owner=params.owner,
          shares=params.shares,
          total_shares=params.total_shares,
        ),
        sp.mutez(0),
        c,
      )
