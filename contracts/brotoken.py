import smartpy as sp
from smartpy.templates import fa2_lib as fa2

main = fa2.main

@sp.module
def brobuilder():
  import main

  class BROToken(
    main.Fungible,
    main.OnchainviewBalanceOf,
  ):
    def __init__(self, contract_metadata, ledger, token_metadata):

      # Initialize on-chain balance view
      main.OnchainviewBalanceOf.__init__(self)

      # Initialize fungible token base class
      main.Fungible.__init__(self, contract_metadata, ledger, token_metadata)


def _get_balance(fa2_contract, args):
  """Utility function to call the contract's get_balance view to get an account's token balance."""
  return sp.View(fa2_contract, "get_balance")(args)


def _total_supply(fa2_contract, args):
  """Utility function to call the contract's total_supply view to get the total amount of tokens."""
  return sp.View(fa2_contract, "total_supply")(args)


@sp.add_test()
def test():
  # Create and configure the test scenario
  scenario = sp.test_scenario("fa2_lib_fungible", brobuilder)

  owner_address = sp.address("tz1gxC2235naymQo8Rcyc4kwC4vaoXJrkz9R")

  # Define initial token metadata
  tok0_md = fa2.make_metadata(name="Token Zero", decimals=0, symbol="Tok0")

  # Define tokens and initial owners
  initial_ledger = {
    (owner_address, 0): 10,
  }

  # Instantiate the FA2 fungible token contract
  contract = brobuilder.BROToken(sp.big_map(), initial_ledger, [tok0_md])

  # Originate the contract in the test scenario
  scenario += contract
