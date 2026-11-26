# The closure of the settlement of a portfolio's open legs in Percolator v16's engine (aeyakovenko/percolator 5e3af071,
# src/v16.rs): every function `MarketGroupV16ViewMut::settle_account_side_effects_not_atomic` reaches, found by
# following the calls in the source (not by name alone), layered bottom-up, with each function's callers and callees
# inside the closure, whether margin, trade, crank or liquidation reach it too, and whether the port has it. Prints the
# table of showcase/mainnet/percolator-v16/NOTES.md section 10 and the totals.
#
#   python3 -I scripts/percolator-v16-reference/settlement-map.py <pinned engine>/src/v16.rs > table.md
#   … <pinned engine>/src/v16.rs --margin     (section 11: the health certificates, ConvertReleasedPnl, Withdraw)
#   … <pinned engine>/src/v16.rs --trade <pinned program>/src/v16_program.rs     (section 12: TradeNoCpi)
#   … <pinned engine>/src/v16.rs --crank <pinned program>/src/v16_program.rs     (section 13: PermissionlessCrank)
#
# The pinned sources are data: this reads them as text and runs nothing from them.
#
# How a call is resolved: comments and items under cfg(test), cfg(kani) and the features the program's build leaves
# off (fuzz, audit-scan, …) are blanked first; each `fn` gets its owner (the type of the `impl` block around it);
# `self.f(` and `Self::f(` resolve to the owner's `f` (the two market views are one owner), `Type::f(` to that type's,
# a bare `f(` to the free function, and `x.f(` to the method of the type that field `x` has in the struct definitions
# when that is unique. What stays ambiguous (a method name several types define, on a receiver whose type the field
# table does not give: `as_view`, `get`, `is_empty`, `validate`, …) resolves to every candidate, an over-approximation
# of a few small accessors, listed by --ambiguous.
import json, re, sys
# A call: `self.f(`, `Self::f(`, `Type::f(`, `x.f(` or a bare `f(`; with `modules`, also `module::f(` (the program's
# inline modules `state`, `policy_v16`, `oracle_v16`, … whose functions are free functions of the one file).
CALL_ENGINE = r'(\bself\s*\.\s*|\bSelf\s*::\s*|\b([A-Z][A-Za-z0-9_]*)\s*::\s*|\.\s*|(?<![\w.:]))([a-z_][a-z0-9_]*)\s*(?:::<[^>]*>)?\s*\('
CALL_MODULES = r'(\bself\s*\.\s*|\bSelf\s*::\s*|\b([A-Z][A-Za-z0-9_]*)\s*::\s*|\.\s*|\b[a-z_][a-z0-9_]*\s*::\s*|(?<![\w.:]))([a-z_][a-z0-9_]*)\s*(?:::<[^>]*>)?\s*\('
def parse(path, modules=False):
    global s, fns, byname, FIELD, graph, lineof, CALL
    CALL = CALL_MODULES if modules else CALL_ENGINE
    src = open(path).read()
    def strip(s):
        out=[];i=0;n=len(s)
        while i<n:
            if s.startswith('//',i):
                j=s.find('\n',i); i=n if j<0 else j; continue
            if s.startswith('/*',i):
                d=1;i+=2
                while i<n and d:
                    if s.startswith('/*',i): d+=1;i+=2
                    elif s.startswith('*/',i): d-=1;i+=2
                    else:
                        out.append('\n' if s[i]=='\n' else ' '); i+=1
                continue
            c=s[i]
            if c=='"':
                j=i+1
                while j<n and s[j]!='"': j+=2 if s[j]=='\\' else 1
                out.append(s[i:j+1]); i=j+1; continue
            if c=="'" and i+2<n and (s[i+2]=="'" or s[i+1]=='\\'):
                j=s.find("'",i+2 if s[i+1]!='\\' else i+3); out.append(s[i:j+1]); i=j+1; continue
            out.append(c); i+=1
        return ''.join(out)
    s=strip(src)
    GATE=re.compile(r'#\[cfg\((?:test|kani|any\((?:test|kani|feature)[^\]]*\)|all\((?:test|kani)[^\]]*\)|feature\s*=\s*"(?:fuzz|kani|test-sbf|cu-audit|audit-scan|stress)")\)\]')
    def blank(s,a,b): return s[:a]+''.join('\n' if ch=='\n' else ' ' for ch in s[a:b])+s[b:]
    pos=0
    while True:
        m=GATE.search(s,pos)
        if not m: break
        j=m.end();depth=0;started=False
        while j<len(s):
            ch=s[j]
            if ch=='{': depth+=1;started=True
            elif ch=='}':
                depth-=1
                if started and depth==0: j+=1;break
            elif ch==';' and not started and depth==0: j+=1;break
            j+=1
        s=blank(s,m.start(),j); pos=m.start()+1
    s=re.sub(r'"(?:[^"\\]|\\.)*"',lambda m:'"'+''.join('\n' if ch=='\n' else ' ' for ch in m.group(0)[1:-1])+'"',s)
    lineof=lambda i: s.count('\n',0,i)+1
    # brace matching map
    def match(i):
        d=0;j=i
        while j<len(s):
            if s[j]=='{': d+=1
            elif s[j]=='}':
                d-=1
                if d==0: return j
            j+=1
    # impl blocks
    impls=[]
    for m in re.finditer(r'(?m)^\s*impl\b([^{;]*)\{',s):
        hdr=m.group(1)
        t=hdr.split(' for ')[-1] if ' for ' in hdr else hdr
        t=re.sub(r'^\s*<[^>]*>\s*','',t).strip()
        name=re.match(r'([A-Za-z_][A-Za-z0-9_]*)',t).group(1)
        a=m.end()-1;b=match(a)
        impls.append((a,b,name))
    fns={}  # key owner::name -> list of dict
    for m in re.finditer(r'\bfn\s+([a-z_][a-z0-9_]*)\s*(?:<[^>{(]*>)?\s*\(',s):
        i=s.find('{',m.end()); semi=s.find(';',m.end())
        if i<0: continue
        # declaration without body (trait)
        if 0<=semi<i:
            seg=s[m.end():semi]
            if '{' not in seg: continue
        b=match(i)
        owner='<free>'
        for a,bb,nm in impls:
            if a<m.start()<bb: owner=nm
        k=owner+'::'+m.group(1)
        fns.setdefault(k,[]).append(dict(start=lineof(m.start()),end=lineof(b),body=s[i:b+1]))
    byname={}
    for k in fns: byname.setdefault(k.split('::')[1],[]).append(k)
    VIEWS={'MarketGroupV16ViewMut','MarketGroupV16View'}
    FIELD={}
    for m in re.finditer(r'(?ms)^pub struct ([A-Za-z0-9_]+)(?:<[^>]*>)?\s*\{(.*?)^\}',s):
        for f in re.finditer(r'pub\s+([a-z_][a-z0-9_]*)\s*:\s*(?:&[^ ]*\s*)?(?:mut\s+)?\[?\s*([A-Za-z0-9_]+)',m.group(2)):
            FIELD.setdefault(f.group(1),set()).add(f.group(2))
    def recv_type(body,pos):
        # text before the '.' : last path segment
        j=pos
        t=body[max(0,j-80):j]
        t=re.sub(r'\[[^\[\]]*\]$','',t.rstrip())
        m=re.search(r'([a-z_][a-z0-9_]*)\s*$',t)
        if not m: return None
        ts=FIELD.get(m.group(1))
        if ts and len(ts)==1: return next(iter(ts))
        return None
    def resolve(owner,body):
        out=set();amb=[]
        for m in re.finditer(CALL,body):
            pre,typ,name=m.group(1),m.group(2),m.group(3)
            if name not in byname: continue
            cands=byname[name]
            if pre.startswith('self') or pre.startswith('Self'):
                own=[c for c in cands if c.split('::')[0]==owner or (owner in VIEWS and c.split('::')[0] in VIEWS)]
                if own: out.update(own); continue
                amb.append((name,cands)); out.update(cands); continue
            if typ:
                own=[c for c in cands if c.split('::')[0]==typ or (typ in VIEWS and c.split('::')[0] in VIEWS)]
                if own: out.update(own)
                continue
            if pre.strip()=='.' :
                rt=recv_type(body,m.start())
                if rt:
                    own=[c for c in cands if c.split('::')[0]==rt]
                    if own: out.update(own); continue
                meth=[c for c in cands if not c.startswith('<free>')]
                if len(meth)==1: out.update(meth)
                elif meth: amb.append((name,meth)); out.update(meth)
                continue
            free=[c for c in cands if c.startswith('<free>')]
            out.update(free)
        return out,amb
    graph={};ambs={}
    for k,v in fns.items():
        calls=set();a=[]
        for f in v:
            c,x=resolve(k.split('::')[0],f['body']); calls|=c; a+=x
        graph[k]=sorted(calls); ambs[k]=a
    graph = {}
    for k, v in fns.items():
        calls = set()
        for f in v:
            c, _ = resolve(k.split('::')[0], f['body']); calls |= c
        graph[k] = sorted(calls)


    return fns, graph

parse(sys.argv[1])

ROOT = 'MarketGroupV16ViewMut::settle_account_side_effects_not_atomic'
def closure(root, stop=()):
    seen = set(); st = [root]
    while st:
        f = st.pop()
        if f in seen: continue
        seen.add(f)
        if f in stop and f != root: continue
        st += graph.get(f, [])
    return seen
C = closure(ROOT)
OTHER = {'M': 'MarketGroupV16ViewMut::compute_account_health_cert_with_price_override',
         'T': 'MarketGroupV16ViewMut::execute_trade_with_fee_loss_stale_scoped_not_atomic',
         'C': 'MarketGroupV16ViewMut::permissionless_auto_crank_not_atomic',
         'L': 'MarketGroupV16ViewMut::liquidate_account_not_atomic'}
ALSO = {c: closure(r, stop={ROOT}) for c, r in OTHER.items()}

# Ported before this table was made: the closures of the engine functions the earlier handlers ported whole.
BEFORE_ROOTS = ['PortfolioV16View::validate_with_market', 'PortfolioV16ViewMut::validate_with_market', 'MarketGroupV16View::validate_shape',
    'MarketGroupV16ViewMut::validate_shape', 'MarketGroupV16ViewMut::settle_negative_pnl_from_principal_core_not_atomic',
    'MarketGroupV16ViewMut::set_asset_state', 'PortfolioV16ViewMut::compact_source_domains', 'MarketGroupV16ViewMut::validate_source_domain_ledger',
    'MarketGroupV16ViewMut::validate_configured_asset_index', 'MarketGroupV16ViewMut::domain_asset_side',
    'MarketGroupV16ViewMut::apply_total_delta', 'MarketGroupV16ViewMut::apply_total_delta_u64']
BEFORE = set().union(*[closure(r) for r in BEFORE_ROOTS])
# Ported in showcase/mainnet/percolator-v16/kernels.ts and compared on host vectors (keep this list current).
NOW = set('''apply_backing_utilization_fee_charge mul_div_floor_u128_or_wide mul_div_ceil_u128_or_wide
source_credit_lien_amounts_for_effective source_lien_backing_release_for_face_burn source_lien_fee_after_backing_release
source_lien_face_burn_partition source_lien_face_burn_plan crystallize_source_lien_fee_for_effective kernel_settle_kf_stale_cohort
prepare_source_credit_domain_recompute_for_epoch prepare_source_credit_domain_recompute_for_epoch_steps
prepare_source_positive_claim_burn_delta source_claim_domain_first_burn_partition kernel_settle_positive_face_after_support
kernel_recompute_resolved_payout_rate kernel_credit_post_snapshot_residual kernel_advance_leg_b_snap kernel_normalize_social_loss_carry
kernel_begin_full_drain_reset prepare_counterparty_lien_create_delta prepare_counterparty_backing_add_delta
prepare_counterparty_backing_expiry_delta prepare_counterparty_lien_terminal_release_delta prepare_counterparty_lien_consume_delta
prepare_insurance_lien_consume_delta prepare_insurance_lien_create_delta prepare_insurance_lien_release_delta
prepare_insurance_lien_terminal_release_delta source_credit_state_realizable_support_for_claim_num
backing_utilization_rate_e9_for_source_state backing_utilization_fee_quote_atoms_for_lien account_kf_settlement_plan_key
decode_account_kf_settlement_plan_key scaled_adl_delta_fast f_snap_after_settlement f_snap_residual_is_sub_atom
haircut_effective_support asset_is_loss_stale_at_slot asset_contributes_to_loss_stale_summary kf_target_for_leg_from_asset
b_target_for_leg_from_asset leg_kf_delta_components_for_settlement_from_asset account_b_settlement_chunk_from_leg
leg_has_exhausted_effective_oi'''.split())
# Ported in showcase/mainnet/percolator-v16/primitives.ts and impairment.ts and compared on generated markets and
# portfolios (keep current).
PRIMITIVES = set('''source_domain_slot source_domain source_domain_slot_or_insert source_domain_mut_or_insert
reset_source_domain_slot_if_empty has_pending_residual insurance_to_close_insurance_spent validate_insurance_to_close_insurance_spent
domain_budget_remaining_parts update_source_credit_aggregate_totals update_backing_aggregate_totals backing_provider_earnings_total
source_fresh_backing_total_atoms residual junior_claim_bound insurance_domain_index source_credit_for_domain stored_source_credit_rate_num
provider_principal_num loser_paid_backing_num backing_bucket_raw_status_expiry_for_domain reservation_encumbrance_proof_for_domain_parts
fresh_counterparty_backing_expiry_slot account_source_claim_bound_sum_num account_has_source_claims source_claim_unliened_num
domain_insurance_budget_spent slot_unliened_claim_num has_b_stale_leg active_leg_slot_for_asset require_active_leg_slot_for_asset
active_leg_for_asset asset_state pending_domain_loss_barrier_count is_sparse_tail_default set_source_credit_for_domain
release_provider_principal_after adjust_provider_principal_num add_loser_paid_counterparty_backing_unchecked
add_loser_paid_counterparty_backing_payments_unchecked set_backing_bucket_for_domain validate_source_domain_ledger_current
recompute_source_credit_domain_after_mutation recompute_source_credit_domain_after_mutations refresh_source_credit_domain_after_mutation
reservation_encumbrance_proof_for_domain add_fresh_counterparty_backing_unchecked add_fresh_counterparty_backing_steps_unchecked
expire_source_backing_bucket_not_atomic credit_post_snapshot_residual_not_atomic
release_source_credit_lien_from_counterparty_terminal_not_atomic consume_source_credit_lien_from_counterparty_core_not_atomic
release_source_credit_lien_from_insurance_core_not_atomic release_source_credit_lien_from_insurance_terminal_not_atomic
kf_loss_lien_backing_to_consume_num source_credit_available_backing_num set_insurance_reservation_for_domain
set_domain_insurance_spent_delta set_domain_insurance_spent_core create_and_consume_source_credit_from_counterparty_core_not_atomic
create_and_consume_source_credit_from_counterparty_parts_not_atomic create_and_consume_source_credit_from_insurance_core_not_atomic
create_and_consume_source_credit_from_insurance_parts_not_atomic ensure_account_source_claim_market_id add_account_u128_counter
face_claim_to_burn_for_support twin_loser_paid_share_num loss_bucket_accepts_fresh resolved_loss_backing_capacity_num
collect_account_backing_utilization_fee_for_domain_not_atomic has_pending_domain_loss_barrier
prepare_account_counterparty_lien_impairment prepare_counterparty_impaired_lien_retirement_delta
release_or_retire_counterparty_lien_backing_not_atomic retire_source_credit_lien_from_counterparty_impaired_not_atomic
burn_impaired_account_source_claim_fields impair_account_source_credit_counterparty_lien_fields
reconcile_account_impaired_counterparty_liens_not_atomic reconcile_account_impaired_counterparty_lien_at_slot_not_atomic'''.split())
# Ported in claims.ts, kfsettle.ts and settlement.ts (layers 4 to 7) and wired into SyncMaintenanceFee and Withdraw (keep
# current).
SETTLEMENT = set('''decrement_account_source_claim_for_domain_not_atomic burn_account_source_lien_face_not_atomic
burn_account_source_claim_bound_num burn_account_source_claim_at_slot_up_to burn_account_source_claim_bound_num_domain_first
source_domain_prospective_support_for_face consume_source_domain_credit_for_effective_not_atomic
consume_validated_account_source_credit_not_atomic set_account_pnl set_account_pnl_with_source
set_account_pnl_after_source_claim_burn set_account_pnl_after_kf_loss_claim_burn
set_account_pnl_after_domain_first_source_claim_burn set_account_pnl_inner record_account_funding_flow
settle_kf_loss_before_support_not_atomic net_slot_face_at_par_not_atomic cancel_loss_domain_face_at_par_not_atomic
pay_kf_loss_from_free_capital_not_atomic apply_haircut_bounded_close_loss_to_pnl apply_signed_kf_delta_to_pnl
reserve_new_capital_backed_loss_for_source_domain_not_atomic book_kf_loss_support_for_source_domain_not_atomic
book_realized_kf_loss_for_source_domain_not_atomic prepare_account_kf_settlement_entry apply_account_kf_settlement_entry
begin_full_drain_reset_inner b_target_for_leg mark_account_b_stale clear_account_b_stale mark_leg_b_stale
account_b_settlement_chunk settle_account_b_chunk settle_account_kf_effects_not_atomic
settle_account_side_effects_not_atomic'''.split())
# Engine functions outside the settlement's closure ported with earlier instructions (accrual.ts, engine.ts,
# refresh.ts: the asset accrual, the stored-target setter, the fee sync and charge, the insurance-budget credits).
EARLIER = set('''accrue_asset_to_not_atomic accrual_activity_for_asset_segment kernel_mark_kf_stale_cohorts
kernel_adl_scaled_accrual_index_deltas require_asset_accruable checked_i128_mul add_non_min_i128
set_asset_raw_oracle_target_not_atomic set_asset_raw_oracle_targets_not_atomic sync_account_fee_to_slot_not_atomic
account_fee_anchor_for_loss_currentness charge_account_fee_current_not_atomic credit_domain_insurance_budget_not_atomic
credit_domain_insurance_budgets_not_atomic set_domain_insurance_budget_core set_domain_insurance_budget_delta'''.split())
# Ported with TradeNoCpi and ConvertReleasedPnl (health.ts, trade.ts, trading.ts, convert.ts; keep current).
TRADE_ENGINE = set('''account_haircut_equity account_has_loss_stale_live_leg account_no_positive_credit_equity
account_source_realizable_support account_touches_pending_domain_loss_barrier accrue_asset_path_to_not_atomic
active_bitmap_clear active_bitmap_is_empty active_bitmap_set active_bitmap_with_cleared
add_open_interest_for_new_position adjust_u128 all_pass apply_account_source_credit_lien_delta
apply_current_position_delta_with_lookup apply_position_delta_with_lookup_inner
apply_trade_after_refresh_not_atomic asset_has_target_effective_lag asset_is_loss_stale asset_risk_increase_gate
attach_leg_at_slot begin_close_progress_ledger begin_terminal_trade_residual_if_needed begin_zero_oi_residue_resets
build_trade_request_guard_summary can_ignore_unrelated_loss_stale_for_trade canonical_accrual_price_step_v16
charge_account_backing_fee_not_atomic checked_fee_bps clear_account_stale clear_leg clear_leg_at_slot_inner
clear_leg_inner collect_account_backing_utilization_fees_not_atomic compute_account_health_cert_with_price_override
create_account_source_credit_lien_for_effective_any_not_atomic
create_account_source_credit_lien_for_effective_unchecked create_initial_margin_source_lien_if_needed
create_source_credit_lien_backing_not_atomic create_source_credit_lien_from_counterparty_core_not_atomic
create_source_credit_lien_from_insurance_core_not_atomic drop_unowned_side_oi effective_abs_quantity_for_leg
ensure_favorable_action_current_certificate ensure_initial_margin ensure_no_positive_credit_initial_margin
ensure_source_domain_capacity_for_new_exposure execute_batch_with_fee_after_tail_validation_not_atomic
execute_batch_with_fee_loss_stale_scoped_not_atomic execute_trade_with_fee_loss_stale_scoped_not_atomic
finish_trade_checks_not_atomic from_account h_lock_lane health_cert_after_capital_debit
health_requirements_from_base_and_target_lag health_requirements_from_notional_and_target_lag
increased_initial_margin_principal incremental_initial_margin_source_credit_needed
initial_margin_requirement_for_abs_q is_finalized_inert kernel_adl_effective_quantity_ceil kernel_attach_leg
kernel_cert_is_current kernel_classify_position_delta kernel_clear_leg kernel_initial_margin_gate
kernel_is_prior_reset_obligation kernel_locked_margin_gate kernel_position_route_requires_unit_adl
kernel_raw_basis_for_adl_effective_quantity kernel_resize_leg_same_side kernel_retain_leg_as_pending_obligation
kernel_should_clear_prior_reset_obligation kernel_trade_preexisting_oi_reduction_gate kernel_trade_side_oi_cap_gate
kf_epoch_for_leg_from_asset leg_f_snap_is_settled leg_is_prior_reset_obligation leg_kf_epoch_is_current
liquidation_uncovered_loss_after_principal loss_stale_trade_scope_allowed margin_requirement
pending_domain_loss_barrier_blocks_position_change plan_delta position_change_touches_pending_domain_loss_barrier
recertify_account_after_source_lien_change recertify_account_after_trade_delta
refresh_account_and_certify_not_atomic require_asset_mark_pushable require_asset_risk_change_allowed
require_position_route_adl_safe resize_leg_same_side_at_slot risk_notional_ceil
same_side_risk_reduction_or_flat_obligation set_pending_domain_loss_barrier_count
settle_account_for_position_action_and_refresh_not_atomic signed_position source_domain_capacity_after_admission
source_lien_effective_reserved_supporting target_effective_lag_adverse_delta target_effective_lag_loss_penalty
terminal_trade_residual_asset_before_refresh trade_account_requires_initial_margin trade_fee_notional_ceil
trade_notional_floor trade_preflight_risk_gate trade_signed_size_deltas transfer_account_residual_reward_credit
transfer_trade_residual_reward_credit try_to_runtime uncovered_loss_remains_with_open_risk
valid_source_lien_effective_reserved_sum validate_account_scalar_preflight validate_basis_or_zero
validate_trade_position_preflight validate_trade_request validate_unconfigured_market_tail'''.split())
# Reached by the closure only through `refresh_account_and_certify_not_atomic`'s B-chunk branch (`allow_b_chunk`, the
# crank's) or the batch's `!recertify_after_fill`; TradeNoCpi passes neither, and the port has no code for them yet.
NOT_FROM_TRADE = set('''certify_account_after_local_settlement_with_price_override
expire_first_lapsed_source_backing_for_account_not_atomic first_lapsed_latent_source_backing_for_account_at_slot
first_lapsed_roster_source_backing_for_account_at_slot first_lapsed_source_backing_for_account_at_slot
kernel_lapsed_source_backing_scan_step'''.split())
# In place: the token-value proof a charge forms (it balances by construction), the audit scan (Ok in the program's
# build), the batch accumulation of one fill (no effect).
TRADE_IN_PLACE = set('''account_capital_to_insurance accumulate_batch_trade_apply kernel_accumulate_batch_trade validate_shape_audit_scan'''.split())
# Ported with ConvertReleasedPnl (convert.ts; keep current).
CONVERT = set('''kernel_released_pnl_conversion_partition support_to_account_capital account_has_source_liens
account_has_active_exposure_for_source_domain account_has_active_source_claim_exposure account_has_target_effective_lag
apply_released_pnl_conversion_with_consumption_core_not_atomic apply_released_pnl_conversion_core_not_atomic
ensure_favorable_action_allowed convert_released_pnl_to_capital_core_not_atomic preflight_convert_released_pnl_to_capital
convert_released_pnl_to_capital_not_atomic'''.split())
# The processor's functions TradeNoCpi reaches that the port has (keep current).
PROGRAM_PORTED = set('''accepted_reported_trade_price_view account account_fees_to_trade_sides
accrue_zero_move_funding_before_position_change_for_profile_view advance_funding_mark_checkpoint_view amount_to_u64
apply_backing_domain_fees_after_trade_view asset_segment_dt_view authenticated_market_slot_or_fallback_view
backing_domain_parts_view backing_fee_policy_for_domain_view backing_trade_fee_policy_shape_ok
bump_portfolio_position_epoch bump_portfolio_position_epoch_with_matcher_state
canonical_accrual_path_for_target_view ceil_div_u128 charge_account_backing_domain_fees_view check_header
clamp_mark_to_supported_move_bps clamp_toward_engine_dt collect_backing_domain_fees_for_account_view
collect_maintenance_fee_before_trade_view collect_maintenance_fee_to_slot_before_value_debit_view
collected_fee_supported_mark collected_fee_supported_mark_view contains credit_fee_to_domain_budget_view
credit_maintenance_fee_to_active_market_budgets_view credit_market_insurance_budget_view
credit_trade_fees_to_market_budgets_view credit_trade_fees_with_mark_externality_view decode_market_mode
domain_fee_add effective_price_from_target ensure_new_counterparty_backed_liens_fresh_for_trade_view
ensure_new_source_lien_domains_full_rate_for_trade_view ensure_portfolio_storage_for_market_slots
ensure_source_credit_full_rate_for_domain_view ensure_source_domain_growth_within_wrapper_bound
ensure_source_lien_refresh_work_within_wrapper_bound ensure_trade_delta_source_domain_capacity_view
ensure_trade_portfolio_current_for_requests_view ensure_trade_portfolios_current_for_requests_view
ensure_trade_side_oi_cap_view ensure_valid_reported_trade_price ewma_effective_alpha_bps ewma_update expect_owner
expect_portfolio_id expect_portfolio_position_binding expect_portfolio_view_account_key expect_portfolio_view_owner
expect_signer expect_writable fee_bps_for_two_sided_fee_paid fee_share_floor funding_rate_from_checkpoint_view
global_or_profile_resolve_matured_at_slot handle_trade_nocpi handle_trade_nocpi_zero_copy
hybrid_trade_fee_quote_view market_group_view_from_state market_header market_slot_capacity
market_view_mut_with_fee_carry mul_div_u128_by_u64 next_portfolio_position_control
next_portfolio_position_control_for_matcher_sync pending_zero_move_funding_requires_crank_view
permissionless_resolve_matured_for_profile_at_slot permissionless_stale_matured
portfolio_account_len_for_market_slots portfolio_has_active_asset_view portfolio_view_mut_for_market_slots
position_epoch premium_funding_rate_e9 prepare_trade_driven_mark_target_view price_move_bps_ceil
price_move_remainder_bps_num_view profile_hybrid_soft_stale_matured profile_is_auth_mark profile_is_ewma_mark
profile_is_hybrid profile_is_price_managed profile_updates_mark_from_trade_view push_reserved
read_market_config_mode_and_capacity read_oracle_profile_from_view read_portfolio_id read_portfolio_position_epoch
read_u16 read_u64 read_wrapper_config_from_bytes record_funding_mark_transition_view
reject_permissionless_resolve_matured_live_for_profile_view reserved_source_domains_snapshot_for_trade_view
reset_price_move_remainder_on_target_change_view risk_notional_ceil set_price_move_remainder_bps_num_view
signed_position_for_asset_view source_counterparty_backing_snapshot_view source_credit_has_live_amounts
source_lien_effective_reserved_snapshot_for_trade_view source_lien_refresh_work_view sparse_domain_value_lookup
split stage_trade_driven_mark_target_view stored_mark_target_for_zero_move_accrual_view
trade_delta_may_require_source_domain_capacity trade_delta_reduces_existing
trade_fee_budgeted_amounts_with_mark_externality_view trade_fee_cap_bps trade_fee_notional_ceil
two_sided_trade_fee_paid update_hybrid_mark_after_trade_view valid_engine_oracle_price validate
validate_asset_oracle_profile validate_market_dynamic_len validate_wrapper_config write_oracle_profile_to_view
write_portfolio_matcher_expiry write_wrapper_config write_wrapper_config_to_bytes
zero_move_funding_path_for_profile_view'''.split())
# Ported with PermissionlessCrank (keep current): the processor's functions and the engine's.
CRANK_PROGRAM_DONE = '''from map_v16_error accrue_asset_to_not_atomic compose_price_e6 authenticated_slot_or_fallback mirror_oracle_profile_to_base_config read_external_price_e6_profile permissionless_resolve_matured_now_view reject_non_base_oracle_update_after_global_resolve_matured credit_market_fee_split_across_domains_view hybrid_target_for_crank_view collect_maintenance_fee_before_value_debit_view liquidation_penalty_reclaimable_from_profile_view permissionless_funding_rate_e9_view required_market_resolve_accrual_for_profile_view reject_incomplete_asset_health_observation_view reject_incomplete_account_health_observations_view handle_permissionless_crank_zero_copy handle_permissionless_crank derive_vault_authority canonical_vault_address expect_key verify_token_program unpack_token_account is_withdrawable_collateral_mint require_token_balance transfer_tokens_signed verify_withdrawable_token_accounts handle_close_resolved'''.split()
CRANK_ENGINE_DONE = '''account_b_loss_bound account_has_normalizable_source_credit_lien actionable_summary_from_signals advance_close_progress_ledger advance_pending_close_residual_not_atomic apply_bankruptcy_residual_chunk_to_loss_side apply_position_delta apply_position_delta_with_lookup auto_crank_selected_assets available_domain_insurance bankruptcy_residual_single_step_capacity begin_legless_asset_resets begin_side_reset_if_effective_oi_exhausted book_bankruptcy_residual_chunk_for_account_core book_bankruptcy_residual_chunk_internal build_actionable_summary_and_selected_assets build_actionable_summary_at_slot certify_account_after_local_settlement_with_price_override charge_account_fee_after_loss_settlement charge_account_fee_not_atomic checked_mul_div_ceil_to_u128 clamp_close_residual_to_account_loss consume_domain_insurance_for_negative_pnl credit_account_from_insurance_delta credit_account_from_insurance_not_atomic declare_permissionless_recovery ensure_close_progress_not_expired ensure_open_close_snapshot_current_or_recovery expire_first_lapsed_source_backing_for_account_not_atomic first_lapsed_latent_source_backing_for_account_at_slot first_lapsed_roster_source_backing_for_account_at_slot first_lapsed_source_backing_for_account_at_slot highest_risk_liquidatable_asset insurance_capital_to_account_capital kernel_advance_close_ledger kernel_auto_crank_leg_flags kernel_auto_crank_lifecycle_dispatchable kernel_auto_crank_refresh_asset kernel_b_settlement_pending kernel_bresidual_step kernel_commit_declared_liquidation_recovery kernel_consume_insurance_layer kernel_flat_source_lien_normalization kernel_lapsed_source_backing_scan_step kernel_live_account_refresh_required kernel_live_flat_source_lien_normalization_required kernel_live_liquidation_required kernel_open_close_snapshot_is_stale kernel_principal_cure_close_ledger kernel_recovery_pending_obligation_release_allowed kernel_reduce_position_delta kernel_refresh_detached_selected_leg kernel_settle_resolved_pnl_after_booking kernel_social_loss_chunk_cap kernel_unilateral_close_capacity liquidate_account_not_atomic liquidation_engine_close_request_q liquidation_fee_for_close liquidation_fee_from_raw_fee liquidation_leg_maintenance_requirement liquidation_partial_close_is_healthy liquidation_partial_search_hi liquidation_progress_from_scores liquidation_projected_health_deficit_from_parts liquidation_projected_healthy_after_close liquidation_remaining_active_bitmap_after_close liquidation_residual_after_principal_and_insurance liquidation_residual_exceeds_single_step_capacity liquidation_risk_notional_ceil min_abs_q_for_risk_notional_at_least permissionless_auto_crank_not_atomic permissionless_crank_not_atomic position_delta_lookup_for_asset position_delta_touches_pending_domain_loss_barrier preflight_liquidation_residual_durability prepare_counterparty_lien_release_delta recovery_pending_obligation_release_allowed reduce_matching_open_interest_for_unilateral_close reduce_position refresh_recovery_account_from_committed_state_not_atomic release_account_source_credit_liens_if_unneeded_core_not_atomic release_source_credit_lien_from_counterparty_core_not_atomic require_asset_live_reducible risk_score_unchecked select_auto_crank_plan social_loss_book_split strictly_reduces_from unilateral_close_capacity validate_liquidation_progress_from_score finalize_side_reset_not_atomic
v16_domain_pair_for_asset_index kernel_retain_terminal_source_haircut kernel_resolved_receipt_can_still_gain kernel_advance_resolved_slot
is_empty_for_dematerialization apply_resolved_payout_receipt_payment capital_and_resolved_payout_to_external_out
release_account_source_credit_lien_for_domain_not_atomic kf_target_for_leg side_mode_for remaining_effective_oi_for_leg
resolved_bankruptcy_attribution clear_resolved_unattributed_negative_pnl settle_negative_pnl_from_principal_not_atomic
resolved_positive_payout_ready recompute_resolved_payout_rate resolved_receipt_claimable_against_ledger resolve_market_not_atomic
source_claim_whole_atom_conversion expire_one_lapsed_source_backing_for_resolved_active_leg_not_atomic
forfeit_loss_backing_capacity_atoms fraction_ge kernel_forfeit_residual_step first_lapsed_source_backing_for_asset_at_slot
retain_leg_as_pending_obligation clear_forfeited_leg initialize_resolved_payout_ledger_if_needed resolved_receipt_claimable_now
advance_resolved_slot_not_atomic resolved_receipt_can_still_gain source_claim_converts_to_zero_unpledged
prepare_one_source_domain_for_resolved_close_not_atomic refine_resolved_unreceipted_bound_not_atomic leg_is_dead_for_forfeit
settle_forfeited_leg_kf_effects retain_recovery_loss_weight_before_detach create_resolved_payout_receipt_if_needed
clear_fully_diluted_resolved_receipt_if_terminal source_domain_terminal_for_haircut_demote
detach_solvent_active_legs_for_resolved_close realize_one_source_domain_for_resolved_close_not_atomic
settle_resolved_bankruptcy_negative_pnl forfeit_recovery_leg_not_atomic close_resolved_account_not_atomic'''.split()
# Compiled out of the program's build (the audit-scan feature is off: `Ok(())`), so the port has no code for them.
NO_CODE = {'validate_account_audit_scan'}
# Conversions the port has no code for: it works on the account bytes in place.
VIEWS_ONLY = re.compile(r'::(from_runtime|encode_\w+|as_view|engine_slot|engine_slot_mut|new|get|empty|debit|credit)$')

# Topological height (the closure has no recursion).
H = {}
def height(k):
    if k not in H:
        H[k] = -1
        H[k] = max([height(c) + 1 for c in graph.get(k, []) if c in C and c != k] + [0])
    return H[k]
for k in C: height(k)

NAMES = {1: 'Leaf arithmetic, accessors and validation', 2: 'Backing and lien primitives', 3: 'Impaired-lien reconciliation',
         4: 'Source-claim burns and the PnL setters', 5: 'K/F settlement entries', 6: 'B chunks', 7: 'The side-effects driver'}
def concept(k):
    n = k.split('::')[1]
    if k == ROOT or n == 'settle_account_kf_effects_not_atomic': return 7
    if re.search(r'^settle_account_b_chunk$|^account_b_settlement_chunk$|^mark_leg_b_stale|^mark_account_b_stale|^clear_account_b_stale|^b_target_for_leg$', n): return 6
    if re.search(r'kf_settlement_entry|apply_signed_kf|haircut_bounded|capital_backed|settle_kf_loss_before|book_kf_loss_support|book_realized_kf|pay_kf_loss|net_slot_face|cancel_loss_domain|begin_full_drain_reset_inner|record_account_funding_flow', n): return 5
    if re.search(r'^burn_account_source|^set_account_pnl(?!_after_principal)|^decrement_account_source_claim|^consume_validated_account_source_credit|^consume_source_domain_credit_for_effective|source_domain_prospective_support', n): return 4
    if re.search(r'^reconcile_account_impaired|^prepare_account_counterparty_lien_impairment|^impair_account_source_credit|^retire_source_credit_lien_from_counterparty_impaired|^prepare_counterparty_impaired_lien_retirement|^release_or_retire_counterparty_lien_backing|^burn_impaired_account_source_claim_fields', n): return 3
    if H[k] >= 5 or (re.search(r'not_atomic|^set_|^release|^retire|^consume|^create|^adjust|^add_|^recompute|^refresh_|^ensure_|_or_insert|reset_source_domain|kf_loss_lien_backing|loss_bucket_accepts|twin_loser|resolved_loss_backing_capacity|face_claim_to_burn', n) and fns[k][0]['start'] > 5400): return 2
    return 1
lay = {k: concept(k) for k in C}
changed = True
while changed:  # a caller is never below its callee
    changed = False
    for k in C:
        for c in graph.get(k, []):
            if c in C and lay[c] > lay[k]:
                print(f'note: {k} raised to layer {lay[c]} (calls {c})', file=sys.stderr); lay[k] = lay[c]; changed = True

def status(k):
    if k in BEFORE: return 'before'
    if k.split('::')[1] in NOW: return 'kernels'
    if k.split('::')[1] in PRIMITIVES: return 'primitives'
    if k.split('::')[1] in SETTLEMENT: return 'settlement'
    if VIEWS_ONLY.search(k) or k.split('::')[1] in NO_CODE: return 'in place'
    return 'remaining'
callers = {k: set() for k in C}
for k in C:
    for c in graph.get(k, []):
        if c in C and c != k: callers[c].add(k)
short = lambda k: k.split('::')[1]
def disp(k):
    o, n = k.split('::')
    if o == '<free>': return n
    o = o.replace('MarketGroupV16ViewMut', 'Group').replace('MarketGroupV16View', 'GroupView').replace('PortfolioV16ViewMut', 'PortfolioMut').replace('PortfolioV16View', 'Portfolio')
    return f'{o}::{n}'
size = lambda k: sum(x['end'] - x['start'] + 1 for x in fns[k])
def cut(xs):
    t = ', '.join(xs) or '–'
    return t if len(t) <= 160 else t[:157].rsplit(',', 1)[0] + ', …'
totals = []
for i in range(1, 8):
    ks = sorted([k for k in C if lay[k] == i], key=lambda k: fns[k][0]['start'])
    by = {s: [k for k in ks if status(k) == s] for s in ('before', 'kernels', 'primitives', 'settlement', 'in place', 'remaining')}
    totals.append((i, len(ks), sum(map(size, ks)), {s: (len(v), sum(map(size, v))) for s, v in by.items()}))
    print(f'\n#### Layer {i}: {NAMES[i]}\n')
    print('| Function | Lines | Status | Also | Callers in the closure | Callees in the closure |')
    print('| --- | --- | --- | --- | --- | --- |')
    for k in ks:
        also = ''.join(c for c in 'MTCL' if k in ALSO[c]) or '–'
        lines = ', '.join(f"{x['start']}–{x['end']}" for x in fns[k])
        print(f'| `{disp(k)}` | {lines} ({size(k)}) | {status(k)} | {also} | {cut(sorted(short(c) for c in callers[k]))} | {cut(sorted(short(c) for c in graph.get(k, []) if c in C and c != k))} |')
print('\n| Layer | | Functions | Lines | Ported before | kernels.ts | primitives.ts, impairment.ts | claims.ts, kfsettle.ts, settlement.ts | In place (no code) | Remaining |')
print('| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
t = {s: [0, 0] for s in ('before', 'kernels', 'primitives', 'settlement', 'in place', 'remaining')}
for i, n, l, st in totals:
    print(f"| {i} | {NAMES[i]} | {n} | {l} | " + ' | '.join(f'{st[s][0]} / {st[s][1]}' for s in t) + ' |')
    for s in t: t[s][0] += st[s][0]; t[s][1] += st[s][1]
print(f"| | Total | {len(C)} | {sum(map(size, C))} | " + ' | '.join(f'{t[s][0]} / {t[s][1]}' for s in t) + ' |')

# --margin: the closure of the margin and health certificates (`compute_account_health_cert_with_price_override`) and of
# ConvertReleasedPnl's engine call (`convert_released_pnl_to_capital_not_atomic`) and of Withdraw's
# (`withdraw_not_atomic`), less what the port has (any status above but "remaining"), layered by call height (0: calls
# nothing new). Printed after the table above.
if '--margin' in sys.argv:
    roots = {'health': 'MarketGroupV16ViewMut::compute_account_health_cert_with_price_override',
             'convert': 'MarketGroupV16ViewMut::convert_released_pnl_to_capital_not_atomic',
             'withdraw': 'MarketGroupV16ViewMut::withdraw_not_atomic'}
    # Withdraw's own code, ported whole in refresh.ts (`withdrawEngine`) with its helpers written inline there.
    WITHDRAW = {'withdraw_not_atomic', 'account_equity_from_parts', 'active_bitmap_is_empty', 'is_finalized_inert', 'account_capital_to_external_out'}
    have = lambda k: k in C and status(k) != 'remaining' or k in BEFORE or short(k) in NOW | PRIMITIVES | SETTLEMENT | WITHDRAW | TRADE_ENGINE | CONVERT or VIEWS_ONLY.search(k)
    M = set().union(*[closure(r) for r in roots.values()])
    new = {k for k in M if not have(k)}
    HM = {}
    def hm(k):
        if k not in HM:
            HM[k] = -1
            HM[k] = max([hm(c) + 1 for c in graph.get(k, []) if c in new and c != k] + [0])
        return HM[k]
    for k in new: hm(k)
    reach = {n: closure(r) for n, r in roots.items()}
    print(f'\n#### Margin, health certificates, ConvertReleasedPnl and Withdraw: {len(M)} functions reached, {len(M) - len(new)} ported, {len(new)} new ({sum(map(size, new))} lines)\n')
    print('| Height | Function | Lines | Reached from |')
    print('| ---: | --- | --- | --- |')
    for k in sorted(new, key=lambda k: (HM[k], fns[k][0]['start'])):
        lines = ', '.join(f"{x['start']}–{x['end']}" for x in fns[k])
        print(f"| {HM[k]} | `{disp(k)}` | {lines} ({size(k)}) | {', '.join(n for n in roots if k in reach[n])} |")
    print('\n| Height | Functions | Lines |\n| ---: | ---: | ---: |')
    for h in sorted(set(HM.values())):
        ks = [k for k in new if HM[k] == h]
        print(f'| {h} | {len(ks)} | {sum(map(size, ks))} |')

# --trade <program>/src/v16_program.rs: what TradeNoCpi reaches beyond the port. The processor's closure of
# `handle_trade_nocpi` in the program (its own functions, with the engine entry points each calls), then the engine's
# closure of those entry points (`execute_trade_with_fee_loss_stale_scoped_not_atomic` and the accrual, fee and
# insurance calls the processor makes around it), each less what the port has, by call height. "Also" says what else
# reaches an engine function: B BatchTradeNoCpi (`execute_batch_with_fee_loss_stale_scoped_not_atomic`, which the
# single trade calls with one request, and through it TradeCpi and BatchTradeCpi), L liquidation, C the crank, M the
# health certificate.
if '--trade' in sys.argv:
    E_fns, E_graph = fns, graph
    engine_names = {k.split('::')[1] for k in E_fns if k.split('::')[0] in {'MarketGroupV16ViewMut', 'MarketGroupV16View', 'V16Core'}}
    def heights(new, g):
        H = {}
        def h(k):
            if k not in H:
                H[k] = -1
                H[k] = max([h(c) + 1 for c in g.get(k, []) if c in new and c != k] + [0])
            return H[k]
        for k in new: h(k)
        return H
    prog = sys.argv[sys.argv.index('--trade') + 1]
    parse(prog, modules=True)
    P = closure('<free>::handle_trade_nocpi')
    pnew = set(P)
    pstatus = lambda k: 'ported' if short(k) in PROGRAM_PORTED else 'remaining'
    HP = heights(pnew, graph)
    def engine_calls(k):
        out = set()
        for f in fns[k]:
            for m in re.finditer(r'\.\s*([a-z_][a-z0-9_]*)\s*\(', f['body']):
                if m.group(1) in engine_names and m.group(1) not in byname: out.add(m.group(1))
        return sorted(out)
    entries = set().union(*[engine_calls(k) for k in P])
    P_fns, P_size = fns, size
    print(f'\n#### TradeNoCpi, the processor: {len(P)} functions reached ({sum(map(size, P))} lines), {sum(1 for k in P if pstatus(k) == "ported")} ported\n')
    print('| Height | Function | Lines | Engine calls | Status |')
    print('| ---: | --- | --- | --- | --- |')
    for k in sorted(pnew, key=lambda k: (HP[k], fns[k][0]['start'])):
        lines = ', '.join(f"{x['start']}–{x['end']}" for x in fns[k])
        print(f"| {HP[k]} | `{disp(k)}` | {lines} ({size(k)}) | {cut(engine_calls(k))} | {pstatus(k)} |")
    print('\n| Height | Functions | Lines |\n| ---: | ---: | ---: |')
    for h in sorted(set(HP.values())):
        ks = [k for k in pnew if HP[k] == h]
        print(f'| {h} | {len(ks)} | {sum(map(size, ks))} |')
    fns, graph = E_fns, E_graph
    roots = sorted(k for k in E_fns if k.split('::')[1] in entries and k.split('::')[0] in {'MarketGroupV16ViewMut', 'MarketGroupV16View', 'V16Core'})
    have = lambda k: k in C and status(k) != 'remaining' or k in BEFORE or short(k) in NOW | PRIMITIVES | SETTLEMENT | EARLIER or VIEWS_ONLY.search(k)
    T = set().union(*[closure(r) for r in roots]); new = {k for k in T if not have(k)}
    tstatus = lambda k: 'ported' if short(k) in TRADE_ENGINE else 'in place' if short(k) in TRADE_IN_PLACE else 'not from TradeNoCpi' if short(k) in NOT_FROM_TRADE else 'remaining'
    HT = heights(new, graph)
    oth = {'B': closure('MarketGroupV16ViewMut::execute_batch_with_fee_loss_stale_scoped_not_atomic'), 'L': closure(OTHER['L']),
           'C': closure(OTHER['C']), 'M': closure(OTHER['M'])}
    print(f'\n#### TradeNoCpi, the engine: entry points {", ".join(short(r) for r in roots)}; {len(T)} functions reached, {len(T) - len(new)} ported, {len(new)} new ({sum(map(size, new))} lines)\n')
    print('| Height | Function | Lines | Also | Status |')
    print('| ---: | --- | --- | --- | --- |')
    for k in sorted(new, key=lambda k: (HT[k], fns[k][0]['start'])):
        lines = ', '.join(f"{x['start']}–{x['end']}" for x in fns[k])
        print(f"| {HT[k]} | `{disp(k)}` | {lines} ({size(k)}) | {''.join(c for c in oth if k in oth[c]) or '–'} | {tstatus(k)} |")
    print('\n| Height | Functions | Lines | Shared with BatchTradeNoCpi | with liquidation | with the crank |\n| ---: | ---: | ---: | ---: | ---: | ---: |')
    for h in sorted(set(HT.values())):
        ks = [k for k in new if HT[k] == h]
        print(f"| {h} | {len(ks)} | {sum(map(size, ks))} | {sum(1 for k in ks if k in oth['B'])} | {sum(1 for k in ks if k in oth['L'])} | {sum(1 for k in ks if k in oth['C'])} |")
    print(f"| | {len(new)} | {sum(map(size, new))} | {sum(1 for k in new if k in oth['B'])} | {sum(1 for k in new if k in oth['L'])} | {sum(1 for k in new if k in oth['C'])} |")
    for s in ('ported', 'in place', 'not from TradeNoCpi', 'remaining'):
        ks = [k for k in new if tstatus(k) == s]
        print(f'\n{s}: {len(ks)} functions, {sum(map(size, ks))} lines', end='')
    print()

# --crank <program>/src/v16_program.rs: what PermissionlessCrank reaches beyond the port, as --trade does for TradeNoCpi:
# the processor's closure of `handle_permissionless_crank`, then the engine's closure of the entry points it calls, less
# what the port has. Each new engine function is attributed to the crank's actions that reach it (the engine plan's arms
# and the processor's own engine calls; a function several reach is listed under each, the totals count it once), so
# that the map says where a cut can fall.
if '--crank' in sys.argv:
    E_fns, E_graph = fns, graph
    engine_names = {k.split('::')[1] for k in E_fns if k.split('::')[0] in {'MarketGroupV16ViewMut', 'MarketGroupV16View', 'V16Core'}}
    def heights(new, g):
        H = {}
        def h(k):
            if k not in H:
                H[k] = -1
                H[k] = max([h(c) + 1 for c in g.get(k, []) if c in new and c != k] + [0])
            return H[k]
        for k in new: h(k)
        return H
    prog = sys.argv[sys.argv.index('--crank') + 1]
    parse(prog, modules=True)
    P_fns, P_graph = fns, graph
    CRANK_PROGRAM_PORTED = PROGRAM_PORTED | set(CRANK_PROGRAM_DONE)
    P = closure('<free>::handle_permissionless_crank')
    RESOLVED_P = closure('<free>::handle_close_resolved') - closure('<free>::handle_permissionless_crank_zero_copy')
    pstatus = lambda k: ('ported' if short(k) in CRANK_PROGRAM_PORTED else 'remaining')
    HP = heights(set(P), graph)
    def engine_calls(k):
        out = set()
        for f in fns[k]:
            for m in re.finditer(r'\.\s*([a-z_][a-z0-9_]*)\s*\(', f['body']):
                if m.group(1) in engine_names and m.group(1) not in byname: out.add(m.group(1))
        return sorted(out)
    entries = set().union(*[engine_calls(k) for k in P])
    print(f'\n#### PermissionlessCrank, the processor: {len(P)} functions reached ({sum(map(size, P))} lines), {sum(1 for k in P if pstatus(k) == "ported")} ported\n')
    print('| Height | Function | Lines | Engine calls | Status |')
    print('| ---: | --- | --- | --- | --- |')
    for k in sorted(P, key=lambda k: (HP[k], fns[k][0]['start'])):
        lines = ', '.join(f"{x['start']}–{x['end']}" for x in fns[k])
        print(f"| {HP[k]} | `{disp(k)}` | {lines} ({size(k)}) | {cut(engine_calls(k))} | {pstatus(k)} |")
    print('\n| Status | Functions | Lines |\n| --- | ---: | ---: |')
    for st in ('ported', 'remaining'):
        ks = [k for k in P if pstatus(k) == st]
        print(f'| {st} | {len(ks)} | {sum(map(size, ks))} |')
    fns, graph = E_fns, E_graph
    roots = sorted(k for k in E_fns if k.split('::')[1] in entries and k.split('::')[0] in {'MarketGroupV16ViewMut', 'MarketGroupV16View', 'V16Core'})
    have = lambda k: (k in C and status(k) != 'remaining' or k in BEFORE or short(k) in NOW | PRIMITIVES | SETTLEMENT | EARLIER
                      | TRADE_ENGINE | CONVERT | TRADE_IN_PLACE or VIEWS_ONLY.search(k))
    T = set().union(*[closure(r) for r in roots]); new = {k for k in T if not have(k)}
    G = 'MarketGroupV16ViewMut::'
    ACTIONS = [
        ('plan', 'the plan: the actionable summary, the selector, the riskiest liquidatable asset',
         [G + 'build_actionable_summary_and_selected_assets', 'V16Core::select_auto_crank_plan', G + 'highest_risk_liquidatable_asset',
          'V16Core::kernel_auto_crank_refresh_asset', G + 'auto_crank_selected_assets']),
        ('observe', 'the observation: accrual at the observed price, the stored target',
         [G + 'accrue_asset_to_not_atomic', G + 'accrue_asset_path_to_not_atomic', G + 'set_asset_raw_oracle_target_not_atomic']),
        ('fee', 'the maintenance fee and the fee split', [G + 'sync_account_fee_to_slot_not_atomic', G + 'credit_domain_insurance_budget_not_atomic']),
        ('refresh', 'Refresh: the refresh and certificate with B chunks and lapsed backing',
         [G + 'refresh_account_and_certify_not_atomic', 'V16Core::kernel_refresh_detached_selected_leg']),
        ('obligation', 'a released reset obligation: clear_leg and the residue resets', [G + 'clear_leg', G + 'begin_zero_oi_residue_resets']),
        ('settle_b', 'SettleBChunk', [G + 'settle_account_b_chunk']),
        ('release', 'ReleaseSourceLiens', [G + 'release_account_source_credit_liens_if_unneeded_core_not_atomic']),
        ('liquidate', 'Liquidate: liquidation, its fees, loss socialisation and ADL',
         [G + 'liquidate_account_not_atomic', 'V16Core::kernel_commit_declared_liquidation_recovery']),
        ('reward', "the cranker's reward", [G + 'credit_account_from_insurance_not_atomic']),
        ('close', 'AdvanceClose', [G + 'advance_pending_close_residual_not_atomic']),
        ('recover', 'DeclareRecovery', [G + 'declare_permissionless_recovery']),
        ('recovery', 'a market in Recovery: forfeits, recovery refresh, resolution',
         [G + 'forfeit_recovery_leg_not_atomic', G + 'resolve_market_not_atomic', G + 'refresh_recovery_account_from_committed_state_not_atomic']),
        ('resolved', 'a Resolved market (CloseResolved)',
         [G + 'advance_resolved_slot_not_atomic', G + 'close_resolved_account_not_atomic', G + 'resolved_receipt_can_still_gain',
          G + 'resolved_receipt_claimable_now', G + 'first_lapsed_source_backing_for_asset_at_slot', G + 'claim_resolved_payout_topup_not_atomic']),
    ]
    reach = {a: set().union(*[closure(r) for r in rs if r in fns]) for a, _, rs in ACTIONS}
    HT = heights(new, graph)
    acts = lambda k: [a for a, _, _ in ACTIONS if k in reach[a]]
    oth = {'B': closure('MarketGroupV16ViewMut::execute_batch_with_fee_loss_stale_scoped_not_atomic'),
           'R': closure('MarketGroupV16ViewMut::rebalance_reduce_position_not_atomic') if 'MarketGroupV16ViewMut::rebalance_reduce_position_not_atomic' in fns else set(),
           'F': closure('MarketGroupV16ViewMut::finalize_reset_side_not_atomic') if 'MarketGroupV16ViewMut::finalize_reset_side_not_atomic' in fns else set()}
    print(f'\n#### PermissionlessCrank, the engine: {len(roots)} entry points; {len(T)} functions reached, {len(T) - len(new)} ported, {len(new)} new ({sum(map(size, new))} lines)\n')
    print('| Height | Function | Lines | Actions | Also | Status |')
    print('| ---: | --- | --- | --- | --- | --- |')
    cstatus = lambda k: 'ported' if short(k) in CRANK_ENGINE_DONE else 'remaining'
    for k in sorted(new, key=lambda k: (HT[k], fns[k][0]['start'])):
        lines = ', '.join(f"{x['start']}–{x['end']}" for x in fns[k])
        print(f"| {HT[k]} | `{disp(k)}` | {lines} ({size(k)}) | {', '.join(acts(k)) or '–'} | {''.join(c for c in oth if k in oth[c]) or '–'} | {cstatus(k)} |")
    print('\n| Action | | Functions reached that are new | Lines | Only this action |\n| --- | --- | ---: | ---: | ---: |')
    for a, label, _ in ACTIONS:
        ks = [k for k in new if k in reach[a]]
        only = [k for k in ks if acts(k) == [a]]
        print(f'| {a} | {label} | {len(ks)} | {sum(map(size, ks))} | {len(only)} / {sum(map(size, only))} |')
    print(f"| | total (each once) | {len(new)} | {sum(map(size, new))} | |")
    for st in ('ported', 'remaining'):
        ks = [k for k in new if cstatus(k) == st]
        print(f'\n{st}: {len(ks)} functions, {sum(map(size, ks))} lines', end='')
    print()
    print(f"\nshared with RebalanceReduce: {sum(1 for k in new if k in oth['R'])}; with FinalizeResetSide: {sum(1 for k in new if k in oth['F'])}; with BatchTradeNoCpi: {sum(1 for k in new if k in oth['B'])}")

    # The recovery and resolution instructions whose engine entry points the crank's closure covers: their processors'
    # functions beyond the crank's, and the engine functions they reach beyond the port and the crank.
    TERMINAL_PROGRAM_DONE = set('''handle_forfeit_recovery_leg with_one_portfolio_view accrue_zero_move_funding_before_position_change_view
read_oracle_profile_from_view write_oracle_profile_to_view handle_resolve_market handle_resolve_stale_permissionless resolve_market_view
reject_market_resolve_before_committed_accrual_view read_oracle_profile_unchecked_from_view require_asset_generation_frontier_view
expect_live_authority require_authority_epoch_view'''.split())
    fns, graph = P_fns, P_graph
    crank_engine = T
    print('\n#### ForfeitRecoveryLeg, CloseResolved, ResolveMarket, ResolveStalePermissionless\n')
    print('| Instruction | Processor functions beyond the crank\'s | Lines | Ported | Engine functions beyond the port and the crank | Lines |')
    print('| --- | ---: | ---: | ---: | ---: | ---: |')
    for name, root in (('ForfeitRecoveryLeg', 'handle_forfeit_recovery_leg'), ('CloseResolved', 'handle_close_resolved'),
                       ('ResolveMarket', 'handle_resolve_market'), ('ResolveStalePermissionless', 'handle_resolve_stale_permissionless')):
        fns, graph = P_fns, P_graph
        Q = closure('<free>::' + root) - set(P) | ({'<free>::' + root} if root == 'handle_close_resolved' else set())
        Q = {k for k in Q if k in fns}
        done = [k for k in Q if short(k) in CRANK_PROGRAM_PORTED | TERMINAL_PROGRAM_DONE]
        ent = set().union(*[engine_calls(k) for k in Q]) if Q else set()
        qlines = sum(map(size, Q))
        fns, graph = E_fns, E_graph
        rts = [k for k in E_fns if k.split('::')[1] in ent and k.split('::')[0] in {'MarketGroupV16ViewMut', 'MarketGroupV16View', 'V16Core'}]
        ET = set().union(*[closure(r) for r in rts]) if rts else set()
        extra = {k for k in ET if not have(k) and k not in crank_engine and short(k) not in CRANK_ENGINE_DONE}
        print(f'| {name} | {len(Q)} | {qlines} | {len(done)} | {len(extra)} | {sum(map(size, extra))} |')
        for k in sorted(extra): print(f'|  | | | | `{disp(k)}` | {size(k)} |')
