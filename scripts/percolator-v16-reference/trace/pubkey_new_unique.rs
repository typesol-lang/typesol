    // Spliced into solana-program 1.18.26 (src/pubkey.rs, Apache-2.0) in place of `Pubkey::new_unique` by
    // scripts/percolator-v16-reference/author-suite.sh when TRACE=1: the counter is the test thread's own (the original
    // one is shared by the threads running tests side by side), so that a test makes the same keys in every run.
    pub fn new_unique() -> Self {
        thread_local! { static NEXT: std::cell::Cell<u64> = std::cell::Cell::new(1); }
        let i = NEXT.with(|c| { let v = c.get(); c.set(v + 1); v });
        let mut b = [0u8; 32];
        // use big endian representation to ensure that recent unique pubkeys
        // are always greater than less recent unique pubkeys
        b[0..8].copy_from_slice(&i.to_be_bytes());
        Self::from(b)
    }
