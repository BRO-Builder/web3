(** 
   This file implement the TZIP-12 protocol (a.k.a FA2) for FT on Tezos
   copyright Wulfman Corporation 2021
*)

#import "errors.mligo" "Errors"
#import "address.mligo" "Address"

type token_id = nat
type owner    = Address.t
type balance_ = nat

(* Unlike the NFT ledger (token_id -> single owner), the FT ledger maps each
   (owner, token_id) pair to the amount that owner holds of that token. A
   missing entry is treated as a balance of 0. *)
type t = ((owner * token_id), balance_) big_map

let get_balance (ledger : t) (owner : owner) (token_id : token_id) : balance_ =
   match Big_map.find_opt (owner, token_id) ledger with
      Some b -> b
   |  None   -> 0n

let set_balance (ledger : t) (owner : owner) (token_id : token_id) (balance_ : balance_) : t =
   (* drop zero-balance entries so the ledger doesn't accumulate empty keys *)
   if balance_ = 0n
   then Big_map.remove (owner, token_id) ledger
   else Big_map.update (owner, token_id) (Some balance_) ledger

let decrease_balance (ledger : t) (owner : owner) (token_id : token_id) (amount : nat) : t =
   let current = get_balance ledger owner token_id in
   let ()      = assert_with_error (current >= amount) Errors.ins_balance in
   set_balance ledger owner token_id (abs (current - amount))

let increase_balance (ledger : t) (owner : owner) (token_id : token_id) (amount : nat) : t =
   let current = get_balance ledger owner token_id in
   set_balance ledger owner token_id (current + amount)

let transfer_token_from_user_to_user (ledger : t) (token_id : token_id) (from_ : owner) (to_ : owner) (amount : nat) : t =
   let ledger = decrease_balance ledger from_ token_id amount in
   let ledger = increase_balance ledger to_   token_id amount in
   ledger
