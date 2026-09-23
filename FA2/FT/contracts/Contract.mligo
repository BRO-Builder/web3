
#import "common/errors.mligo" "Errors"
#import "common/address.mligo" "Address"
#import "common/ledger.mligo" "Ledger"
#import "common/tokenMetadata.mligo" "TokenMetadata"
#import "common/FT.mligo" "FT"
#import "common/operators.mligo" "Operators"
#import "../storages/Storage.mligo" "Storage"

(*
   Specialization corner
*)

module TokenUsage = struct 
   type token_id = nat
   type t = (token_id, nat) big_map

   (* tracks cumulative volume (sum of amounts) transferred per token_id *)
   let update_usage_token (usage : t) (token_id : token_id) (amount : nat) : t = 
      match Big_map.find_opt token_id usage with
      | None -> (failwith("This token is not initialized in usage map") : t)
      | Some old -> Big_map.update token_id (Some (old + amount)) usage 

   let get_token_usage (token_id : nat) (tu : t) =
      match Big_map.find_opt token_id tu with
         Some data -> data
      | None -> failwith Errors.undefined_token
end

type extension = {
   admin : Address.t;
   token_usage : TokenUsage.t;
}

type storage = Storage.t

let set_usage (s:extension storage) (usage:TokenUsage.t) =
   let e = s.extension in
   let e = { e with token_usage = usage } in
   {s with extension =e }

let get_usage_of (s:extension storage) (token_id : Storage.token_id) : nat =
   match (Big_map.find_opt token_id s.extension.token_usage) with
   | None -> (failwith(Errors.undefined_token) : nat)
   | Some nb_trsfr -> nb_trsfr

let authorize_extension (s:extension storage): unit =
   assert_with_error (Tezos.get_sender () = s.extension.admin) Errors.only_admin

let transfer_extension (t: FT.transfer) (s:extension storage): operation list * extension storage =
   let process_atomic_usage (usage, t:TokenUsage.t * FT.atomic_trans) = TokenUsage.update_usage_token usage t.token_id t.amount in
   let update_usage_single_transfer (usage, t:TokenUsage.t * FT.transfer_from ) = List.fold process_atomic_usage t.tx usage in
   let usage = List.fold update_usage_single_transfer t s.extension.token_usage in
   let s = set_usage s usage in
   ([]: operation list),s


(* Each mint item credits `amount` units of `token_id` to `owner`. If the
   token_id doesn't exist yet, its metadata is pulled from `metas` and it is
   registered as a new token; if it already exists, `metas` is ignored for it
   and its supply/ledger balance are simply increased. *)
type mint_item = [@layout:comb] {
   token_id : Storage.token_id;
   owner    : Address.t;
   amount   : nat;
}

type mint_param = [@layout:comb] {
   items : mint_item list;
   metas : (Storage.token_id, (string, bytes) map) big_map
}

let mint (param: mint_param) (s: extension storage) : operation list * extension storage =
   let process_item (acc, item : (Ledger.t * TokenMetadata.t * (Storage.token_id, nat) big_map * Storage.token_id list) * mint_item) =
      let (ledger, metadata, supply, ids) = acc in
      let {token_id; owner; amount} = item in
      let metadata, ids =
         match Big_map.find_opt token_id metadata with
         | Some _ -> metadata, ids (* token already registered: keep its existing metadata *)
         | None ->
            let token_info = match Big_map.find_opt token_id param.metas with
            | None -> (failwith("Missing token_info") : (string, bytes) map)
            | Some ti -> ti
            in
            let data : TokenMetadata.data = {token_id=token_id; token_info=token_info} in
            (Big_map.add token_id data metadata, token_id :: ids)
      in
      let ledger  = Ledger.increase_balance ledger owner token_id amount in
      let current = match Big_map.find_opt token_id supply with Some sup -> sup | None -> 0n in
      let supply  = Big_map.update token_id (Some (current + amount)) supply in
      (ledger, metadata, supply, ids)
   in
   let init = (s.ledger, s.token_metadata, s.token_supply, s.token_ids) in
   let (ledger, metadata, supply, ids) = List.fold process_item param.items init in
   ([]: operation list), { s with ledger=ledger; token_metadata=metadata; token_supply=supply; token_ids=ids }



type parameter = [@layout:comb] 
| Transfer of FT.transfer
| Balance_of of FT.balance_of 
| Update_operators of FT.update_operators 
| Mint of mint_param

[@entry]
[@inline]
let main (p :parameter) (s : extension storage) : operation list * extension storage = 
match p with
   Transfer         p -> let o1, s = FT.transfer p s in
                         let o2, s = transfer_extension p s in
                         let o = List.fold_left (fun ((a,x):operation list * operation) -> x :: a) o2 o1 in
                         o, s
|  Balance_of       p -> FT.balance_of p s
|  Update_operators p -> FT.update_ops p s
|  Mint             p -> let _ = authorize_extension s in 
                         mint p s

[@view] let token_usage (p : nat) (s : extension storage): nat =
      TokenUsage.get_token_usage p s.extension.token_usage

[@view] let get_balance (p : Address.t * nat) (s : extension storage) : nat = 
      let (owner, token_id) = p in
      let balance_ = Storage.get_balance s owner token_id in
      balance_

[@view] let total_supply (token_id : nat) (s : extension storage) :  nat =
      Storage.get_total_supply s token_id

[@view] let all_tokens (_ : unit) (s : extension storage) : nat list =
   s.token_ids
   
[@view] let is_operator (op : FT.operator) (s : extension storage) : bool =
      Operators.is_operator (s.operators, op.owner, op.operator, op.token_id)

[@view] let token_metadata (p : nat) (s : extension storage) : TokenMetadata.data = 
      TokenMetadata.get_token_metadata p s.token_metadata
