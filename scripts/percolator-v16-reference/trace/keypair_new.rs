    // Spliced into solana-sdk 1.18.26 (src/signer/keypair.rs, Apache-2.0) in place of `Keypair::new` by
    // scripts/percolator-v16-reference/author-suite.sh when TRACE=1: the n-th key a test thread makes is derived from
    // the thread's name (libtest names it after the test) and n, so that two runs of a test against two binaries make
    // the same keys (and the same PDA bumps) and their transactions can be compared byte for byte.
    pub fn new() -> Self {
        thread_local! { static MADE: std::cell::Cell<u64> = std::cell::Cell::new(0); }
        let n = MADE.with(|c| { let v = c.get(); c.set(v + 1); v });
        let name = std::thread::current().name().unwrap_or("main").to_string();
        let mut seed = [0u8; 32];
        for (j, chunk) in seed.chunks_mut(8).enumerate() {
            let mut h: u64 = 0xcbf29ce484222325;
            for b in name.bytes().chain(n.to_le_bytes()).chain([j as u8, 0x4b]) { h ^= b as u64; h = h.wrapping_mul(0x100000001b3); }
            chunk.copy_from_slice(&h.to_le_bytes());
        }
        keypair_from_seed(&seed).expect("32-byte seed")
    }
