# Experiment: Lua on wasm32-unknown-unknown via LUAI_TRY/LUAI_THROW Override

**Date**: 2026-03-16
**Branch**: `experiment/lua-wasm`
**Worktree**: `~/src/q2-lua-wasm-spike` (git worktree of `~/src/q2`)
**Status**: BLOCKED — panic unwind not working in WASM runtime (see Current Blocker below)
**Context**: [Investigation](../investigations/2026-03-16-lua-wasm-options.md) — Option 8

## Goal

Prove that we can compile mlua + PUC-Rio Lua 5.4 for `wasm32-unknown-unknown`
and run a real Lua filter in the hub-client WASM build. This is an experiment —
right architecture, not a perfectly clean implementation. Demo target: work week.

---

## Context for Fresh Agents

This is a Rust monorepo (Quarto) where the hub-client web app uses a WASM build
of the rendering engine. The WASM build targets `wasm32-unknown-unknown` (bare,
no libc). The experiment adds Lua scripting support to the WASM build.

### Key files in this worktree

- `crates/wasm-quarto-hub-client/` — The WASM crate (excluded from workspace, has own Cargo.toml)
  - `src/c_shim.rs` — Rust implementations of C libc functions for WASM (malloc, strlen, etc.)
  - `src/lib.rs` — WASM entry points, includes `test_lua()` function
  - `wasm-sysroot/` — Stub C headers for compilation
  - `.cargo/config.toml` — Build flags including `-Zbuild-std` and `+exception-handling`
  - `Cargo.toml` — Has `[patch.crates-io]` for lua-src and wasm-bindgen-futures
  - `test-lua-wasm.mjs` — Node.js test script that patches JS glue and runs Lua tests
- `crates/lua-src-wasm/` — Forked lua-src with wasm32-unknown-unknown support
  - `lua-5.4.8/luaconf_wasm.h` — Overrides LUAI_TRY/LUAI_THROW to use Rust catch_unwind/panic
  - `src/lib.rs` — Build script with wasm32 match arm
- `crates/wasm-bindgen-futures-patch/` — Patched wasm-bindgen-futures 0.4.58
  - Removes `UnwindSafe` bound from `future_to_promise` (needed for panic=unwind compat)
- `crates/pampa/src/lib.rs` — Has `lua_wasm_test()` function that creates Lua VM and evals script

### How to build

```bash
cd crates/wasm-quarto-hub-client

# Method 1: wasm-pack (does NOT support -Zbuild-std, so no panic unwind)
CFLAGS_wasm32_unknown_unknown="-I$(pwd)/wasm-sysroot -fno-builtin -DHAVE_ENDIAN_H -fwasm-exceptions" \
CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/clang \
PATH="/opt/homebrew/opt/llvm/bin:$PATH" \
wasm-pack build --target web

# Method 2: cargo build + wasm-bindgen (supports -Zbuild-std via .cargo/config.toml)
CFLAGS_wasm32_unknown_unknown="-I$(pwd)/wasm-sysroot -fno-builtin -DHAVE_ENDIAN_H -fwasm-exceptions" \
CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/clang \
cargo build --target wasm32-unknown-unknown --release
# Then: wasm-bindgen --target web --out-dir pkg target/wasm32-unknown-unknown/release/wasm_quarto_hub_client.wasm
```

### How to test

```bash
cd crates/wasm-quarto-hub-client
node test-lua-wasm.mjs
```

The test script patches out hub-client JS bridge imports and runs Lua scripts through WASM.

---

## Current Blocker: WASM panic unwind

**The WASM binary compiles, links, and instantiates — but Lua calls hit `unreachable` traps.**

The core problem: Lua's error handling uses `panic!()` (via `rust_lua_throw`) which needs
to unwind through C frames. On wasm32, panics default to abort. We need:

1. **`-Cpanic=unwind`** — Tell rustc to emit unwind info instead of abort
2. **`-Ctarget-feature=+exception-handling`** — Enable WASM exception handling instructions
3. **`-Zbuild-std=std,panic_unwind`** — Rebuild std with unwind support for wasm32
4. **`-fwasm-exceptions`** on C code — Already set via CFLAGS

The `.cargo/config.toml` has flags #1, #2, #3 configured. The `cargo build` method
compiles successfully. But at runtime, Lua operations still hit `unreachable` traps.

**Diagnosis needed**: The panic unwind may not actually be working despite the flags.
Possible causes:
- The WASM exception handling feature might not be supported by the Node.js version
  being used (need `--experimental-wasm-eh` or Node 20+)
- The `-Zbuild-std` might not be properly rebuilding `panic_unwind` (check if
  `catch_unwind` actually catches panics vs aborts)
- The C code might need additional flags beyond `-fwasm-exceptions`
- `wasm-opt` (run by wasm-pack) might strip exception handling sections

**Recommended next steps**:
1. Build a MINIMAL test (no hub-client, just a tiny WASM module that does
   `catch_unwind(|| panic!("test"))`) to verify the toolchain works
2. Check Node.js version supports WASM EH: `node --print 'process.version'`
3. Compare with the working test at `/tmp/wasm-unwind-test/` (from the investigation)
4. Once the minimal test works, apply the same build flags to the full crate

**Important**: The previous investigation at `/tmp/wasm-unwind-test/` DID get
`catch_unwind` working through C frames in WASM. That test used:
- nightly Rust with `-Zbuild-std=std,panic_unwind`
- `-Cpanic=unwind -Ctarget-feature=+exception-handling` as RUSTFLAGS
- `-fwasm-exceptions` for C compilation
- `extern "C-unwind"` for all FFI functions
- Node.js to run the WASM

The key difference between that test and our current build might be how wasm-pack
or the cdylib linking interacts with build-std, or the wasm-opt post-processing.

---

## Background: The Problem

Our hub-client is a browser app that uses a WASM build of the Quarto rendering
engine for live preview. The WASM build targets `wasm32-unknown-unknown` with
`wasm-bindgen` (the standard Rust-in-browser toolchain).

Quarto supports **Lua filters** — user scripts that transform the document AST.
The filter engine lives in `crates/pampa/src/lua/` (~24,600 lines) and is built
on **mlua** (Rust bindings to PUC-Rio Lua 5.4 via C FFI). It's gated behind a
`lua-filter` cargo feature.

The WASM build currently disables `lua-filter` because Lua's C implementation
uses `setjmp`/`longjmp` for error handling, and `wasm32-unknown-unknown` has
**no libc, no setjmp, no longjmp** — it's a bare execution environment.

This experiment overrides Lua's error handling to use Rust's `panic!`/`catch_unwind`
instead, which DO work on WASM with the right compiler flags.

## Background: The Codebase

### Workspace structure (relevant crates)

```
crates/
  pampa/                     # Core Quarto engine
    src/lua/                 # Lua filter engine (~24,600 LOC on mlua)
      filter.rs              # Traversal engine (typewise/topdown)
      types.rs               # AST <-> Lua UserData marshalling
      constructors.rs        # ~30+ pandoc.* element constructors
      list.rs                # pandoc.List metatable
      utils.rs               # pandoc.utils.* namespace
      ...                    # 14 files total
    Cargo.toml               # lua-filter = ["dep:mlua"] feature flag
  quarto-core/               # Higher-level orchestration
    src/pipeline.rs          # Native pipeline has UserFiltersStage; WASM pipeline does NOT
  wasm-quarto-hub-client/    # WASM crate for hub-client
    src/c_shim.rs            # Rust implementations of libc functions for C code in WASM
    src/lib.rs               # Entry point, includes c_shim and test_lua()
    wasm-sysroot/            # Stub C headers (stdio.h, stdlib.h, string.h, etc.)
    Cargo.toml               # pampa with lua-filter enabled, patches for lua-src and wasm-bindgen-futures
  wasm-qmd-parser/           # Older/lighter WASM crate (also has c_shim + wasm-sysroot)
  lua-src-wasm/              # FORKED lua-src with wasm32-unknown-unknown support
  wasm-bindgen-futures-patch/ # Patched wasm-bindgen-futures (UnwindSafe bound removed)
hub-client/
  scripts/build-wasm.js      # Builds WASM via wasm-pack, sets CFLAGS for C compilation
```

### How the WASM build works today

The hub-client's WASM module is built by `hub-client/scripts/build-wasm.js`:
1. Sets `CC_wasm32_unknown_unknown` to homebrew LLVM clang
2. Sets `CFLAGS_wasm32_unknown_unknown="-I{wasm-sysroot} -fno-builtin -DHAVE_ENDIAN_H"`
3. Runs `wasm-pack build --target web` on `crates/wasm-quarto-hub-client`

C code (currently just tree-sitter parsers) compiles to WASM using the
`cc` crate + homebrew LLVM (`/opt/homebrew/opt/llvm/bin/clang`), which supports
the `wasm32-unknown-unknown` target. Missing libc functions are provided by
Rust implementations in `c_shim.rs` (malloc, free, memcpy, snprintf, etc.)
with corresponding header stubs in `wasm-sysroot/`.

### How mlua and lua-src work

- **mlua** (v0.11): Rust bindings to Lua. Crate at `~/src/mlua/` (local checkout).
  - `mlua-sys/src/lua54/`: FFI declarations — all use `extern "C-unwind"` (critical!)
  - `mlua-sys/build/find_vendored.rs`: calls `lua_src::Build::new().build(lua_src::Lua54)`
- **lua-src** (v550.0.0): Compiles Lua C source via `cc` crate.
  - Source repo: `~/src/lua-src-rs/` (clone of https://github.com/mlua-rs/lua-src-rs)
  - `src/lib.rs`: Build script with target-matching chain (linux/mac/windows/emscripten/wasi)
  - **`wasm32-unknown-unknown` is NOT supported** — falls through to error at line 210
  - `lua-5.4.8/`: The actual Lua C source code
  - `lua-5.4.8/ldo.c`: Error handling — `LUAI_TRY`/`LUAI_THROW` macros (lines 48-79)

### Feature gating

- `pampa/Cargo.toml`: `lua-filter = ["dep:mlua"]`
- `crates/quarto/Cargo.toml` (CLI binary): enables `lua-filter`
- `crates/wasm-quarto-hub-client/Cargo.toml`: NOW enables `lua-filter` (was disabled)
- `pampa/src/unified_filter.rs`: `FilterSpec::Lua` arm gated on `#[cfg(feature = "lua-filter")]`
- `quarto-core/src/pipeline.rs`: WASM pipeline omits `UserFiltersStage`

---

## Proven So Far (from prior investigation)

We built and ran a test at `/tmp/wasm-unwind-test/` that proved:

1. **`catch_unwind` works on `wasm32-unknown-unknown`** with nightly Rust +
   `-Zbuild-std=std,panic_unwind` + `-Cpanic=unwind` + `-Ctarget-feature=+exception-handling`
2. **Panics unwind correctly through C frames** when:
   - Rust functions use `extern "C-unwind"` (not `extern "C"` — that aborts!)
   - C code is compiled with `-fwasm-exceptions`
3. **mlua-sys already uses `extern "C-unwind"`** for all 20 Lua API declarations in lua54
4. **All 5 progressive tests passed** in Node.js:
   - No error (baseline)
   - Pure Rust catch_unwind → panic (caught)
   - Rust → Rust catch_unwind → Rust callback → panic (caught)
   - Rust → C frame → Rust catch_unwind → Rust callback → panic (caught)
   - Rust → C frame → Rust catch_unwind → C frame → Rust callback → panic (caught)

The test code is at `/tmp/wasm-unwind-test/` if it still exists. The key finding
was that `extern "C"` (without `-unwind`) causes panics to abort at FFI boundaries.
Switching to `extern "C-unwind"` fixed everything.

---

## Architecture

```
                    hub-client (browser)
                          |
                    wasm-bindgen
                          |
                wasm-quarto-hub-client   (wasm32-unknown-unknown)
                          |
                      quarto-core
                          |
                        pampa          (with lua-filter feature ON)
                       /     \
                    mlua    (rest of pampa)
                      |
                  mlua-sys
                      |
               lua-src (FORKED)         ← new wasm32-unknown-unknown build path
                      |
              Lua 5.4.8 C source       ← compiled by cc crate + homebrew LLVM
                      |
           wasm-sysroot headers         ← extended with Lua's needs
                      |
           c_shim.rs (Rust impls)       ← extended with Lua's needs
                      |
        rust_lua_try / rust_lua_throw   ← catch_unwind/panic shims
```

### Key Mechanism: Replacing setjmp/longjmp

Lua's error handling in `ldo.c` (lines 48-79) uses two macros:
- `LUAI_THROW(L,c)` — by default expands to `longjmp((c)->b, 1)`
- `LUAI_TRY(L,c,a)` — by default expands to `if (setjmp((c)->b) == 0) { a }`
- `luai_jmpbuf` — by default is `jmp_buf`

These are guarded by `#if !defined(LUAI_THROW)`, so pre-defining them skips
the defaults entirely. The C++ path already does this (uses `throw`/`catch`).

We override them via `luaconf_wasm.h` (force-included at build time):

```c
#define luai_jmpbuf     int  /* dummy, like C++ path */
#define LUAI_THROW(L,c) rust_lua_throw()
#define LUAI_TRY(L,c,a) \
    if (rust_lua_protected_call(f, L, ud) != 0) { \
        if ((c)->status == 0) (c)->status = -1; \
    }
```

Rust side (in `c_shim.rs`):
```rust
#[no_mangle]
pub extern "C-unwind" fn rust_lua_protected_call(
    f: extern "C-unwind" fn(*mut c_void, *mut c_void),
    l: *mut c_void,
    ud: *mut c_void,
) -> i32 {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(l, ud))) {
        Ok(()) => 0,
        Err(_) => 1,
    }
}

#[no_mangle]
pub extern "C-unwind" fn rust_lua_throw() -> ! {
    panic!("lua error");
}
```

### Build Requirements

| Requirement | Status | Notes |
|------------|--------|-------|
| Nightly Rust | Using (1.96) | Needed for `-Zbuild-std` |
| `rust-src` component | Installed | `rustup component add rust-src` |
| `-Zbuild-std=std,panic_unwind` | In .cargo/config.toml | Rebuilds std with panic=unwind for WASM |
| `-Cpanic=unwind` | In .cargo/config.toml | Default is `abort` for wasm32 |
| `-Ctarget-feature=+exception-handling` | In .cargo/config.toml | Enables WASM EH instructions |
| Homebrew LLVM | Installed at `/opt/homebrew/opt/llvm/bin/clang` | Supports wasm32 target |
| `CC_wasm32_unknown_unknown` | Set at build time | Point to homebrew clang |
| `-fwasm-exceptions` | Set in CFLAGS | C code needs WASM EH support for unwind-through |

---

## Work Items

### Phase 1: Fork lua-src and add wasm32-unknown-unknown build path ✅

Source: `~/src/lua-src-rs/` (clone of https://github.com/mlua-rs/lua-src-rs)

- [x] Create `crates/lua-src-wasm/` — copy from `~/src/lua-src-rs/`
- [x] Modify `src/lib.rs` build script to add `wasm32-unknown-unknown` match arm
- [x] Add `[patch.crates-io]` in workspace `Cargo.toml` AND `wasm-quarto-hub-client/Cargo.toml`
- [x] Verify the C compilation succeeds
- [x] Move worktree to `~/src/q2-lua-wasm-spike` (was under `q2/.claude/worktrees/`)
- [x] Enable `lua-filter` feature in `wasm-quarto-hub-client/Cargo.toml`

### Phase 2: Extend wasm-sysroot for Lua's needs ✅

**DONE** — All 39 unresolved symbols resolved. We hand-wrote everything in c_shim.rs
rather than using the tinyrlibc/libm/lexical-core dependency strategy from the original plan.
This was simpler and avoids dependency management complexity for an experiment.

Functions added to c_shim.rs:
- [x] `rust_lua_protected_call` and `rust_lua_throw` (core catch_unwind mechanism)
- [x] `luaopen_io`, `luaopen_os`, `luaopen_package` (stubs — linit.c references them)
- [x] String: `strlen`, `strcmp`, `strchr`, `strcpy`, `memchr`, `strpbrk`, `strspn`, `strcoll`, `strerror`
- [x] Ctype: `isdigit`, `isalpha`, `isalnum`, `isspace`, `isupper`, `islower`, `iscntrl`, `ispunct`, `isgraph`, `isxdigit`, `toupper`, `tolower`
- [x] Stdlib: `abs`, `strtod` (full implementation with hex float support)
- [x] Math: `frexp`
- [x] Locale: `localeconv` (stub returning `"."`)
- [x] Errno: `__errno_location` (static int)
- [x] Time: `time` (stub returning 42)
- [x] Stdio: `fopen`, `freopen`, `fgets`, `fread`, `fflush`, `ferror`, `feof`, `getc` (stubs)

Verification: `env` imports in WASM binary went from 39 → 0.

**NOT yet done** (may be needed later for full Lua functionality):
- [ ] Math functions beyond `frexp` (sin, cos, pow, etc.) — not needed until math.* is used
- [ ] `snprintf` float formats (%g, %e, %f) — not needed until string.format with floats
- [ ] `strtol`, `strtoul`, `qsort`, `rand`, `srand` — not needed until those Lua paths are hit

### Phase 3: Wire mlua into the WASM build — PARTIALLY DONE

- [x] Enable `lua-filter` feature in `wasm-quarto-hub-client/Cargo.toml`
- [x] Add `lua_wasm_test()` function in `pampa/src/lib.rs` — creates Lua VM with safe libs
  - Uses `Lua::new_with()` with COROUTINE|TABLE|STRING|UTF8|MATH (no DEBUG — mlua rejects it)
- [x] Add `test_lua()` wasm-bindgen function in `wasm-quarto-hub-client/src/lib.rs`
- [x] WASM binary builds and links with zero unresolved symbols
- [x] WASM binary instantiates in Node.js
- [x] Patch `wasm-bindgen-futures` to remove `UnwindSafe` bound (in `crates/wasm-bindgen-futures-patch/`)
- [x] `.cargo/config.toml` configured with `build-std`, `panic=unwind`, `+exception-handling`
- [x] `cargo build --target wasm32-unknown-unknown --release` succeeds with build-std

**BLOCKED**: Runtime `unreachable` trap when calling `test_lua()`. See "Current Blocker" above.

- [ ] Fix panic unwind to actually work at runtime
- [ ] Update `hub-client/scripts/build-wasm.js` to use the correct build flags

### Phase 4: Enable UserFiltersStage in WASM pipeline

- [ ] In `quarto-core/src/pipeline.rs`, add `UserFiltersStage` to the WASM pipeline
- [ ] Wire up VFS-based filter file reading
- [ ] Test with a simple filter

### Phase 5: End-to-end demo

- [ ] Create a test .qmd with a Lua filter in the hub-client test fixtures
- [ ] Build hub-client with WASM Lua support
- [ ] Run in browser and verify the filter transforms content
- [ ] Document what works, what doesn't, and what cleanup would be needed

---

## Lua Libraries for WASM

Use `Lua::new_with()` instead of `Lua::new()` to control which libraries load:

**KEEP**: base (implicit), coroutine, table, string, math, utf8
**SKIP**: io, os, package (dynamic loading), debug (mlua rejects in safe mode)

Note: `luaopen_io`, `luaopen_os`, `luaopen_package` still need stub implementations
because `linit.c` references them even when they aren't loaded.

---

## Risks and Mitigations

| Risk | Status | Notes |
|------|--------|-------|
| `wasm-pack` doesn't support `-Zbuild-std` | CONFIRMED | Use manual `cargo build` + `wasm-bindgen` CLI instead |
| `wasm-bindgen-futures` UnwindSafe bound | FIXED | Patched in `crates/wasm-bindgen-futures-patch/` |
| Nested pcall interactions with `catch_unwind` | Untested in full build | Worked in isolation test |
| `unreachable` trap at runtime | **CURRENT BLOCKER** | Build flags may not be propagating correctly |
| Browser WASM EH support | Unknown | Chrome 95+, Firefox 100+, Safari 15.2+ should work |
| `extern "C"` vs `extern "C-unwind"` confusion | Addressed | mlua uses C-unwind; our shims must too |

---

## Key Decisions Made

1. **Hand-wrote libc functions** instead of using tinyrlibc/libm/lexical-core crates.
   Simpler for an experiment. May need crates later for float formatting in snprintf.

2. **Patched wasm-bindgen-futures** instead of wrapping every async function.
   Removed `UnwindSafe` bound, wrapped future in `AssertUnwindSafe` instead.

3. **Use `cargo build` + `wasm-bindgen` CLI** instead of wasm-pack for the
   unwind build, because wasm-pack doesn't support `-Zbuild-std`.

4. **Keep wasm-pack for non-unwind builds** — it still works for compilation
   verification and produces smaller binaries (with wasm-opt).
