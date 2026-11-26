// A harness module compiled INTO A COPY of the pinned engine crate (aeyakovenko/percolator 5e3af071, Apache-2.0)
// inside a Docker container, never into the sources on disk: scripts/percolator-v16-reference/kernels.ts appends
//
//     #[path = "/harness/typesol_harness.rs"] pub mod typesol_harness;
//
// to the copy's src/v16.rs and `pub use v16::typesol_harness;` to its src/lib.rs. As a child module of `v16` it can
// call the engine's private functions and associated functions (Rust privacy is per module and its descendants), so
// no visibility in the engine is changed. It only decodes its inputs, calls one engine function and encodes the
// result; every computation is the engine's own.
//
// Inputs: a function id, eight 16-byte little-endian arguments, and a 2,020-byte scratch holding, in this order, an
// EngineAssetSlotV16Account (1,333), a PortfolioLegV16Account (152), a PortfolioSourceDomainV16Account (196), a
// ResolvedPayoutLedgerV16Account (90) and a V16ConfigAccount (249). A function that takes a struct by value gets it
// decoded from the scratch, field by field without the static validation of `try_to_runtime` (the port's functions
// work on the bytes and are compared on states the validators would refuse too); an enum or bool byte that does not
// decode answers `Decode` and the vector is not a comparison. On success the returned struct is encoded back where it
// came from (what each caller does with the value it gets back), and the caller sees the changed bytes.
use super::*;

pub const SCRATCH_LEN: usize = 2020;
const SLOT: core::ops::Range<usize> = 0..1333;
const LEG: core::ops::Range<usize> = 1333..1485;
const SOURCE: core::ops::Range<usize> = 1485..1681;
const LEDGER: core::ops::Range<usize> = 1681..1771;
const CONFIG: core::ops::Range<usize> = 1771..2020;

/// What a call answers: outputs (raw u128 bit patterns, two's complement for signed ones), an engine error, or an
/// input that does not decode.
pub enum Answer {
    Ok([u128; 6], usize),
    Err(V16Error),
    Decode,
}

fn u(a: &[u8; 16]) -> u128 {
    u128::from_le_bytes(*a)
}
fn i(a: &[u8; 16]) -> i128 {
    i128::from_le_bytes(*a)
}
fn u64a(a: &[u8; 16]) -> u64 {
    u(a) as u64
}

fn side(v: u128) -> Option<SideV16> {
    match v {
        0 => Some(SideV16::Long),
        1 => Some(SideV16::Short),
        _ => None,
    }
}
fn boolean(b: u8) -> Option<bool> {
    match b {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    }
}

fn source_credit(a: &SourceCreditStateV16Account) -> SourceCreditStateV16 {
    SourceCreditStateV16 {
        positive_claim_bound_num: a.positive_claim_bound_num.get(),
        exact_positive_claim_num: a.exact_positive_claim_num.get(),
        fresh_reserved_backing_num: a.fresh_reserved_backing_num.get(),
        spent_backing_num: a.spent_backing_num.get(),
        provider_receivable_num: a.provider_receivable_num.get(),
        valid_liened_backing_num: a.valid_liened_backing_num.get(),
        impaired_liened_backing_num: a.impaired_liened_backing_num.get(),
        insurance_credit_reserved_num: a.insurance_credit_reserved_num.get(),
        valid_liened_insurance_num: a.valid_liened_insurance_num.get(),
        impaired_liened_insurance_num: a.impaired_liened_insurance_num.get(),
        credit_rate_num: a.credit_rate_num.get(),
        credit_epoch: a.credit_epoch.get(),
    }
}
fn bucket(a: &BackingBucketV16Account) -> Option<BackingBucketV16> {
    Some(BackingBucketV16 {
        market_id: a.market_id.get(),
        fresh_unliened_backing_num: a.fresh_unliened_backing_num.get(),
        valid_liened_backing_num: a.valid_liened_backing_num.get(),
        consumed_liened_backing_num: a.consumed_liened_backing_num.get(),
        impaired_liened_backing_num: a.impaired_liened_backing_num.get(),
        utilization_fee_earnings: a.utilization_fee_earnings.get(),
        expiry_slot: a.expiry_slot.get(),
        status: decode_backing_bucket_status(a.status).ok()?,
    })
}
fn reservation(a: &InsuranceCreditReservationV16Account) -> InsuranceCreditReservationV16 {
    InsuranceCreditReservationV16 {
        insurance_credit_reserved_num: a.insurance_credit_reserved_num.get(),
        valid_liened_insurance_num: a.valid_liened_insurance_num.get(),
        impaired_liened_insurance_num: a.impaired_liened_insurance_num.get(),
        consumed_insurance_num: a.consumed_insurance_num.get(),
        source_credit_epoch: a.source_credit_epoch.get(),
    }
}
fn leg(a: &PortfolioLegV16Account) -> Option<PortfolioLegV16> {
    Some(PortfolioLegV16 {
        active: boolean(a.active)?,
        asset_index: a.asset_index.get(),
        market_id: a.market_id.get(),
        side: decode_side(a.side).ok()?,
        basis_pos_q: a.basis_pos_q.get(),
        a_basis: a.a_basis.get(),
        k_snap: a.k_snap.get(),
        f_snap: a.f_snap.get(),
        kf_epoch_snap: a.kf_epoch_snap.get(),
        epoch_snap: a.epoch_snap.get(),
        loss_weight: a.loss_weight.get(),
        b_snap: a.b_snap.get(),
        b_rem: a.b_rem.get(),
        b_epoch_snap: a.b_epoch_snap.get(),
        b_stale: boolean(a.b_stale)?,
        stale: boolean(a.stale)?,
    })
}

struct Scratch<'a> {
    slot: &'a mut EngineAssetSlotV16Account,
    leg: &'a mut PortfolioLegV16Account,
    source: &'a mut PortfolioSourceDomainV16Account,
    ledger: &'a mut ResolvedPayoutLedgerV16Account,
    config: &'a mut V16ConfigAccount,
}

fn split(s: &mut [u8]) -> Scratch<'_> {
    let (slot, rest) = s.split_at_mut(SLOT.end);
    let (l, rest) = rest.split_at_mut(LEG.end - LEG.start);
    let (src, rest) = rest.split_at_mut(SOURCE.end - SOURCE.start);
    let (ledger, config) = rest.split_at_mut(LEDGER.end - LEDGER.start);
    debug_assert_eq!(config.len(), CONFIG.end - CONFIG.start);
    Scratch {
        slot: bytemuck::from_bytes_mut(slot),
        leg: bytemuck::from_bytes_mut(l),
        source: bytemuck::from_bytes_mut(src),
        ledger: bytemuck::from_bytes_mut(ledger),
        config: bytemuck::from_bytes_mut(config),
    }
}

macro_rules! ok {
    ($($v:expr),*) => {{
        let vals: &[u128] = &[$($v),*];
        let mut out = [0u128; 6];
        out[..vals.len()].copy_from_slice(vals);
        Answer::Ok(out, vals.len())
    }};
}
macro_rules! tri {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(e) => return Answer::Err(e),
        }
    };
}
macro_rules! dec {
    ($e:expr) => {
        match $e {
            Some(v) => v,
            None => return Answer::Decode,
        }
    };
}

/// A market view with a zeroed header (only `config.public_b_chunk_atoms` set) and no slots, for the `&self`
/// functions that read nothing else of the market.
fn with_group<R>(public_b_chunk_atoms: u128, f: impl FnOnce(&MarketGroupV16ViewMut<'_, [u8; 512]>) -> R) -> R {
    let mut header: MarketGroupV16HeaderAccount = bytemuck::Zeroable::zeroed();
    header.config.public_b_chunk_atoms = V16PodU128::new(public_b_chunk_atoms);
    let mut markets: [Market<[u8; 512]>; 0] = [];
    let group = MarketGroupV16ViewMut::new(&mut header, &mut markets);
    f(&group)
}

/// Call engine function `f` (the table in showcase/test/percolator-v16-kernels.ts) on `a` and the scratch `s`.
pub fn call(f: u8, a: &[[u8; 16]; 8], s: &mut [u8]) -> Answer {
    assert_eq!(s.len(), SCRATCH_LEN);
    assert_eq!(core::mem::size_of::<EngineAssetSlotV16Account>(), SLOT.end - SLOT.start);
    assert_eq!(core::mem::size_of::<PortfolioLegV16Account>(), LEG.end - LEG.start);
    assert_eq!(core::mem::size_of::<PortfolioSourceDomainV16Account>(), SOURCE.end - SOURCE.start);
    assert_eq!(core::mem::size_of::<ResolvedPayoutLedgerV16Account>(), LEDGER.end - LEDGER.start);
    assert_eq!(core::mem::size_of::<V16ConfigAccount>(), CONFIG.end - CONFIG.start);
    let sc = split(s);
    match f {
        0 => {
            let (c, n, e, b) = tri!(apply_backing_utilization_fee_charge(u(&a[0]), u(&a[1]), u(&a[2]), i(&a[3]), u(&a[4])));
            ok!(c, n, e, b)
        }
        1 => ok!(tri!(V16Core::mul_div_floor_u128_or_wide(u(&a[0]), u(&a[1]), u(&a[2])))),
        2 => ok!(tri!(V16Core::mul_div_ceil_u128_or_wide(u(&a[0]), u(&a[1]), u(&a[2])))),
        3 => {
            let (x, y) = tri!(V16Core::source_credit_lien_amounts_for_effective(u(&a[0]), u(&a[1])));
            ok!(x, y)
        }
        4 => ok!(tri!(V16Core::source_lien_backing_release_for_face_burn(u(&a[0]), u(&a[1]), u(&a[2])))),
        5 => ok!(tri!(V16Core::source_lien_fee_after_backing_release(u(&a[0]), u(&a[1]), u(&a[2])))),
        6 => {
            let (x, y) = tri!(V16Core::source_lien_face_burn_partition(u(&a[0]), u(&a[1]), u(&a[2])));
            ok!(x, y)
        }
        7 => {
            let (p, q, r, t, v) =
                tri!(V16Core::source_lien_face_burn_plan(u(&a[0]), u(&a[1]), u(&a[2]), u(&a[3]), u(&a[4])));
            ok!(p, q, r, t, v)
        }
        8 => ok!(tri!(V16Core::crystallize_source_lien_fee_for_effective(sc.source, u(&a[0])))),
        9 => {
            let asset = dec!(sc.slot.asset.try_to_runtime_unvalidated().ok());
            let (next, epoch) = tri!(V16Core::kernel_settle_kf_stale_cohort(asset, dec!(side(u(&a[0]))), u64a(&a[1])));
            sc.slot.asset = AssetStateV16Account::from_runtime(&next);
            ok!(epoch as u128)
        }
        10 => {
            let src = source_credit(&sc.slot.source_credit_long);
            let (next, epoch) =
                tri!(V16Core::prepare_source_credit_domain_recompute_for_epoch_steps(src, u64a(&a[0]), u64a(&a[1])));
            sc.slot.source_credit_long = SourceCreditStateV16Account::from_runtime(&next);
            ok!(epoch as u128)
        }
        11 => {
            let src = source_credit(&sc.slot.source_credit_long);
            let next = tri!(V16Core::prepare_source_positive_claim_burn_delta(src, u(&a[0])));
            sc.slot.source_credit_long = SourceCreditStateV16Account::from_runtime(&next);
            ok!()
        }
        12 => {
            let (x, y) = V16Core::source_claim_domain_first_burn_partition(u(&a[0]), u(&a[1]));
            ok!(x, y)
        }
        13 => {
            let (p, b) = tri!(V16Core::kernel_settle_positive_face_after_support(u(&a[0]), u(&a[1]), u(&a[2])));
            ok!(p as u128, b)
        }
        14 => {
            let l = dec!(sc.ledger.try_to_runtime().ok());
            let next = tri!(V16Core::kernel_recompute_resolved_payout_rate(l));
            *sc.ledger = ResolvedPayoutLedgerV16Account::from_runtime(&next);
            ok!()
        }
        15 => {
            let l = dec!(sc.ledger.try_to_runtime().ok());
            let (next, legacy) = tri!(V16Core::kernel_credit_post_snapshot_residual(l, u(&a[0]), u(&a[1])));
            *sc.ledger = ResolvedPayoutLedgerV16Account::from_runtime(&next);
            ok!(legacy)
        }
        16 => {
            let l = dec!(leg(sc.leg));
            let next = tri!(V16Core::kernel_advance_leg_b_snap(l, u(&a[0]), u(&a[1]), u(&a[2])));
            *sc.leg = PortfolioLegV16Account::from_runtime(&next);
            ok!()
        }
        17 => {
            let (d, e) = tri!(V16Core::kernel_normalize_social_loss_carry(u(&a[0]), u(&a[1]), u(&a[2])));
            ok!(d, e)
        }
        18 => {
            let asset = dec!(sc.slot.asset.try_to_runtime_unvalidated().ok());
            let next = tri!(V16Core::kernel_begin_full_drain_reset(asset, dec!(side(u(&a[0])))));
            sc.slot.asset = AssetStateV16Account::from_runtime(&next);
            ok!()
        }
        19..=23 => {
            let b = dec!(bucket(&sc.slot.backing_long));
            let src = source_credit(&sc.slot.source_credit_long);
            let (nb, ns) = tri!(match f {
                19 => V16Core::prepare_counterparty_lien_create_delta(b, src, u64a(&a[0]), u(&a[1])),
                20 => V16Core::prepare_counterparty_backing_add_delta(b, src, u(&a[0]), u64a(&a[1]), u64a(&a[2])),
                21 => V16Core::prepare_counterparty_backing_expiry_delta(b, src, u64a(&a[0])),
                22 => V16Core::prepare_counterparty_lien_terminal_release_delta(b, src, u(&a[0])),
                _ => V16Core::prepare_counterparty_lien_consume_delta(b, src, u(&a[0])),
            });
            sc.slot.backing_long = BackingBucketV16Account::from_runtime(&nb);
            sc.slot.source_credit_long = SourceCreditStateV16Account::from_runtime(&ns);
            ok!()
        }
        24 => {
            let r = reservation(&sc.slot.insurance_reservation_long);
            let src = source_credit(&sc.slot.source_credit_long);
            let (nr, ns, spent, insurance) =
                tri!(V16Core::prepare_insurance_lien_consume_delta(r, src, u(&a[0]), u(&a[1]), u(&a[2])));
            sc.slot.insurance_reservation_long = InsuranceCreditReservationV16Account::from_runtime(&nr);
            sc.slot.source_credit_long = SourceCreditStateV16Account::from_runtime(&ns);
            ok!(spent, insurance)
        }
        25..=27 => {
            let r = reservation(&sc.slot.insurance_reservation_long);
            let src = source_credit(&sc.slot.source_credit_long);
            let (nr, ns) = tri!(match f {
                25 => V16Core::prepare_insurance_lien_create_delta(r, src, u(&a[0])),
                26 => V16Core::prepare_insurance_lien_release_delta(r, src, u(&a[0])),
                _ => V16Core::prepare_insurance_lien_terminal_release_delta(r, src, u(&a[0])),
            });
            sc.slot.insurance_reservation_long = InsuranceCreditReservationV16Account::from_runtime(&nr);
            sc.slot.source_credit_long = SourceCreditStateV16Account::from_runtime(&ns);
            ok!()
        }
        28 => {
            let src = source_credit(&sc.slot.source_credit_long);
            ok!(tri!(V16Core::source_credit_state_realizable_support_for_claim_num(src, u(&a[0]))))
        }
        29 | 30 => {
            // The callers hold a decoded config (`try_to_runtime` before the call): one whose bools do not decode is no input.
            let config = dec!(sc.config.decode_runtime().ok());
            let src = source_credit(&sc.slot.source_credit_long);
            if f == 29 {
                ok!(tri!(V16Core::backing_utilization_rate_e9_for_source_state(config, src)) as u128)
            } else {
                ok!(tri!(V16Core::backing_utilization_fee_quote_atoms_for_lien(config, src, u(&a[0]), u64a(&a[1]), u64a(&a[2]))))
            }
        }
        31 => {
            let phase = dec!(u8::try_from(u(&a[0])).ok());
            ok!(tri!(account_kf_settlement_plan_key(phase, u(&a[1]) as usize, u(&a[2]) as usize)) as u128)
        }
        32 => {
            let (p, d, l) = tri!(decode_account_kf_settlement_plan_key(u64a(&a[0])));
            ok!(p as u128, d as u128, l as u128)
        }
        33 => match scaled_adl_delta_fast(u(&a[0]), u(&a[1]), i(&a[2]), i(&a[3])) {
            Some(v) => ok!(1, v as u128),
            None => ok!(0, 0),
        },
        34 => ok!(tri!(f_snap_after_settlement(u(&a[0]), u(&a[1]), i(&a[2]), i(&a[3]), i(&a[4]))) as u128),
        35 => ok!(tri!(f_snap_residual_is_sub_atom(u(&a[0]), u(&a[1]), i(&a[2]), i(&a[3]))) as u128),
        36 => with_group(0, |g| match g.haircut_effective_support(u(&a[0]), u(&a[1]), u(&a[2])) {
            Ok(v) => ok!(v),
            Err(e) => Answer::Err(e),
        }),
        37 => {
            let asset = dec!(sc.slot.asset.try_to_runtime_unvalidated().ok());
            ok!(asset_is_loss_stale_at_slot(asset, u64a(&a[0])) as u128, asset_contributes_to_loss_stale_summary(asset) as u128)
        }
        38..=40 | 42 => {
            let asset = dec!(sc.slot.asset.try_to_runtime_unvalidated().ok());
            let l = dec!(leg(sc.leg));
            type G<'a> = MarketGroupV16ViewMut<'a, [u8; 512]>;
            match f {
                38 => {
                    let (k, fv) = tri!(G::kf_target_for_leg_from_asset(asset, l));
                    ok!(k as u128, fv as u128)
                }
                39 => ok!(tri!(G::b_target_for_leg_from_asset(asset, l))),
                40 => {
                    let (k, fv, kd, fd, net, next) = tri!(G::leg_kf_delta_components_for_settlement_from_asset(asset, l));
                    ok!(k as u128, fv as u128, kd as u128, fd as u128, net as u128, next as u128)
                }
                _ => ok!(G::leg_has_exhausted_effective_oi(asset, l) as u128),
            }
        }
        41 => {
            let l = dec!(leg(sc.leg));
            with_group(u(&a[2]), |g| match g.account_b_settlement_chunk_from_leg(l, u(&a[0]), u(&a[1])) {
                Ok(c) => ok!(c.delta_b, c.loss, c.new_remainder, c.remaining_after),
                Err(e) => Answer::Err(e),
            })
        }
        43 => ok!(wide_signed_mul_div_floor_from_k_pair(u(&a[0]), i(&a[1]), i(&a[2]), u(&a[3])) as u128),
        44 => ok!(floor_div_signed_conservative_i128(i(&a[0]), u(&a[1])) as u128),
        _ => Answer::Decode,
    }
}

impl AssetStateV16Account {
    /// The fields decoded as `try_to_runtime` decodes them (the enums and lifecycle refused when out of range), without
    /// its `validate_non_min_i128` checks, which callers make before these kernels anyway.
    fn try_to_runtime_unvalidated(&self) -> V16Result<AssetStateV16> {
        let mut copy = *self;
        // try_to_runtime refuses i128::MIN in eight fields; keep the decode and skip only those checks by
        // decoding a copy whose eight signed fields are zero, then putting the values back.
        let k_long = copy.k_long;
        let k_short = copy.k_short;
        let f_long = copy.f_long_num;
        let f_short = copy.f_short_num;
        let ks_long = copy.k_epoch_start_long;
        let ks_short = copy.k_epoch_start_short;
        let fs_long = copy.f_epoch_start_long_num;
        let fs_short = copy.f_epoch_start_short_num;
        copy.k_long = V16PodI128::new(0);
        copy.k_short = V16PodI128::new(0);
        copy.f_long_num = V16PodI128::new(0);
        copy.f_short_num = V16PodI128::new(0);
        copy.k_epoch_start_long = V16PodI128::new(0);
        copy.k_epoch_start_short = V16PodI128::new(0);
        copy.f_epoch_start_long_num = V16PodI128::new(0);
        copy.f_epoch_start_short_num = V16PodI128::new(0);
        let mut out = copy.try_to_runtime()?;
        out.k_long = k_long.get();
        out.k_short = k_short.get();
        out.f_long_num = f_long.get();
        out.f_short_num = f_short.get();
        out.k_epoch_start_long = ks_long.get();
        out.k_epoch_start_short = ks_short.get();
        out.f_epoch_start_long_num = fs_long.get();
        out.f_epoch_start_short_num = fs_short.get();
        Ok(out)
    }
}

// ---- Whole markets and portfolios ------------------------------------------------------------------------------------
//
// `call_market` takes a market account (account header and wrapper config, the 726-byte group header from byte 464,
// then the asset slots of 1,845 bytes each: a 512-byte wrapper and the engine slot) and a portfolio account (its
// 16-byte header, then the engine's portfolio), and builds the original's views over those bytes as the program's
// `market_group_view_from_state` and `portfolio_view_mut_for_market_slots` do: `MarketGroupV16ViewMut::new(header,
// markets)` over the header and the slots, and `PortfolioV16ViewMut { header }` directly (`new()` would compact the
// source domains; none of these functions is reached through `new()` without its caller's own validation first, and
// the generated portfolios are compared as they are). A struct value an engine function takes is read from the
// accounts as the original's callers read it. Function ids: showcase/test/percolator-v16-primitives.ts.
const MARKET_GROUP_OFF: usize = 464;
const PORTFOLIO_STATE_OFF: usize = 16;

type Gm<'a> = MarketGroupV16ViewMut<'a, [u8; 512]>;

fn raw_source(a: &SourceCreditStateV16Account) -> SourceCreditStateV16 {
    source_credit(a)
}

fn side_of(v: u128) -> Option<SideV16> {
    side(v)
}

pub fn call_market(f: u8, a: &[[u8; 16]; 8], market: &mut [u8], portfolio: &mut [u8]) -> Answer {
    let header_len = core::mem::size_of::<MarketGroupV16HeaderAccount>();
    let slot_len = core::mem::size_of::<Market<[u8; 512]>>();
    assert_eq!(header_len, 726);
    assert_eq!(slot_len, 1845);
    let (_, state) = market.split_at_mut(MARKET_GROUP_OFF);
    let (hb, sb) = state.split_at_mut(header_len);
    let header: &mut MarketGroupV16HeaderAccount = bytemuck::from_bytes_mut(hb);
    let markets: &mut [Market<[u8; 512]>] = bytemuck::cast_slice_mut(sb);
    let mut g = Gm::new(header, markets);
    let d = u64a(&a[0]) as usize;
    let has_portfolio = portfolio.len() >= PORTFOLIO_STATE_OFF + core::mem::size_of::<PortfolioAccountV16Account>();
    macro_rules! acct {
        () => {{
            assert!(has_portfolio);
            let ph: &mut PortfolioAccountV16Account = bytemuck::from_bytes_mut(
                &mut portfolio[PORTFOLIO_STATE_OFF..PORTFOLIO_STATE_OFF + core::mem::size_of::<PortfolioAccountV16Account>()],
            );
            PortfolioV16ViewMut { header: ph }
        }};
    }
    macro_rules! opt {
        ($e:expr) => {
            match $e {
                Some(v) => ok!(1, v as u128),
                None => ok!(0, 0),
            }
        };
    }
    match f {
        0 => {
            let (asset, s) = tri!(g.domain_asset_side(d));
            ok!(asset as u128, encode_side(s) as u128)
        }
        1 => ok!(tri!(g.insurance_domain_index(u64a(&a[0]) as usize, dec!(side_of(u(&a[1]))))) as u128),
        2 => ok!(tri!(g.source_credit_for_domain(d)).credit_rate_num),
        3 => ok!(tri!(g.source_credit_for_domain_shape(d)).credit_rate_num),
        4 => ok!(tri!(g.stored_source_credit_rate_num(d))),
        5 => ok!(tri!(g.provider_principal_num(d))),
        6 => ok!(tri!(g.loser_paid_backing_num(d))),
        7 => ok!(tri!(g.backing_bucket_for_domain(d)).expiry_slot as u128),
        8 => {
            let (s, e) = tri!(g.backing_bucket_raw_status_expiry_for_domain(d));
            ok!(s as u128, e as u128)
        }
        9 => {
            tri!(g.insurance_reservation_for_domain(d));
            ok!()
        }
        10 => ok!(tri!(g.fresh_counterparty_backing_expiry_slot(d)) as u128),
        11 => {
            let (b, s) = tri!(g.domain_insurance_budget_spent(d));
            ok!(b, s)
        }
        12 => ok!(g.residual(), g.junior_claim_bound(), g.backing_provider_earnings_total(), g.source_fresh_backing_total_atoms()),
        13 => ok!(tri!(Gm::domain_budget_remaining_parts(u(&a[0]), u(&a[1])))),
        15 => {
            // The new state: the stored one (as read, undecoded) with three amounts the totals follow replaced.
            let (asset, s) = tri!(g.domain_asset_side(d));
            let slot = &g.markets[asset].engine;
            let mut next = raw_source(if s == SideV16::Long { &slot.source_credit_long } else { &slot.source_credit_short });
            next.positive_claim_bound_num = u(&a[1]);
            next.insurance_credit_reserved_num = u(&a[2]);
            next.fresh_reserved_backing_num = u(&a[3]);
            tri!(g.set_source_credit_for_domain(d, next));
            ok!()
        }
        16 => {
            let mut b = tri!(g.backing_bucket_for_domain(d));
            b.utilization_fee_earnings = u(&a[1]);
            tri!(g.set_backing_bucket_for_domain(d, b));
            ok!()
        }
        17 => {
            let (asset, s) = tri!(g.domain_asset_side(d));
            let slot = &g.markets[asset].engine;
            let mut r = reservation(if s == SideV16::Long { &slot.insurance_reservation_long } else { &slot.insurance_reservation_short });
            r.consumed_insurance_num = u(&a[1]);
            tri!(g.set_insurance_reservation_for_domain(d, r));
            ok!()
        }
        18 => {
            tri!(g.adjust_provider_principal_num(d, u(&a[1]), u(&a[2]) != 0));
            ok!()
        }
        19 => {
            tri!(g.release_provider_principal_after(d, u(&a[1]), u(&a[2])));
            ok!()
        }
        20 => ok!(tri!(Gm::set_domain_insurance_spent_delta(u(&a[0]), u(&a[1]), u(&a[2]), u(&a[3]), u(&a[4])))),
        21 => {
            tri!(g.set_domain_insurance_spent_core(d, u(&a[1])));
            ok!()
        }
        22 => {
            tri!(g.validate_source_domain_ledger(d));
            ok!()
        }
        23 => {
            tri!(g.validate_source_domain_ledger_current(d));
            ok!()
        }
        24 => {
            tri!(g.recompute_source_credit_domain_after_mutation(d));
            ok!()
        }
        25 => {
            tri!(g.recompute_source_credit_domain_after_mutations(d, u64a(&a[1])));
            ok!()
        }
        26 => {
            tri!(g.refresh_source_credit_domain_after_mutation(d));
            ok!()
        }
        27 => {
            tri!(tri!(g.reservation_encumbrance_proof_for_domain(d)).validate());
            ok!()
        }
        28 => {
            let s = tri!(g.source_credit_for_domain(d));
            let b = tri!(g.backing_bucket_for_domain(d));
            let r = tri!(g.insurance_reservation_for_domain(d));
            tri!(tri!(g.reservation_encumbrance_proof_for_domain_parts(d, s, b, r)).validate());
            ok!()
        }
        29 => {
            tri!(g.add_fresh_counterparty_backing_unchecked(d, u(&a[1]), u64a(&a[2])));
            ok!()
        }
        30 => {
            tri!(g.add_fresh_counterparty_backing_steps_unchecked(d, u(&a[1]), u64a(&a[2]), u64a(&a[3])));
            ok!()
        }
        31 => {
            tri!(g.add_loser_paid_counterparty_backing_unchecked(d, u(&a[1]), u64a(&a[2])));
            ok!()
        }
        32 => {
            tri!(g.add_loser_paid_counterparty_backing_payments_unchecked(d, u(&a[1]), u64a(&a[2]), u64a(&a[3])));
            ok!()
        }
        33 => {
            tri!(g.expire_source_backing_bucket_not_atomic(d, u64a(&a[1])));
            ok!()
        }
        34 => {
            tri!(g.credit_post_snapshot_residual_not_atomic(u(&a[0])));
            ok!()
        }
        35 => {
            tri!(g.release_source_credit_lien_from_counterparty_terminal_not_atomic(d, u(&a[1])));
            ok!()
        }
        36 => {
            tri!(g.consume_source_credit_lien_from_counterparty_core_not_atomic(d, u(&a[1])));
            ok!()
        }
        37 => {
            tri!(g.release_source_credit_lien_from_insurance_core_not_atomic(d, u(&a[1])));
            ok!()
        }
        38 => {
            tri!(g.release_source_credit_lien_from_insurance_terminal_not_atomic(d, u(&a[1])));
            ok!()
        }
        39 => {
            tri!(g.create_and_consume_source_credit_from_counterparty_core_not_atomic(d, u(&a[1])));
            ok!()
        }
        40 => {
            // The parts as `consume_validated_account_source_credit_not_atomic` reads them.
            let s = tri!(g.source_credit_for_domain_shape(d));
            let b = tri!(g.backing_bucket_for_domain(d));
            let r = tri!(g.insurance_reservation_for_domain(d));
            tri!(g.create_and_consume_source_credit_from_counterparty_parts_not_atomic(d, b, s, r, u(&a[1]), u(&a[2])));
            ok!()
        }
        41 => {
            tri!(g.create_and_consume_source_credit_from_insurance_core_not_atomic(d, u(&a[1])));
            ok!()
        }
        42 => {
            let s = tri!(g.source_credit_for_domain_shape(d));
            let b = tri!(g.backing_bucket_for_domain(d));
            let r = tri!(g.insurance_reservation_for_domain(d));
            tri!(g.create_and_consume_source_credit_from_insurance_parts_not_atomic(d, b, r, s, u(&a[1]), u(&a[2])));
            ok!()
        }
        43 => {
            tri!(TokenValueFlowProofV16::validate_insurance_to_close_insurance_spent(u(&a[0]), u(&a[1]), u(&a[2])));
            ok!()
        }
        44 => ok!(tri!(g.source_credit_available_backing_num(d))),
        45 => ok!(tri!(g.face_claim_to_burn_for_support(u(&a[0]), u(&a[1]), u(&a[2])))),
        46 => ok!(tri!(g.twin_loser_paid_share_num(d, u(&a[1]), u(&a[2])))),
        47 => ok!(tri!(g.loss_bucket_accepts_fresh(d)) as u128),
        48 => ok!(tri!(g.resolved_loss_backing_capacity_num(d))),
        49 => {
            let s = dec!(side_of(u(&a[1])));
            let asset = u64a(&a[0]) as usize;
            let c = tri!(g.pending_domain_loss_barrier_count(asset, s));
            let h = tri!(g.has_pending_domain_loss_barrier(asset, s));
            ok!(c as u128, h as u128)
        }
        50 => {
            let open = match u(&a[2]) {
                0 => None,
                1 => Some(false),
                2 => Some(true),
                _ => return Answer::Decode,
            };
            let mut payment = KfLossLienPaymentV16 { loss_domain: u64a(&a[1]) as usize, loss_side_open: open, consumed_atoms: u(&a[3]) };
            let v = tri!(g.kf_loss_lien_backing_to_consume_num(d, &mut payment, u(&a[4]), u(&a[5])));
            let code = match payment.loss_side_open {
                None => 0,
                Some(false) => 1,
                Some(true) => 2,
            };
            ok!(v, code, payment.consumed_atoms)
        }
        51 => {
            let mut c = V16PodU128::new(u(&a[0]));
            tri!(Gm::add_account_u128_counter(&mut c, u(&a[1])));
            ok!(c.get())
        }
        52 => {
            let acct = acct!();
            opt!(tri!(acct.as_view().source_domain_slot(d)))
        }
        53 => {
            let acct = acct!();
            opt!(tri!(acct.source_domain_slot(d)))
        }
        54 => {
            let mut acct = acct!();
            ok!(tri!(acct.source_domain_slot_or_insert(d)) as u128)
        }
        55 => {
            let mut acct = acct!();
            ok!(acct.reset_source_domain_slot_if_empty(d) as u128)
        }
        56 => {
            let acct = acct!();
            let v = acct.as_view();
            ok!(tri!(Gm::account_source_claim_bound_sum_num(&v)), tri!(Gm::account_has_source_claims(&v)) as u128)
        }
        57 => {
            let acct = acct!();
            ok!(tri!(Gm::source_claim_unliened_num(&acct.as_view(), d)))
        }
        58 => {
            let acct = acct!();
            ok!(tri!(Gm::slot_unliened_claim_num(acct.header.source_domains[d % PORTFOLIO_SOURCE_DOMAIN_CAP])))
        }
        59 => {
            let acct = acct!();
            ok!(acct.header.source_domains[d % PORTFOLIO_SOURCE_DOMAIN_CAP].is_sparse_tail_default() as u128)
        }
        60 => {
            let acct = acct!();
            ok!(tri!(Gm::has_b_stale_leg(&acct.as_view())) as u128)
        }
        61 => {
            let acct = acct!();
            opt!(tri!(Gm::active_leg_slot_for_asset(&acct.as_view(), d)))
        }
        62 => {
            let acct = acct!();
            ok!(tri!(Gm::require_active_leg_slot_for_asset(&acct.as_view(), d)) as u128)
        }
        63 => {
            let acct = acct!();
            let l = tri!(Gm::active_leg_for_asset(&acct.as_view(), d));
            ok!(l.active as u128, l.asset_index as u128, l.k_snap as u128)
        }
        64 => ok!(encode_asset_lifecycle(tri!(g.asset_state(d)).lifecycle) as u128),
        65 => {
            let acct = acct!();
            let c = tri!(acct.header.close_progress.try_to_runtime());
            ok!(c.has_pending_residual() as u128)
        }
        66 => {
            let mut acct = acct!();
            tri!(g.ensure_account_source_claim_market_id(&mut acct, d));
            ok!()
        }
        67 => {
            let mut acct = acct!();
            ok!(tri!(g.collect_account_backing_utilization_fee_for_domain_not_atomic(&mut acct, d)))
        }
        69 => {
            let mut acct = acct!();
            let i = d % PORTFOLIO_SOURCE_DOMAIN_CAP;
            let (next, effective) = tri!(V16Core::prepare_account_counterparty_lien_impairment(acct.header.source_domains[i]));
            acct.header.source_domains[i] = next;
            ok!(effective)
        }
        70 => {
            let (asset, s) = tri!(g.domain_asset_side(d));
            let slot = &g.markets[asset].engine;
            let (b, src) = if s == SideV16::Long {
                (dec!(bucket(&slot.backing_long)), raw_source(&slot.source_credit_long))
            } else {
                (dec!(bucket(&slot.backing_short)), raw_source(&slot.source_credit_short))
            };
            let (nb, ns) = tri!(V16Core::prepare_counterparty_impaired_lien_retirement_delta(b, src, u(&a[1])));
            let slot = &mut g.markets[asset].engine;
            if s == SideV16::Long {
                slot.backing_long = BackingBucketV16Account::from_runtime(&nb);
                slot.source_credit_long = SourceCreditStateV16Account::from_runtime(&ns);
            } else {
                slot.backing_short = BackingBucketV16Account::from_runtime(&nb);
                slot.source_credit_short = SourceCreditStateV16Account::from_runtime(&ns);
            }
            ok!()
        }
        71 => {
            tri!(g.retire_source_credit_lien_from_counterparty_impaired_not_atomic(d, u(&a[1])));
            ok!()
        }
        72 => {
            tri!(g.release_or_retire_counterparty_lien_backing_not_atomic(d, u(&a[1])));
            ok!()
        }
        73 => {
            let mut acct = acct!();
            let (x, y) = tri!(Gm::burn_impaired_account_source_claim_fields(&mut acct, d, u(&a[1])));
            ok!(x, y)
        }
        74 => {
            let mut acct = acct!();
            ok!(tri!(Gm::impair_account_source_credit_counterparty_lien_fields(&mut acct, d)))
        }
        75 => {
            let mut acct = acct!();
            tri!(g.reconcile_account_impaired_counterparty_lien_at_slot_not_atomic(&mut acct, d));
            ok!()
        }
        76 => {
            let mut acct = acct!();
            tri!(g.reconcile_account_impaired_counterparty_liens_not_atomic(&mut acct));
            ok!()
        }
        // Layer 4. A K/F loss payment, where a function takes one, is arguments 4 to 7: present (0 none, 1 some), the
        // loss's domain, whether its side is open (0 not known, 1 no, 2 yes) and the atoms consumed; the answer then
        // ends with the payment's side code and atoms.
        77 => {
            let mut acct = acct!();
            tri!(g.decrement_account_source_claim_for_domain_not_atomic(&mut acct, d, u64a(&a[1]) as usize, u(&a[2])));
            ok!()
        }
        78 | 79 | 80 | 88 => {
            let mut acct = acct!();
            let has = match u(&a[4]) {
                0 => false,
                1 => true,
                _ => return Answer::Decode,
            };
            let open = match u(&a[6]) {
                0 => None,
                1 => Some(false),
                2 => Some(true),
                _ => return Answer::Decode,
            };
            let mut pay = KfLossLienPaymentV16 { loss_domain: u64a(&a[5]) as usize, loss_side_open: open, consumed_atoms: u(&a[7]) };
            let kf = if has { Some(&mut pay) } else { None };
            let out = match f {
                78 => {
                    tri!(g.burn_account_source_lien_face_not_atomic(&mut acct, d, u64a(&a[1]) as usize, u(&a[2]), kf));
                    0
                }
                79 => tri!(g.burn_account_source_claim_at_slot_up_to(&mut acct, d, u64a(&a[1]) as usize, u(&a[2]), kf)),
                80 => {
                    tri!(g.burn_account_source_claim_bound_num(&mut acct, u(&a[0]), kf));
                    0
                }
                _ => {
                    tri!(g.set_account_pnl_after_kf_loss_claim_burn(&mut acct, i(&a[0]), u(&a[1]), kf));
                    0
                }
            };
            let code = match pay.loss_side_open {
                None => 0,
                Some(false) => 1,
                Some(true) => 2,
            };
            ok!(out, code, pay.consumed_atoms)
        }
        81 => {
            let mut acct = acct!();
            tri!(g.burn_account_source_claim_bound_num_domain_first(&mut acct, d, u(&a[1])));
            ok!()
        }
        82 => ok!(tri!(g.source_domain_prospective_support_for_face(d, u(&a[1])))),
        83 => {
            let c = tri!(g.consume_source_domain_credit_for_effective_not_atomic(d, u(&a[1])));
            ok!(c.face_burn, c.counterparty_credit_consumed, c.insurance_credit_consumed)
        }
        84 => {
            let mut acct = acct!();
            let burn = dec!(boolean(u(&a[1]) as u8).filter(|_| u(&a[1]) <= 1));
            let full = dec!(boolean(u(&a[2]) as u8).filter(|_| u(&a[2]) <= 1));
            let (c, burned, consumed) = tri!(g.consume_validated_account_source_credit_not_atomic(&mut acct, u(&a[0]), burn, full));
            ok!(c.face_burn, c.counterparty_credit_consumed, c.insurance_credit_consumed, burned, consumed)
        }
        85 => {
            let mut acct = acct!();
            tri!(g.set_account_pnl(&mut acct, i(&a[0])));
            ok!()
        }
        86 => {
            let mut acct = acct!();
            tri!(g.set_account_pnl_with_source(&mut acct, i(&a[0]), u64a(&a[1]) as usize));
            ok!()
        }
        87 => {
            let mut acct = acct!();
            tri!(g.set_account_pnl_after_source_claim_burn(&mut acct, i(&a[0]), u(&a[1])));
            ok!()
        }
        89 => {
            let mut acct = acct!();
            tri!(g.set_account_pnl_after_domain_first_source_claim_burn(&mut acct, i(&a[0]), u64a(&a[1]) as usize));
            ok!()
        }
        // Layer 5. A par-netting batch is arguments 4 to 6 (face left, loss left, expiry; nothing netted yet) and is
        // answered as (netted, netted bound, transfer, loss left, face left, expiry).
        90 => {
            let mut acct = acct!();
            tri!(Gm::record_account_funding_flow(&mut acct, dec!(side_of(u(&a[0]))), i(&a[1])));
            ok!()
        }
        91 => {
            let mut acct = acct!();
            ok!(tri!(g.settle_kf_loss_before_support_not_atomic(&mut acct, d, u(&a[1]))))
        }
        92 | 93 => {
            let mut acct = acct!();
            let mut batch = ParNettingBatchV16 {
                face_left: u(&a[4]),
                loss_left: u(&a[5]),
                netted: 0,
                netted_num: 0,
                transfer_num: 0,
                expiry_slot: u64a(&a[6]),
            };
            // Both callers pass a slot of the account's source domains (the original indexes them unchecked).
            if d >= PORTFOLIO_SOURCE_DOMAIN_CAP {
                return Answer::Decode;
            }
            if f == 92 {
                let open = dec!(boolean(u(&a[2]) as u8).filter(|_| u(&a[2]) <= 1));
                let full = dec!(boolean(u(&a[3]) as u8).filter(|_| u(&a[3]) <= 1));
                tri!(g.net_slot_face_at_par_not_atomic(&mut acct, d, u64a(&a[1]) as usize, open, full, &mut batch));
            } else {
                // As its caller does: at most the batch's loss and face left, and nonzero.
                let netted = u(&a[1]).min(batch.loss_left).min(batch.face_left);
                if netted == 0 {
                    return Answer::Decode;
                }
                tri!(g.cancel_loss_domain_face_at_par_not_atomic(&mut acct, d, netted, &mut batch));
            }
            ok!(batch.netted, batch.netted_num, batch.transfer_num, batch.loss_left, batch.face_left, batch.expiry_slot as u128)
        }
        94 => {
            let mut acct = acct!();
            let mut credit = KfLossDomainCreditV16 { amount_num: u(&a[2]), expiry_slot: u64a(&a[3]), payments: u64a(&a[4]) };
            let paid = tri!(g.pay_kf_loss_from_free_capital_not_atomic(&mut acct, d, u(&a[1]), &mut credit));
            ok!(paid, credit.amount_num, credit.expiry_slot as u128, credit.payments as u128)
        }
        95 | 96 => {
            let mut acct = acct!();
            let domain = match u(&a[1]) {
                0 => None,
                1 => Some(u64a(&a[2]) as usize),
                _ => return Answer::Decode,
            };
            let r = if f == 95 {
                tri!(g.apply_haircut_bounded_close_loss_to_pnl(&mut acct, u(&a[0]), domain))
            } else {
                tri!(g.apply_signed_kf_delta_to_pnl(&mut acct, i(&a[0]), domain))
            };
            ok!(r.support_consumed, r.junior_face_burned, r.counterparty_support_consumed)
        }
        97 => {
            let mut acct = acct!();
            tri!(g.reserve_new_capital_backed_loss_for_source_domain_not_atomic(&mut acct, d, u(&a[1]), u(&a[2])));
            ok!()
        }
        98 => {
            tri!(g.book_kf_loss_support_for_source_domain_not_atomic(d, u(&a[1])));
            ok!()
        }
        99 => ok!(tri!(g.book_realized_kf_loss_for_source_domain_not_atomic(d, u(&a[1])))),
        100 | 101 => {
            let mut acct = acct!();
            let normalize = dec!(boolean(u(&a[1]) as u8).filter(|_| u(&a[1]) <= 1));
            let (entry, p) = tri!(g.prepare_account_kf_settlement_entry(&mut acct, d, normalize));
            if f == 101 {
                tri!(g.apply_account_kf_settlement_entry(&mut acct, entry, p));
            }
            ok!(entry as u128, p.k_now as u128, p.f_now as u128, p.f_snap_next as u128, p.f_delta as u128, p.net as u128)
        }
        102 => {
            tri!(g.begin_full_drain_reset_inner(d, dec!(side_of(u(&a[1])))));
            ok!()
        }
        // Layers 6 and 7. A chunk is answered as (current: 1 for AccountCurrent, 0 for a chunk; delta B, loss,
        // remainder, B remaining after).
        103 => {
            let acct = acct!();
            let leg = tri!(acct.header.legs[u64a(&a[1]) as usize % V16_MAX_PORTFOLIO_ASSETS_N].try_to_runtime());
            ok!(tri!(g.b_target_for_leg(d, leg)))
        }
        104 => {
            let mut acct = acct!();
            tri!(g.mark_account_b_stale(&mut acct));
            ok!()
        }
        105 => {
            let mut acct = acct!();
            tri!(g.clear_account_b_stale(&mut acct));
            ok!()
        }
        106 => {
            let mut acct = acct!();
            tri!(g.mark_leg_b_stale(&mut acct, d));
            ok!()
        }
        107 | 108 => {
            let mut acct = acct!();
            let c = if f == 107 {
                tri!(g.account_b_settlement_chunk(&acct.as_view(), d, u(&a[1])))
            } else {
                tri!(g.settle_account_b_chunk(&mut acct, d, u(&a[1])))
            };
            ok!(0, c.delta_b, c.loss, c.new_remainder, c.remaining_after)
        }
        109 => {
            let mut acct = acct!();
            let normalize = dec!(boolean(u(&a[0]) as u8).filter(|_| u(&a[0]) <= 1));
            tri!(g.settle_account_kf_effects_not_atomic(&mut acct, normalize));
            ok!()
        }
        110 => {
            let mut acct = acct!();
            match tri!(g.settle_account_side_effects_not_atomic(&mut acct, u(&a[0]))) {
                PermissionlessProgressOutcomeV16::AccountCurrent => ok!(1, 0, 0, 0, 0),
                PermissionlessProgressOutcomeV16::AccountBChunk(c) => ok!(0, c.delta_b, c.loss, c.new_remainder, c.remaining_after),
                _ => return Answer::Decode,
            }
        }
        68 => {
            tri!(g.validate_shape());
            let acct = acct!();
            tri!(acct.as_view().validate_with_market(&g.as_view()));
            ok!()
        }
        _ => Answer::Decode,
    }
}
