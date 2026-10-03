"""BRODelegator: the vault that holds ALL of the DEX's XTZ and delegates it
to the baker chosen by the DEX's LP holders.

- Voting power = LP shares. The DEX pushes every change in an LP's shares
  to the vault (`sync_shares`), so vote tallies never go stale.
- Anyone can call `update_delegate(candidate)`; it succeeds only if the
  candidate meets the quorum AND has strictly more votes than the
  current delegate.
- Baker rewards arrive as plain XTZ transfers. Anyone can call
  `harvest()` to credit the surplus (balance - accounted) to the DEX
  pool, which accrues to LPs when they redeem shares.

Deployment order:
   1. Originate BRODelegator(admin, quorum_bps)
   2. Originate BRODex(..., vault=<vault address>)
   3. Admin calls vault.set_dex(<dex address>)   (one-time, irreversible)

This is illustrative / educational code. Have it audited before using it
with real funds.
"""

import smartpy as sp
from .utils.common import t
from .utils.helper import helpers


@sp.module
def delegator():
  import t # type: ignore

  class BRODelegator(sp.Contract):
    """Holds the DEX's XTZ and delegates it to the baker LPs voted for."""

    def __init__(self, metadata, admin, quorum_bps):
      self.data.metadata = sp.cast(metadata, t.metadata)
      self.data.admin = admin
      self.data.dex = sp.cast(None, sp.option[sp.address])
      # share of total LP shares a candidate needs, in basis points
      self.data.quorum_bps = sp.cast(quorum_bps, sp.nat)
      # XTZ the DEX knows about (== dex.xtz_pool)
      self.data.accounted = sp.mutez(0)
      # mirror of the DEX's LP share ledger
      self.data.total_shares = sp.nat(0)
      self.data.shares = sp.cast(sp.big_map(), sp.big_map[sp.address, sp.nat])
      # LP -> baker they currently vote for
      self.data.votes = sp.cast(
        sp.big_map(), sp.big_map[sp.address, sp.key_hash]
      )
      # baker -> sum of the shares of LPs voting for them
      self.data.tally = sp.cast(sp.big_map(), sp.big_map[sp.key_hash, sp.nat])
      # baker the vault is currently delegated to
      self.data.delegate = sp.cast(None, sp.option[sp.key_hash])

    @sp.private(with_storage="read-write")
    def move_votes_(self, params):
      """Add and/or remove weight on one baker's tally."""
      sp.cast(
        params, sp.record(baker=sp.key_hash, add=sp.nat, remove=sp.nat)
      )
      current = self.data.tally.get(params.baker, default=0)
      self.data.tally[params.baker] = sp.as_nat(
        current + params.add - params.remove
      )

    # ------------------------------------------------------------------
    # Admin
    # ------------------------------------------------------------------
    @sp.entrypoint
    def set_dex(self, dex):
      """One-time link to the DEX contract (breaks the circular
      dependency at origination)."""
      sp.cast(dex, sp.address)
      assert sp.sender == self.data.admin, "NOT_ADMIN"
      assert not self.data.dex.is_some(), "DEX_ALREADY_SET"
      self.data.dex = sp.Some(dex)

    @sp.entrypoint
    def set_admin(self, new_admin):
      sp.cast(new_admin, sp.address)
      assert sp.sender == self.data.admin, "NOT_ADMIN"
      self.data.admin = new_admin

    @sp.entrypoint
    def set_quorum(self, new_quorum_bps):
      sp.cast(new_quorum_bps, sp.nat)
      assert sp.sender == self.data.admin, "NOT_ADMIN"
      assert new_quorum_bps <= 10000, "QUORUM_TOO_HIGH"
      self.data.quorum_bps = new_quorum_bps

    # ------------------------------------------------------------------
    # Called by the DEX only
    # ------------------------------------------------------------------
    @sp.entrypoint
    def deposit(self):
      """DEX forwards XTZ here for swaps / liquidity adds."""
      assert (
        sp.sender == self.data.dex.unwrap_some(error="DEX_NOT_SET")
      ), "NOT_DEX"
      self.data.accounted += sp.amount

    @sp.entrypoint
    def withdraw(self, params):
      """DEX asks the vault to pay XTZ straight to a user."""
      sp.cast(params, t.withdraw_params)
      assert (
        sp.sender == self.data.dex.unwrap_some(error="DEX_NOT_SET")
      ), "NOT_DEX"
      self.data.accounted -= params.amount
      if params.amount > sp.mutez(0):
        sp.send(params.to_, params.amount)

    @sp.entrypoint
    def sync_shares(self, params):
      """DEX reports an LP's new share balance. If the LP has voted, their
      baker's tally is adjusted by the difference."""
      sp.cast(params, t.sync_params)
      assert (
        sp.sender == self.data.dex.unwrap_some(error="DEX_NOT_SET")
      ), "NOT_DEX"
      old = self.data.shares.get(params.owner, default=0)
      if params.owner in self.data.votes:
        baker = self.data.votes[params.owner]
        self.move_votes_(sp.record(baker=baker, add=params.shares, remove=old))
      self.data.shares[params.owner] = params.shares
      self.data.total_shares = params.total_shares

    # ------------------------------------------------------------------
    # Voting
    # ------------------------------------------------------------------
    @sp.entrypoint
    def vote(self, baker):
      """LP holder votes for a baker (can be called again to change vote).
      Weight = the caller's LP shares, kept current by `sync_shares`."""
      sp.cast(baker, sp.key_hash)
      weight = self.data.shares.get(sp.sender, default=0)
      assert weight > 0, "NO_SHARES"
      if sp.sender in self.data.votes:
        old_baker = self.data.votes[sp.sender]
        self.move_votes_(sp.record(baker=old_baker, add=0, remove=weight))
      self.data.votes[sp.sender] = baker
      self.move_votes_(sp.record(baker=baker, add=weight, remove=0))

    @sp.entrypoint
    def withdraw_vote(self):
      assert sp.sender in self.data.votes, "NO_VOTE"
      weight = self.data.shares.get(sp.sender, default=0)
      old_baker = self.data.votes[sp.sender]
      self.move_votes_(sp.record(baker=old_baker, add=0, remove=weight))
      del self.data.votes[sp.sender]

    @sp.entrypoint
    def update_delegate(self, candidate):
      """Permissionless. Switch delegation to `candidate` if it has quorum
      and strictly more votes than the current delegate. The Tezos
      protocol itself rejects the call if `candidate` isn't a registered
      baker."""
      sp.cast(candidate, sp.key_hash)
      cand_votes = self.data.tally.get(candidate, default=0)
      assert cand_votes > 0, "NO_VOTES"
      assert (
        cand_votes * 10000 >= self.data.total_shares * self.data.quorum_bps
      ), "QUORUM_NOT_MET"
      if self.data.delegate.is_some():
        current = self.data.delegate.unwrap_some()
        assert candidate != current, "ALREADY_DELEGATE"
        assert cand_votes > self.data.tally.get(current, default=0), (
          "NOT_ENOUGH_VOTES"
        )
      self.data.delegate = sp.Some(candidate)
      sp.set_delegate(sp.Some(candidate))

    # ------------------------------------------------------------------
    # Rewards
    # ------------------------------------------------------------------
    @sp.entrypoint
    def default(self):
      """Accepts plain XTZ transfers (baker reward payouts, donations).
      They sit as surplus until someone calls `harvest`."""
      pass

    @sp.entrypoint
    def harvest(self):
      """Permissionless. Credits unaccounted XTZ (rewards) to the DEX pool
      so liquidity providers benefit when they redeem shares."""
      assert self.data.total_shares > 0, "POOL_NOT_INITIALIZED"
      assert sp.balance > self.data.accounted, "NOTHING_TO_HARVEST"
      surplus = sp.balance - self.data.accounted
      self.data.accounted += surplus
      dex = sp.contract(
        sp.mutez, self.data.dex.unwrap_some(error="DEX_NOT_SET"), "credit_rewards"
      ).unwrap_some(error="DEX_CREDIT_NOT_FOUND")
      sp.transfer(surplus, sp.mutez(0), dex)

    @sp.onchain_view()
    def get_delegate(self):
      return self.data.delegate

    @sp.onchain_view()
    def get_tally(self, baker):
      sp.cast(baker, sp.key_hash)
      return self.data.tally.get(baker, default=0)

    @sp.onchain_view()
    def get_vote(self, owner):
      sp.cast(owner, sp.address)
      return self.data.votes.get_opt(owner)


@sp.add_test()
def test_delegator():
  admin = sp.test_account("Admin")
  alice = sp.test_account("Alice")
  bob = sp.test_account("Bob")
  carol = sp.test_account("Carol")
  baker1 = sp.test_account("Baker1")
  baker2 = sp.test_account("Baker2")
  baker3 = sp.test_account("Baker3")
  # the simulator needs to know which key hashes are registered bakers
  bakers = {
    baker1.public_key_hash: 0,
    baker2.public_key_hash: 0,
    baker3.public_key_hash: 0,
  }
  b1 = baker1.public_key_hash
  b2 = baker2.public_key_hash
  b3 = baker3.public_key_hash

  scenario = sp.test_scenario("build/BRODelegator", [t, delegator, helpers])
  scenario.h1("BRODelegator")

  # 10% quorum
  vault = delegator.BRODelegator(metadata=sp.big_map(), admin=admin.address, quorum_bps=1000)
  scenario += vault
  dex = helpers.DexStub()
  scenario += dex

  def sync(owner, shares, total):
    dex.sync(
      sp.record(
        vault=vault.address, owner=owner.address, shares=shares, total_shares=total
      )
    )

  scenario.h2("Before the DEX is linked")
  dex.deposit(vault.address, _amount=sp.tez(1), _valid=False)  # DEX_NOT_SET
  vault.vote(b1, _sender=alice.address, _valid=False)  # NO_SHARES

  scenario.h2("Linking the DEX")
  vault.set_dex(dex.address, _sender=alice.address, _valid=False)  # NOT_ADMIN
  vault.set_dex(dex.address, _sender=admin.address)
  vault.set_dex(dex.address, _sender=admin.address, _valid=False)  # ALREADY_SET

  scenario.h2("Only the linked DEX can move funds / ledgers")
  vault.deposit(_sender=alice.address, _amount=sp.tez(1), _valid=False)
  vault.withdraw(
    sp.record(to_=alice.address, amount=sp.tez(1)),
    _sender=alice.address,
    _valid=False,
  )
  vault.sync_shares(
    sp.record(owner=alice.address, shares=1, total_shares=1),
    _sender=alice.address,
    _valid=False,
  )

  scenario.h2("Deposit / withdraw accounting")
  dex.deposit(vault.address, _amount=sp.tez(1_000))
  scenario.verify(vault.balance == sp.tez(1_000))
  scenario.verify(vault.data.accounted == sp.tez(1_000))
  dex.withdraw(
    sp.record(vault=vault.address, to_=alice.address, amount=sp.tez(100))
  )
  scenario.verify(vault.balance == sp.tez(900))
  scenario.verify(vault.data.accounted == sp.tez(900))
  # cannot withdraw more than is accounted for
  dex.withdraw(
    sp.record(vault=vault.address, to_=alice.address, amount=sp.tez(901)),
    _valid=False,
  )
  # zero-amount withdrawal is a harmless no-op (no zero-tez transfer)
  dex.withdraw(
    sp.record(vault=vault.address, to_=alice.address, amount=sp.mutez(0))
  )
  scenario.verify(vault.balance == sp.tez(900))

  scenario.h2("Share ledger mirror")
  sync(alice, 60, 100)
  sync(bob, 35, 100)
  sync(carol, 5, 100)
  scenario.verify(vault.data.shares[alice.address] == 60)
  scenario.verify(vault.data.total_shares == 100)

  scenario.h2("Voting")
  vault.vote(b1, _sender=admin.address, _valid=False)  # admin has no shares
  vault.withdraw_vote(_sender=alice.address, _valid=False)  # NO_VOTE
  vault.vote(b1, _sender=alice.address)
  vault.vote(b2, _sender=bob.address)
  vault.vote(b3, _sender=carol.address)
  scenario.verify(vault.data.tally[b1] == 60)
  scenario.verify(vault.data.tally[b2] == 35)
  scenario.verify(vault.data.tally[b3] == 5)

  # re-voting the same baker doesn't double count
  vault.vote(b1, _sender=alice.address)
  scenario.verify(vault.data.tally[b1] == 60)

  # changing a vote moves the whole weight
  vault.vote(b2, _sender=carol.address)
  scenario.verify(vault.data.tally[b3] == 0)
  scenario.verify(vault.data.tally[b2] == 40)
  vault.vote(b3, _sender=carol.address)
  scenario.verify(vault.data.tally[b2] == 35)
  scenario.verify(vault.data.tally[b3] == 5)

  scenario.h2("Delegation rules")
  # 5% < 10% quorum
  vault.update_delegate(
    b3, _sender=bob.address, _valid=False, _voting_powers=bakers
  )
  # no votes at all
  vault.update_delegate(
    sp.test_account("Nobody").public_key_hash,
    _sender=bob.address,
    _valid=False,
    _voting_powers=bakers,
  )
  # first delegate: baker1 (60 votes, quorum met)
  vault.update_delegate(b1, _sender=bob.address, _voting_powers=bakers)
  scenario.verify(vault.data.delegate == sp.Some(b1))
  scenario.verify(vault.baker == sp.Some(b1))
  # can't re-delegate to the incumbent
  vault.update_delegate(
    b1, _sender=bob.address, _valid=False, _voting_powers=bakers
  )
  # baker2 (35) < incumbent (60)
  vault.update_delegate(
    b2, _sender=bob.address, _valid=False, _voting_powers=bakers
  )

  scenario.h2("Share changes move votes automatically")
  # alice drops to 35 shares: baker1 and baker2 tie at 35 -> a tie is not enough
  sync(alice, 35, 75)
  scenario.verify(vault.data.tally[b1] == 35)
  scenario.verify(vault.data.total_shares == 75)
  vault.update_delegate(
    b2, _sender=bob.address, _valid=False, _voting_powers=bakers
  )
  # bob adds a little -> strictly more than the incumbent
  sync(bob, 36, 76)
  scenario.verify(vault.data.tally[b2] == 36)
  vault.update_delegate(b2, _sender=bob.address, _voting_powers=bakers)
  scenario.verify(vault.baker == sp.Some(b2))

  # a non-voter's share change leaves every tally untouched
  sync(admin, 1_000, 1_076)
  scenario.verify(vault.data.tally[b1] == 35)
  scenario.verify(vault.data.tally[b2] == 36)
  scenario.verify(vault.data.total_shares == 1_076)
  # ...but admin's later vote picks up their current weight
  vault.vote(b1, _sender=admin.address)
  scenario.verify(vault.data.tally[b1] == 1_035)

  scenario.h2("Withdrawing a vote")
  vault.withdraw_vote(_sender=admin.address)
  scenario.verify(vault.data.tally[b1] == 35)
  vault.withdraw_vote(_sender=admin.address, _valid=False)

  scenario.h2("Admin controls")
  vault.set_quorum(500, _sender=alice.address, _valid=False)
  vault.set_quorum(10_001, _sender=admin.address, _valid=False)
  vault.set_quorum(500, _sender=admin.address)
  scenario.verify(vault.data.quorum_bps == 500)
  # carol's 5 of 1,076 shares is now well under 5%
  vault.update_delegate(
    b3, _sender=bob.address, _valid=False, _voting_powers=bakers
  )
  vault.set_admin(alice.address, _sender=bob.address, _valid=False)
  vault.set_admin(alice.address, _sender=admin.address)
  vault.set_quorum(1000, _sender=admin.address, _valid=False)  # no longer admin
  vault.set_quorum(1000, _sender=alice.address)

  scenario.h2("Rewards: plain transfer -> harvest -> credited to the DEX")
  vault.harvest(_sender=bob.address, _valid=False)  # NOTHING_TO_HARVEST
  # a baker payout is just XTZ sent to the vault's default entrypoint
  vault.default(_sender=bob.address, _amount=sp.tez(50))
  scenario.verify(vault.balance == sp.tez(950))
  scenario.verify(vault.data.accounted == sp.tez(900))
  vault.harvest(_sender=carol.address)
  scenario.verify(dex.data.credited == sp.tez(50))
  scenario.verify(vault.data.accounted == sp.tez(950))
  scenario.verify(vault.balance == vault.data.accounted)
  vault.harvest(_sender=carol.address, _valid=False)  # already harvested
  # a second payout is harvested separately
  vault.default(_sender=bob.address, _amount=sp.mutez(1_234))
  vault.harvest(_sender=carol.address)
  scenario.verify(dex.data.credited == sp.tez(50) + sp.mutez(1_234))
