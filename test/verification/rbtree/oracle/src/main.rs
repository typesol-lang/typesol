//! Trace oracle for TypeSOL's built-in RedBlackTree: runs lib-sokoban 0.3.0's RedBlackTree<K, V, N> (the real crate)
//! on random operation traces and records, after every operation, its result and a hash of the tree's bytes.
//! Not needed by the tests (they read the recorded JSON); `../regenerate.sh` rebuilds the committed traces.
//!
//!   cargo run --release -- <out.jsonl> <first-seed> <seed-count> <ops-per-trace> [shapes,comma] [caps,comma] [cycles] [fill-to]
//!
//! Shapes: u64 (u64 -> u64, stride 32), bid / ask / mixed (Phoenix's FIFOOrderId -> FIFORestingOrder, stride 64; bid
//! keys have the sequence number's top bit set, ask keys clear, mixed either), trader (Pubkey -> Phoenix's
//! TraderState, stride 144). Capacities 1, 2, 3, 7, 64, 512 and 4096 are compiled in. Without `cycles`, traces mix
//! random phases with fill and drain phases (each at least 1.5 × N operations long), `ops-per-trace` in all; with
//! `cycles`, a trace fills the tree (to `fill-to` entries, N by default) and drains it to empty that many times, a few
//! operations more at each end (inserts into a full tree, removes from an empty one). Keys come from a domain of
//! 2N + 3 (equal keys meet; re-inserts after removals, the free list drained and refilled). Every trace has its own
//! RNG stream (seed, capacity and shape mixed) and ends with min, max and two addrOf lookups.
//!
//! One JSON line per (shape, capacity, seed): {"shape","cap","seed","ops":[…],"res":[…],"hash":[…]}.
//! Encodings shared with the TypeSOL replay (test/verification/rbtree-trace.test.ts):
//! - splitmix64 as below; a value from `vseed` is words splitmix64(vseed + j), j = 0.. (little-endian);
//! - u64 keys and FIFOOrderId parts as decimal strings; a Pubkey key from `kseed`: bytes 0..16 the words
//!   splitmix64(1000 + kseed % 3 + j), bytes 16..32 the words splitmix64(kseed * 2 + j) (so keys share prefixes);
//! - ops: ["i", key, vseed] insert, ["r", key] remove, ["g", key] get, ["mn"] / ["mx"] min / max index,
//!   ["f", limit] / ["b", limit] forward / reverse iteration of at most `limit` entries (0: all), ["a", key] addrOf;
//! - results: insert → node index or -1; remove / get → the value's first word (decimal string) or null;
//!   min / max / addrOf → node index (0: empty or absent); iteration → [count, fnv1a32 of the node indices visited, as u32 LE];
//! - hash: the first 8 bytes of sha256 over the tree's bytes (root, padding, allocator, all N nodes), as hex.
use bytemuck::{Pod, Zeroable};
use sha2::{Digest, Sha256};
use sokoban::node_allocator::{NodeAllocatorMap, OrderedNodeAllocatorMap};
use sokoban::RedBlackTree;
use std::cmp::Ordering;
use std::fmt::Write as _;
use std::io::Write as _;

fn splitmix64(x: u64) -> u64 {
    let mut z = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(1);
        splitmix64(self.0.wrapping_mul(0x2545_F491_4F6C_DD1D))
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

fn words<const W: usize>(seed: u64) -> [u64; W] {
    let mut w = [0u64; W];
    for (j, x) in w.iter_mut().enumerate() {
        *x = splitmix64(seed.wrapping_add(j as u64));
    }
    w
}

// ---- Phoenix's FIFOOrderId, its Ord verbatim (src/state/markets/fifo.rs) ----
#[repr(C)]
#[derive(Default, Debug, Copy, Clone, PartialEq, Eq, Zeroable, Pod)]
pub struct FIFOOrderId {
    pub price_in_ticks: u64,
    pub order_sequence_number: u64,
}
impl PartialOrd for FIFOOrderId {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        let bid = self.order_sequence_number >> 63 == 1; // Side::from_order_sequence_number
        let (tick_cmp, seq_cmp) = if bid {
            (
                other.price_in_ticks.partial_cmp(&self.price_in_ticks)?,
                other.order_sequence_number.partial_cmp(&self.order_sequence_number)?,
            )
        } else {
            (
                self.price_in_ticks.partial_cmp(&other.price_in_ticks)?,
                self.order_sequence_number.partial_cmp(&other.order_sequence_number)?,
            )
        };
        if tick_cmp == Ordering::Equal {
            Some(seq_cmp)
        } else {
            Some(tick_cmp)
        }
    }
}
impl Ord for FIFOOrderId {
    fn cmp(&self, other: &Self) -> Ordering {
        self.partial_cmp(other).unwrap()
    }
}

/// Phoenix's MarketTraderId is a Pubkey: Ord over its 32 bytes.
#[repr(C)]
#[derive(Default, Debug, Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Zeroable, Pod)]
pub struct Key32(pub [u8; 32]);

#[repr(C)]
#[derive(Default, Debug, Copy, Clone, Zeroable, Pod)]
pub struct V8(pub [u64; 1]);
#[repr(C)]
#[derive(Default, Debug, Copy, Clone, Zeroable, Pod)]
pub struct V32(pub [u64; 4]);
#[repr(C)]
#[derive(Default, Debug, Copy, Clone, Zeroable, Pod)]
pub struct V96(pub [u64; 12]);

trait Shape {
    type K: Copy + Ord + Default + Pod + std::fmt::Debug;
    type V: Copy + Default + Pod;
    fn key(&self, rng: &mut Rng, domain: u64) -> (Self::K, String);
    fn value(vseed: u64) -> Self::V;
    fn first_word(v: &Self::V) -> u64;
}

struct U64Shape;
impl Shape for U64Shape {
    type K = u64;
    type V = V8;
    fn key(&self, rng: &mut Rng, domain: u64) -> (u64, String) {
        // Mostly a small domain (equal keys meet), sometimes any u64 (the high bit set too).
        let k = if rng.below(8) == 0 { rng.next() } else { rng.below(domain) * 0x1_0000_0001 };
        (k, format!("\"{}\"", k))
    }
    fn value(vseed: u64) -> V8 {
        V8(words::<1>(vseed))
    }
    fn first_word(v: &V8) -> u64 {
        v.0[0]
    }
}

/// bid (seq top bit set), ask (clear) or mixed (either: Phoenix's comparator is then not an order, still deterministic).
struct FifoShape(u8);
impl Shape for FifoShape {
    type K = FIFOOrderId;
    type V = V32;
    fn key(&self, rng: &mut Rng, domain: u64) -> (FIFOOrderId, String) {
        let price = rng.below(domain / 2 + 2);
        let mut seq = rng.below(domain / 2 + 2);
        let bid = match self.0 {
            0 => true,
            1 => false,
            _ => rng.below(2) == 0,
        };
        if bid {
            seq = !seq;
        }
        (FIFOOrderId { price_in_ticks: price, order_sequence_number: seq }, format!("[\"{}\",\"{}\"]", price, seq))
    }
    fn value(vseed: u64) -> V32 {
        V32(words::<4>(vseed))
    }
    fn first_word(v: &V32) -> u64 {
        v.0[0]
    }
}

pub fn pubkey_of(kseed: u64) -> [u8; 32] {
    let mut k = [0u8; 32];
    let a = words::<2>(1000 + kseed % 3);
    let b = words::<2>(kseed.wrapping_mul(2));
    for j in 0..2 {
        k[j * 8..j * 8 + 8].copy_from_slice(&a[j].to_le_bytes());
        k[16 + j * 8..16 + j * 8 + 8].copy_from_slice(&b[j].to_le_bytes());
    }
    k
}

struct TraderShape;
impl Shape for TraderShape {
    type K = Key32;
    type V = V96;
    fn key(&self, rng: &mut Rng, domain: u64) -> (Key32, String) {
        let s = rng.below(domain);
        (Key32(pubkey_of(s)), format!("\"{}\"", s))
    }
    fn value(vseed: u64) -> V96 {
        V96(words::<12>(vseed))
    }
    fn first_word(v: &V96) -> u64 {
        v.0[0]
    }
}

fn fnv1a32(acc: u32, x: u32) -> u32 {
    let mut h = acc;
    for b in x.to_le_bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(16777619);
    }
    h
}

/// What a trace's next operation is.
#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Insert,
    Remove,
    Get,
    Min,
    Max,
    Addr,
    Iter,
}

/// The trace's own RNG stream: its seed, capacity and shape name all mixed in (bid and ask, of the same length, apart).
fn stream(seed: u64, n: usize, name: &str) -> u64 {
    let mut h = 0xcbf2_9ce4_8422_2325u64;
    for b in name.bytes() {
        h = (h ^ b as u64).wrapping_mul(0x0100_0000_01b3);
    }
    splitmix64(seed ^ splitmix64(n as u64 ^ splitmix64(h)))
}

/// The cycle schedule (`cycles` > 0): fill until the tree holds `fill_to` entries, go on inserting into it for a few
/// more operations (into a full tree when `fill_to` is N), drain it to empty and on for a few more, `cycles` times;
/// without cycles, random phases of max(97, 1.5 N) operations, `nops` in all. Every trace ends with min, max and an
/// addrOf of a present key and of an absent one, so each kind of operation appears in every trace.
fn run<S: Shape, const N: usize>(shape: &S, name: &str, seed: u64, nops: usize, cycles: u64, fill_to: usize, out: &mut String) -> usize {
    type T<S, const N: usize> = RedBlackTree<<S as Shape>::K, <S as Shape>::V, N>;
    let size = std::mem::size_of::<T<S, N>>();
    let stride = 16 + std::mem::size_of::<S::K>() + std::mem::size_of::<S::V>();
    assert_eq!(size, 32 + N * stride);
    // 8-aligned backing store (bytemuck checks the alignment).
    let mut store = vec![0u64; size / 8];
    let bytes: &mut [u8] = bytemuck::cast_slice_mut(store.as_mut_slice());
    let base = bytes.as_ptr() as usize;
    let tree: &mut T<S, N> = bytemuck::from_bytes_mut(bytes);
    tree.initialize();
    let index_of = |k: &S::K| -> u32 { ((k as *const S::K as usize - base - 32) / stride + 1) as u32 };

    let mut rng = Rng(stream(seed, N, name));
    let domain = (2 * N as u64 + 3).max(4);
    let fill_to = fill_to.min(N).max(1);
    let extra = (N / 16 + 3).min(40);
    let mut present: Vec<(S::K, String)> = Vec::new();
    let mut ops = String::new();
    let mut res = String::new();
    let mut hashes = String::new();
    let mut phase = if cycles > 0 { 1u64 } else { 0u64 }; // 0 random, 1 fill, 2 drain
    let (mut done, mut past) = (0u64, 0usize);
    let mut step = 0usize;
    let mut tail = 0usize;
    loop {
        let tree_ref: &mut T<S, N> = unsafe { &mut *(tree as *mut T<S, N>) };
        if tail == 0 {
            if cycles > 0 {
                // Each phase runs until its target, then `extra` operations more.
                let reached = if phase == 1 { tree_ref.len() >= fill_to } else { tree_ref.len() == 0 };
                if reached {
                    past += 1;
                    if past > extra {
                        past = 0;
                        if phase == 2 {
                            done += 1;
                        }
                        phase = if phase == 1 { 2 } else { 1 };
                    }
                }
                if done == cycles {
                    tail = 1;
                }
                // A schedule that cannot finish (the mixed shape's comparator is no order) is refused, not looped on.
                assert!(step < 20 * N * cycles as usize + 1000, "{} cap {} seed {}: the cycles did not finish", name, N, seed);
            } else {
                if step % (97usize.max(3 * N / 2)) == 0 {
                    phase = rng.below(5).min(2) * (rng.below(2) + 1) % 3;
                }
                if step == nops {
                    tail = 1;
                }
            }
        }
        let kind = if tail > 0 {
            match tail {
                1 => Kind::Min,
                2 => Kind::Max,
                3 | 4 => Kind::Addr,
                _ => break,
            }
        } else {
            let r = rng.below(100);
            let (ins, rem) = match phase {
                1 => (85, 88),
                2 => (4, 88),
                _ => (36, 60),
            };
            if r < ins {
                Kind::Insert
            } else if r < rem {
                Kind::Remove
            } else if r < rem + (100 - rem) * 2 / 5 {
                Kind::Get
            } else {
                // The rest split evenly: min, max, addrOf, iteration.
                match rng.below(4) {
                    0 => Kind::Min,
                    1 => Kind::Max,
                    2 => Kind::Addr,
                    _ => Kind::Iter,
                }
            }
        };
        let op: (String, String) = match kind {
            Kind::Insert => {
                // An existing key now and then (the value replaced), less often while filling.
                let again = if phase == 1 { 12 } else { 6 };
                let (k, ks) = if !present.is_empty() && rng.below(again) == 0 {
                    present[rng.below(present.len() as u64) as usize].clone()
                } else {
                    shape.key(&mut rng, domain)
                };
                let vseed = rng.next() >> 40;
                let got = tree_ref.insert(k, S::value(vseed));
                if got.is_some() && !present.iter().any(|(p, _)| *p == k) {
                    present.push((k, ks.clone()));
                }
                (format!("[\"i\",{},{}]", ks, vseed), match got { Some(i) => i.to_string(), None => "-1".into() })
            }
            Kind::Remove => {
                // A present key mostly (nearly always while draining), else a fresh draw (often absent).
                let fresh = if phase == 2 { 20 } else { 5 };
                let (k, ks) = if !present.is_empty() && rng.below(fresh) != 0 {
                    let j = rng.below(present.len() as u64) as usize;
                    present[j].clone()
                } else {
                    shape.key(&mut rng, domain)
                };
                let got = tree_ref.remove(&k);
                if got.is_some() {
                    if let Some(j) = present.iter().position(|(p, _)| *p == k) {
                        present.swap_remove(j);
                    }
                }
                (format!("[\"r\",{}]", ks), match got { Some(v) => format!("\"{}\"", S::first_word(&v)), None => "null".into() })
            }
            Kind::Get => {
                let (k, ks) = if !present.is_empty() && rng.below(2) == 0 {
                    present[rng.below(present.len() as u64) as usize].clone()
                } else {
                    shape.key(&mut rng, domain)
                };
                let got = tree_ref.get(&k);
                (format!("[\"g\",{}]", ks), match got { Some(v) => format!("\"{}\"", S::first_word(v)), None => "null".into() })
            }
            Kind::Min => ("[\"mn\"]".into(), tree_ref.get_min_index().to_string()),
            Kind::Max => ("[\"mx\"]".into(), tree_ref.get_max_index().to_string()),
            Kind::Addr => {
                // A present key mostly (the tail: the first addrOf a present one, the second a fresh draw).
                let pick_present = if tail == 3 { true } else if tail == 4 { false } else { rng.below(3) != 0 };
                let (k, ks) = if pick_present && !present.is_empty() {
                    present[rng.below(present.len() as u64) as usize].clone()
                } else {
                    shape.key(&mut rng, domain)
                };
                (format!("[\"a\",{}]", ks), tree_ref.get_addr(&k).to_string())
            }
            Kind::Iter => {
                let rev = rng.below(2) == 0;
                let limit = if rng.below(2) == 0 { 0 } else { rng.below(N as u64 + 2) };
                let take = if limit == 0 { usize::MAX } else { limit as usize };
                let (mut count, mut h) = (0u32, 2166136261u32);
                if rev {
                    for (k, _) in tree_ref.iter().rev().take(take) {
                        count += 1;
                        h = fnv1a32(h, index_of(k));
                    }
                } else {
                    for (k, _) in tree_ref.iter().take(take) {
                        count += 1;
                        h = fnv1a32(h, index_of(k));
                    }
                }
                (format!("[\"{}\",{}]", if rev { "b" } else { "f" }, limit), format!("[{},{}]", count, h))
            }
        };
        if tail > 0 {
            tail += 1;
        }
        if name != "mixed" { assert_eq!(tree_ref.len(), present.len(), "model drift"); }
        let bytes: &[u8] = unsafe { std::slice::from_raw_parts(base as *const u8, size) };
        let digest = Sha256::digest(bytes);
        if step > 0 {
            ops.push(',');
            res.push(',');
            hashes.push(',');
        }
        ops.push_str(&op.0);
        res.push_str(&op.1);
        hashes.push('"');
        for b in &digest[..8] {
            write!(hashes, "{:02x}", b).unwrap();
        }
        hashes.push('"');
        step += 1;
    }
    writeln!(out, "{{\"shape\":\"{}\",\"cap\":{},\"seed\":{},\"ops\":[{}],\"res\":[{}],\"hash\":[{}]}}", name, N, seed, ops, res, hashes).unwrap();
    step
}

macro_rules! caps {
    ($shape:expr, $name:expr, $cap:expr, $seed:expr, $nops:expr, $cycles:expr, $fill:expr, $out:expr, [$($n:literal),*]) => {
        match $cap {
            $($n => run::<_, $n>($shape, $name, $seed, $nops, $cycles, $fill, $out),)*
            _ => panic!("capacity {} not compiled in", $cap),
        }
    };
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let path = &a[1];
    let first: u64 = a[2].parse().unwrap();
    let count: u64 = a[3].parse().unwrap();
    let nops: usize = a[4].parse().unwrap();
    let shapes: Vec<String> = a.get(5).map(|s| s.split(',').map(String::from).collect()).unwrap_or_else(|| vec!["u64".into(), "bid".into(), "ask".into(), "trader".into()]);
    let caps: Vec<usize> = a.get(6).map(|s| s.split(',').map(|c| c.parse().unwrap()).collect()).unwrap_or_else(|| vec![1, 2, 3, 7, 64, 512]);
    let cycles: u64 = a.get(7).map(|s| s.parse().unwrap()).unwrap_or(0);
    let fill_to: usize = a.get(8).map(|s| s.parse().unwrap()).unwrap_or(usize::MAX);
    let mut f = std::fs::File::create(path).unwrap();
    let mut total = 0usize;
    for seed in first..first + count {
        for shape in &shapes {
            for &cap in &caps {
                let mut line = String::new();
                total += match shape.as_str() {
                    "u64" => caps!(&U64Shape, "u64", cap, seed, nops, cycles, fill_to, &mut line, [1, 2, 3, 7, 64, 512, 4096]),
                    "bid" => caps!(&FifoShape(0), "bid", cap, seed, nops, cycles, fill_to, &mut line, [1, 2, 3, 7, 64, 512, 4096]),
                    "ask" => caps!(&FifoShape(1), "ask", cap, seed, nops, cycles, fill_to, &mut line, [1, 2, 3, 7, 64, 512, 4096]),
                    "mixed" => caps!(&FifoShape(2), "mixed", cap, seed, nops, cycles, fill_to, &mut line, [1, 2, 3, 7, 64, 512, 4096]),
                    "trader" => caps!(&TraderShape, "trader", cap, seed, nops, cycles, fill_to, &mut line, [1, 2, 3, 7, 64, 512, 4096]),
                    s => panic!("unknown shape {}", s),
                };
                f.write_all(line.as_bytes()).unwrap();
            }
        }
    }
    eprintln!("{} operations", total);
}
