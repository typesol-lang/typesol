// The host program of scripts/percolator-v16-reference/kernels.ts --primitives: an example of A COPY of the pinned
// engine crate (aeyakovenko/percolator 5e3af071, Apache-2.0), built in Docker, that reads the vectors of
// showcase/test/percolator-v16-primitives.ts and prints the engine's answer to each (typesol_harness.rs `call_market`).
//
// Input (/vectors/input.bin): u32 count, then per vector: u8 function id, 8 × 16-byte arguments, u32 market length,
// u32 portfolio length, the market account, the portfolio account. Output, one line per vector: `V <index> <answer>`,
// the answer as typesol_kernels.rs prints it, the changed bytes numbered over the market followed by the portfolio.
use percolator::typesol_harness::{call_market, Answer};
use std::cell::RefCell;
use std::panic::{self, AssertUnwindSafe};

thread_local! {
    static PANIC: RefCell<String> = RefCell::new(String::new());
}

fn take<'a>(b: &'a [u8], at: &mut usize, n: usize) -> &'a [u8] {
    let s = &b[*at..*at + n];
    *at += n;
    s
}

fn main() {
    panic::set_hook(Box::new(|info| {
        let loc = info.location().map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column())).unwrap_or_default();
        let msg = if let Some(s) = info.payload().downcast_ref::<&str>() {
            s.to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            String::new()
        };
        PANIC.with(|p| *p.borrow_mut() = format!("{} {}", loc, msg));
    }));
    let buf = std::fs::read("/vectors/input.bin").unwrap();
    let mut at = 0usize;
    let n = u32::from_le_bytes(take(&buf, &mut at, 4).try_into().unwrap());
    let mut out = String::new();
    for index in 0..n {
        let f = take(&buf, &mut at, 1)[0];
        let mut args = [[0u8; 16]; 8];
        for a in args.iter_mut() {
            a.copy_from_slice(take(&buf, &mut at, 16));
        }
        let mlen = u32::from_le_bytes(take(&buf, &mut at, 4).try_into().unwrap()) as usize;
        let plen = u32::from_le_bytes(take(&buf, &mut at, 4).try_into().unwrap()) as usize;
        let before: Vec<u8> = take(&buf, &mut at, mlen + plen).to_vec();
        let mut bytes = before.clone();
        let answer = {
            let (market, portfolio) = bytes.split_at_mut(mlen);
            panic::catch_unwind(AssertUnwindSafe(|| call_market(f, &args, market, portfolio)))
        };
        let line = match answer {
            Ok(Answer::Ok(values, count)) => {
                let vals: Vec<String> = values[..count].iter().map(|v| v.to_string()).collect();
                let diff: Vec<String> = before
                    .iter()
                    .zip(bytes.iter())
                    .enumerate()
                    .filter(|(_, (x, y))| x != y)
                    .map(|(i, (_, y))| format!("{}:{:02x}", i, y))
                    .collect();
                let diff = if diff.is_empty() { "-".to_string() } else { diff.join(",") };
                if vals.is_empty() {
                    format!("ok | {}", diff)
                } else {
                    format!("ok {} | {}", vals.join(" "), diff)
                }
            }
            Ok(Answer::Err(e)) => format!("Err({:?})", e),
            Ok(Answer::Decode) => "decode".to_string(),
            Err(_) => format!("panic {}", PANIC.with(|p| p.borrow().clone())),
        };
        out.push_str(&format!("V {} {}\n", index, line));
    }
    print!("{}", out);
}
