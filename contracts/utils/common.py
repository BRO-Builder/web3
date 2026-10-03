"""Shared types for the BRO DEX and BRODelegator contracts.

Both contracts import this module so the cross-contract call parameters
(withdraw / sync_shares) and the FA2 transfer types are defined once.
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

  # DEX -> vault: pay XTZ out of the vault
  withdraw_params: type = sp.record(to_=sp.address, amount=sp.mutez)

  # DEX -> vault: an LP's share balance changed
  sync_params: type = sp.record(
    owner=sp.address, shares=sp.nat, total_shares=sp.nat
  )
