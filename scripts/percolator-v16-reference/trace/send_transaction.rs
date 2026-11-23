    // Spliced into LiteSVM 0.1.0 (src/lib.rs, Apache-2.0) in place of the first two lines of `send_transaction` by
    // scripts/percolator-v16-reference/author-suite.sh when TRACE=1 (showcase/mainnet/percolator-v16/TESTING.md).
    // With PERCOLATOR_TRACE_DIR set, every transaction a test sends appends one line to <dir>/<test name>.trace: the
    // programs and first data bytes of its instructions, a hash of the instructions and account keys, the result,
    // hashes of the return data and of the log lines (the compute-unit lines and the port's branch probes left out),
    // a hash of every account the transaction names after it ran (key, lamports, owner, data; executable accounts
    // by key only, since the program under test is one of them), the compute units and, with
    // PERCOLATOR_TRACE_PROBES set, the port's branch probes reached. The original body follows
    // unchanged as `send_transaction_untraced`.
    pub fn send_transaction(&mut self, tx: impl Into<VersionedTransaction>) -> TransactionResult {
        let vtx: VersionedTransaction = tx.into();
        let dir = match std::env::var("PERCOLATOR_TRACE_DIR") { Ok(d) => d, Err(_) => return self.send_transaction_untraced(vtx) };
        fn fnv(h: &mut u64, d: &[u8]) { for b in d { *h ^= *b as u64; *h = h.wrapping_mul(0x100000001b3); } }
        let keys: Vec<Pubkey> = vtx.message.static_account_keys().to_vec();
        let mut ixh: u64 = 0xcbf29ce484222325;
        let mut tags = String::new();
        for ix in vtx.message.instructions() {
            let p = keys[ix.program_id_index as usize];
            fnv(&mut ixh, p.as_ref()); fnv(&mut ixh, &ix.accounts); fnv(&mut ixh, &ix.data);
            let ps = p.to_string();
            if !ps.starts_with("ComputeBudget") { tags.push_str(&format!("{}:{},", &ps[..4], ix.data.first().copied().unwrap_or(255))); }
        }
        for k in &keys { fnv(&mut ixh, k.as_ref()); }
        let result = self.send_transaction_untraced(vtx);
        let (res, meta) = match &result { Ok(m) => ("ok".to_string(), m), Err(f) => (format!("err:{:?}", f.err).replace(' ', ""), &f.meta) };
        let mut lh: u64 = 0xcbf29ce484222325;
        let mut nlogs = 0usize;
        for l in &meta.logs { if l.contains(" consumed ") || l.starts_with("Program log: 0xc0de, ") { continue; } fnv(&mut lh, l.as_bytes()); fnv(&mut lh, b"\n"); nlogs += 1; }
        let mut rh: u64 = 0xcbf29ce484222325; fnv(&mut rh, meta.return_data.program_id.as_ref()); fnv(&mut rh, &meta.return_data.data);
        let mut ah: u64 = 0xcbf29ce484222325;
        for k in &keys {
            match self.accounts.get_account(k) {
                Some(a) if !solana_sdk::account::ReadableAccount::executable(&a) => {
                    fnv(&mut ah, k.as_ref()); fnv(&mut ah, &solana_sdk::account::ReadableAccount::lamports(&a).to_le_bytes());
                    fnv(&mut ah, solana_sdk::account::ReadableAccount::owner(&a).as_ref()); fnv(&mut ah, solana_sdk::account::ReadableAccount::data(&a));
                }
                Some(_) => { fnv(&mut ah, k.as_ref()); fnv(&mut ah, b"x"); }
                None => { fnv(&mut ah, k.as_ref()); fnv(&mut ah, b"-"); }
            }
        }
        let name: String = std::thread::current().name().unwrap_or("main").chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '.' }).collect();
        let name = if name.len() > 200 { format!("{}-{:016x}", &name[..180], { let mut h = 0xcbf29ce484222325u64; fnv(&mut h, name.as_bytes()); h }) } else { name };
        // The whole line goes out in one write under a process-wide lock: the author's bounded-frontier tests replay
        // their words on unnamed worker threads (std::thread::scope), which all write to main.trace, and a line written
        // piece by piece would interleave with theirs. A trace that cannot be opened or written stops the test.
        // PERCOLATOR_TRACE_PROBES: the branch probes of a probed port (coverage.ts) the transaction reached, by id.
        let probes = if std::env::var("PERCOLATOR_TRACE_PROBES").is_ok() {
            let ids: Vec<&str> = meta.logs.iter().filter_map(|l| l.strip_prefix("Program log: 0xc0de, 0x")).filter_map(|r| r.split(',').next()).collect();
            format!(" probes={}", ids.join(","))
        } else { String::new() };
        let line = format!("{} ix={:016x} res={} ret={:016x} logs={}/{:016x} accs={:016x} cu={}{}\n", tags, ixh, res, rh, nlogs, lh, ah, meta.compute_units_consumed, probes);
        {
            use std::io::Write;
            static TRACE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
            let _guard = TRACE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let path = format!("{}/{}.trace", dir, name);
            let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&path).unwrap_or_else(|e| panic!("trace {path}: {e}"));
            f.write_all(line.as_bytes()).unwrap_or_else(|e| panic!("trace {path}: {e}"));
        }
        result
    }

    fn send_transaction_untraced(&mut self, vtx: VersionedTransaction) -> TransactionResult {
