(** 
   This file implement the TZIP-12 protocol (a.k.a FA2) for FT on Tezos
   copyright Wulfman Corporation 2021
*)

#import "../contracts/common/errors.mligo" "Errors"
#import "../contracts/common/address.mligo" "Address"
#import "../contracts/common/operators.mligo" "Operators"
#import "../contracts/common/tokenMetadata.mligo" "TokenMetadata"
#import "../contracts/common/ledger.mligo" "Ledger"

type token_id = nat
type 'a t = {
   ledger         : Ledger.t;
   operators      : Operators.t;
   token_ids      : token_id list;
   token_metadata : TokenMetadata.t;
   token_supply   : (token_id, nat) big_map;
   extension      : 'a;
}

let assert_token_exist (type a) (s:a t) (token_id : nat) : unit  = 
   let _ = Option.unopt_with_error (Big_map.find_opt token_id s.token_metadata)
      Errors.undefined_token in
   ()

let set_ledger (type a) (s:a t) (ledger:Ledger.t) = {s with ledger = ledger}

let get_operators (type a) (s:a t) = s.operators
let set_operators (type a) (s:a t) (operators:Operators.t) = {s with operators = operators}

let set_token_metadata (type a) (s:a t) (token_metadata:TokenMetadata.t) = {s with token_metadata = token_metadata}

let set_token_ids (type a) (s:a t) (token_ids:token_id list) = {s with token_ids = token_ids}

let set_token_supply (type a) (s:a t) (token_supply:(token_id, nat) big_map) = {s with token_supply = token_supply}

let get_balance (type a) (s:a t) (owner : Address.t) (token_id : nat) : nat =
   let () = assert_token_exist s token_id in 
   Ledger.get_balance s.ledger owner token_id

let get_total_supply (type a) (s:a t) (token_id : nat) : nat =
   let () = assert_token_exist s token_id in
   match Big_map.find_opt token_id s.token_supply with
      Some sup -> sup
   |  None     -> 0n
