//! Trace oracle for TypeSOL's built-in RedBlackTree: runs lib-sokoban 0.3.0's RedBlackTree<K, V, N> (the real crate)
//! on random operation traces and records, after every operation, its result and a hash of the tree's bytes.
//! Not needed by the tests (they read the recorded JSON); `../regenerate.sh` rebuilds the committed traces.
//!
//!   cargo run --release -- <out.jsonl> <first-seed> <seed-count> <ops-per-trace> [shapes,comma] [caps,comma]
//!
//! Shapes: u64 (u64 -> u64, stride 32), bid / ask / mixed (Phoenix's FIFOOrderId -> FIFORestingOrder, stride 64; bid
//! keys have the sequence number's top bit set, ask keys clear, mixed either), trader (Pubkey -> Phoenix's
//! TraderState, stride 144). Capacities 1, 2, 3, 7, 64, 512 and 4096 are compiled in. Traces mix random phases with
//! fill-to-capacity and drain-to-empty phases (each at least 1.5 × N operations long), keys from a domain of 2N + 3
//! (equal keys meet; inserts into a full tree, re-inserts after removals, the free list drained and refilled).
//!
//! One JSON line per (shape, capacity, seed): {"shape","cap","seed","ops":[…],"res":[…],"hash":[…]}.
//! Encodings shared with the TypeSOL replay (test/verification/rbtree-trace.test.ts):
//! - splitmix64 as below; a value from `vseed` is words splitmix64(vseed + j), j = 0.. (little-endian);
//! - u64 keys and FIFOOrderId parts as decimal strings; a Pubkey key from `kseed`: bytes 0..16 the words
//!   splitmix64(1000 + kseed % 3 + j), bytes 16..32 the words splitmix64(kseed * 2 + j) (so keys share prefixes);
//! - ops: ["i", key, vseed] insert, ["r", key] remove, ["g", key] get, ["mn"] / ["mx"] min / max index,
//!   ["f", limit] / ["b", limit] forward / reverse iteration of at most `limit` entries (0: all);
//! - results: insert → node index or -1; remove / get → the value's first word (decimal string) or null;
//!   min / max → node index (0: empty); iteration → [count, fnv1a32 of the node indices visited, as u32 LE];
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

fn run<S: Shape, const N: usize>(shape: &S, name: &str, seed: u64, nops: usize, out: &mut String) {
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

    let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9) ^ (N as u64) << 40 ^ (name.len() as u64) << 56);
    let domain = (2 * N as u64 + 3).max(4);
    let mut present: Vec<(S::K, String)> = Vec::new();
    let mut ops = String::new();
    let mut res = String::new();
    let mut hashes = String::new();
    let mut phase = 0u64; // 0 random, 1 fill, 2 drain
    for step in 0..nops {
        if step % (97usize.max(3 * N / 2)) == 0 {
            phase = rng.below(5).min(2) * (rng.below(2) + 1) % 3;
        }
        let r = rng.below(100);
        let op: (String, String);
        let tree_ref: &mut T<S, N> = unsafe { &mut *(tree as *mut T<S, N>) };
        if (phase == 1 && r < 85) || (phase == 0 && r < 40) || (phase == 2 && r < 10) {
            let (k, ks) = if !present.is_empty() && rng.below(6) == 0 {
                present[rng.below(present.len() as u64) as usize].clone()
            } else {
                shape.key(&mut rng, domain)
            };
            let vseed = rng.next() >> 40;
            let got = tree_ref.insert(k, S::value(vseed));
            if got.is_some() && !present.iter().any(|(p, _)| *p == k) {
                present.push((k, ks.clone()));
            }
            op = (format!("[\"i\",{},{}]", ks, vseed), match got { Some(i) => i.to_string(), None => "-1".into() });
        } else if (phase == 2 && r < 85) || (phase == 0 && r < 65) || (phase == 1 && r < 92) {
            let (k, ks) = if !present.is_empty() && rng.below(5) != 0 {
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
            op = (format!("[\"r\",{}]", ks), match got { Some(v) => format!("\"{}\"", S::first_word(&v)), None => "null".into() });
        } else if r < 75 || (phase != 0 && r < 95) {
            let (k, ks) = if !present.is_empty() && rng.below(2) == 0 {
                present[rng.below(present.len() as u64) as usize].clone()
            } else {
                shape.key(&mut rng, domain)
            };
            let got = tree_ref.get(&k);
            op = (format!("[\"g\",{}]", ks), match got { Some(v) => format!("\"{}\"", S::first_word(v)), None => "null".into() });
        } else if r < 82 {
            let i = tree_ref.get_min_index();
            op = ("[\"mn\"]".into(), i.to_string());
        } else if r < 89 {
            let i = tree_ref.get_max_index();
            op = ("[\"mx\"]".into(), i.to_string());
        } else {
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
            op = (format!("[\"{}\",{}]", if rev { "b" } else { "f" }, limit), format!("[{},{}]", count, h));
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
    }
    writeln!(out, "{{\"shape\":\"{}\",\"cap\":{},\"seed\":{},\"ops\":[{}],\"res\":[{}],\"hash\":[{}]}}", name, N, seed, ops, res, hashes).unwrap();
}

macro_rules! caps {
    ($shape:expr, $name:expr, $cap:expr, $seed:expr, $nops:expr, $out:expr, [$($n:literal),*]) => {
        match $cap {
            $($n => run::<_, $n>($shape, $name, $seed, $nops, $out),)*
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
    let mut f = std::fs::File::create(path).unwrap();
    let mut total = 0usize;
    for seed in first..first + count {
        for shape in &shapes {
            for &cap in &caps {
                let mut line = String::new();
                match shape.as_str() {
                    "u64" => caps!(&U64Shape, "u64", cap, seed, nops, &mut line, [1, 2, 3, 7, 64, 512, 4096]),
                    "bid" => caps!(&FifoShape(0), "bid", cap, seed, nops, &mut line, [1, 2, 3, 7, 64, 512, 4096]),
                    "ask" => caps!(&FifoShape(1), "ask", cap, seed, nops, &mut line, [1, 2, 3, 7, 64, 512, 4096]),
                    "mixed" => caps!(&FifoShape(2), "mixed", cap, seed, nops, &mut line, [1, 2, 3, 7, 64, 512, 4096]),
                    "trader" => caps!(&TraderShape, "trader", cap, seed, nops, &mut line, [1, 2, 3, 7, 64, 512, 4096]),
                    s => panic!("unknown shape {}", s),
                }
                f.write_all(line.as_bytes()).unwrap();
                total += nops;
            }
        }
    }
    eprintln!("{} operations", total);
}
