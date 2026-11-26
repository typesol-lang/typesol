//! A probe of the entrypoint of Percolator v16 at commit 7b110913 (engine 5e3af07; aeyakovenko/percolator-prog,
//! Apache-2.0): pinocchio 0.11.1's `entrypoint!` and the account shim of percolator-prog's `mod entrypoint`
//! (`process_with_legacy_account_infos`, reproduced below) in front of a few operations that panic, allocate or
//! borrow on demand. The reference cannot yet be driven to those failures with the instructions the port has reached,
//! so showcase/test/percolator-v16-reference.test.ts runs this binary to record what the same entrypoint, allocator
//! and panic hook do there, built with the same toolchain (../probe.sh).
//!
//! The first instruction byte picks the operation:
//! - 0: `panic!` in this file;
//! - 1: an index out of bounds (the index is data[1]) in this file;
//! - 2: `Vec::<u64>::with_capacity(data[1..9] as usize)`: Rust's capacity check, inside `alloc`;
//! - 3: allocate data[1..5] bytes, write the last one and set the heap position as return data;
//! - 4: through the shim, `try_borrow_mut_data` of account 0, then of account 1;
//! - 5: through the shim, `try_borrow_mut_data` of account 0, then `data.borrow_mut()` of account 1 (a panic in
//!   this file when they are the same account);
//! - 6: through the shim, `try_borrow_mut_lamports` of account 0, then `lamports()` of account 1 (a panic inside
//!   solana-program when they are the same account);
//! - 7: through the shim: the number of accounts and every account's first key byte as return data;
//! - anything else, or no data: `InvalidInstructionData`.
#![allow(unexpected_cfgs)]
extern crate alloc;

use alloc::{rc::Rc, vec::Vec};
use core::{cell::RefCell, hint::black_box, mem::size_of, slice::from_raw_parts_mut};
use pinocchio::{
    account::{AccountView, RuntimeAccount},
    address::Address,
    entrypoint,
    error::ProgramError,
    ProgramResult,
};
use solana_program::{account_info::AccountInfo, clock::Epoch, program::set_return_data, program_error::ProgramError as LegacyProgramError, pubkey::Pubkey};

entrypoint!(process_instruction);

fn process_instruction(_program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    match data.first() {
        Some(0) => panic!("probe"),
        Some(1) => {
            let table = black_box([1u8, 2, 3, 4]);
            let i = black_box(data[1] as usize);
            if table[i] == 0 {
                return Err(ProgramError::Custom(1));
            }
            Ok(())
        }
        Some(2) => {
            let n = u64::from_le_bytes(data[1..9].try_into().unwrap()) as usize;
            let v: Vec<u64> = Vec::with_capacity(black_box(n));
            black_box(&v);
            Ok(())
        }
        Some(3) => {
            let n = u32::from_le_bytes(data[1..5].try_into().unwrap()) as usize;
            let mut v: Vec<u8> = Vec::with_capacity(black_box(n));
            unsafe { v.as_mut_ptr().add(n - 1).write_volatile(1) };
            let at = v.as_ptr() as u64;
            black_box(&v);
            set_return_data(&at.to_le_bytes());
            Ok(())
        }
        Some(4..=7) => with_legacy_account_infos(accounts, |infos| shim_op(data[0], infos)).map_err(map_legacy_error),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

fn shim_op(op: u8, a: &[AccountInfo<'_>]) -> Result<(), LegacyProgramError> {
    match op {
        4 => {
            let _first = a[0].try_borrow_mut_data()?;
            let _second = a[1].try_borrow_mut_data()?;
            Ok(())
        }
        5 => {
            let _first = a[0].try_borrow_mut_data()?;
            let second = a[1].data.borrow_mut();
            black_box(second.len());
            Ok(())
        }
        6 => {
            let _first = a[0].try_borrow_mut_lamports()?;
            black_box(a[1].lamports());
            Ok(())
        }
        _ => {
            let mut out = Vec::with_capacity(a.len() + 2);
            out.extend_from_slice(&(a.len() as u16).to_le_bytes());
            for info in a {
                out.push(info.key.to_bytes()[0]);
            }
            set_return_data(&out);
            Ok(())
        }
    }
}

// percolator-prog 7b110913, src/v16_program.rs `mod entrypoint`: the legacy AccountInfo built over pinocchio's views,
// duplicates sharing one Rc<RefCell<…>> (found by a pointer scan), and the error mapping.
fn with_legacy_account_infos(
    accounts: &mut [AccountView],
    f: impl FnOnce(&[AccountInfo<'_>]) -> Result<(), LegacyProgramError>,
) -> Result<(), LegacyProgramError> {
    let len = accounts.len();
    let mut lamports = Vec::with_capacity(len);
    let mut data = Vec::with_capacity(len);
    for i in 0..len {
        if let Some(first) = first_duplicate(accounts, i) {
            lamports.push(Rc::clone(&lamports[first]));
            data.push(Rc::clone(&data[first]));
            continue;
        }
        let raw = accounts[i].account_mut_ptr();
        let lamports_ref = unsafe { &mut (*raw).lamports };
        let data_ref = unsafe { from_raw_parts_mut((raw as *mut u8).add(size_of::<RuntimeAccount>()), (*raw).data_len as usize) };
        lamports.push(Rc::new(RefCell::new(lamports_ref)));
        data.push(Rc::new(RefCell::new(data_ref)));
    }
    let mut legacy = Vec::with_capacity(len);
    for (i, account) in accounts.iter().enumerate() {
        let key = unsafe { &*(account.address() as *const Address as *const Pubkey) };
        let owner = unsafe { &*(account.owner() as *const Address as *const Pubkey) };
        legacy.push(AccountInfo {
            key,
            lamports: Rc::clone(&lamports[i]),
            data: Rc::clone(&data[i]),
            owner,
            rent_epoch: Epoch::default(),
            is_signer: account.is_signer(),
            is_writable: account.is_writable(),
            executable: account.executable(),
        });
    }
    f(&legacy)
}

fn first_duplicate(accounts: &[AccountView], index: usize) -> Option<usize> {
    let ptr = accounts[index].account_ptr();
    (0..index).find(|&i| accounts[i].account_ptr() == ptr)
}

fn map_legacy_error(error: LegacyProgramError) -> ProgramError {
    match error {
        LegacyProgramError::Custom(code) => ProgramError::Custom(code),
        LegacyProgramError::AccountBorrowFailed => ProgramError::AccountBorrowFailed,
        _ => ProgramError::InvalidArgument,
    }
}
