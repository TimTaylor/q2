# Experiment: Lua on wasm32-unknown-unknown via LUAI_TRY/LUAI_THROW Override

**Date**: 2026-03-16
**Branch**: `experiment/lua-wasm`
**Status**: Planning
**Context**: [Investigation](../investigations/2026-03-16-lua-wasm-options.md) — Option 8

## Goal

Prove that we can compile mlua + PUC-Rio Lua 5.4 for `wasm32-unknown-unknown`
and run a real Lua filter in the hub-client WASM build. This is an experiment —
right architecture, not a perfectly clean implementation. Demo target: work week.

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
    src/lib.rs               # Entry point, includes c_shim
    wasm-sysroot/            # Stub C headers (stdio.h, stdlib.h, string.h, etc.)
    Cargo.toml               # Depends on pampa with default-features = false (no lua)
  wasm-qmd-parser/           # Older/lighter WASM crate (also has c_shim + wasm-sysroot)
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
- `crates/wasm-quarto-hub-client/Cargo.toml`: uses `pampa` with `default-features = false` (no lua)
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
        rust_lua_try / rust_lua_throw   ← NEW: catch_unwind/panic shims
```

### Key Mechanism: Replacing setjmp/longjmp

Lua's error handling in `ldo.c` (lines 48-79) uses two macros:
- `LUAI_THROW(L,c)` — by default expands to `longjmp((c)->b, 1)`
- `LUAI_TRY(L,c,a)` — by default expands to `if (setjmp((c)->b) == 0) { a }`
- `luai_jmpbuf` — by default is `jmp_buf`

These are guarded by `#if !defined(LUAI_THROW)`, so pre-defining them skips
the defaults entirely. The C++ path already does this (uses `throw`/`catch`).

We override them with C macros that call into Rust:

```c
// Injected via -D flags at build time
#define luai_jmpbuf     int  /* dummy, like C++ path */
#define LUAI_THROW(L,c) rust_lua_throw()
#define LUAI_TRY(L,c,a) \
    if (rust_lua_protected_call(f, L, ud) != 0) { \
        if ((c)->status == 0) (c)->status = -1; \
    }
```

**Why LUAI_TRY references `f`, `L`, `ud` by name**: The macro is only used in
one place — `luaD_rawrunprotected(lua_State *L, Pfunc f, void *ud)` at ldo.c:135.
The `a` parameter is always `(*f)(L, ud)`. Our macro ignores `a` and calls
`f(L, ud)` through Rust's catch_unwind instead. The coupling to local variable
names is ugly but sound — this is the ONLY call site.

Rust side (goes in `c_shim.rs`):
```rust
/// Replacement for Lua's setjmp-based protected call.
/// Called from LUAI_TRY macro in ldo.c via luaD_rawrunprotected.
#[no_mangle]
pub extern "C-unwind" fn rust_lua_protected_call(
    f: extern "C-unwind" fn(*mut c_void, *mut c_void),
    l: *mut c_void,
    ud: *mut c_void,
) -> i32 {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(l, ud))) {
        Ok(()) => 0,   // success — no error
        Err(_) => 1,   // caught a panic — Lua error occurred
    }
}

/// Replacement for Lua's longjmp-based error throw.
/// Called from LUAI_THROW macro in ldo.c via luaD_throw.
#[no_mangle]
pub extern "C-unwind" fn rust_lua_throw() -> ! {
    panic!("lua error");
}
```

### Build Requirements

| Requirement | Status | Notes |
|------------|--------|-------|
| Nightly Rust | Already using (1.96) | Needed for `-Zbuild-std` |
| `rust-src` component | Installed | `rustup component add rust-src` |
| `-Zbuild-std=std,panic_unwind` | NEW | Rebuilds std with panic=unwind for WASM |
| `-Cpanic=unwind` | NEW RUSTFLAG | Default is `abort` for wasm32 |
| `-Ctarget-feature=+exception-handling` | NEW RUSTFLAG | Enables WASM EH instructions |
| Homebrew LLVM | Installed at `/opt/homebrew/opt/llvm/bin/clang` | Supports wasm32 target |
| `CC_wasm32_unknown_unknown` | Already set in build-wasm.js | Point to homebrew clang |
| `-fwasm-exceptions` | NEW CFLAG | C code needs WASM EH support for unwind-through |

**Important**: `wasm-pack` may not support `-Zbuild-std`. If not, use manual
`cargo build --target wasm32-unknown-unknown -Zbuild-std=std,panic_unwind`
followed by `wasm-bindgen` CLI to generate JS bindings. The existing
`build-wasm.js` script would need to be adapted.

### Lua Libraries for WASM

Use `Lua::new_with()` instead of `Lua::new()` to control which libraries load:

**KEEP**: base, coroutine, table, string, math, utf8, debug
**SKIP**: io, os, package (dynamic loading)

This eliminates the need for many system calls: `fopen`, `fread`, `popen`,
`system`, `getenv`, `exit`, `dlopen`, `gmtime`, `strftime`, etc.

The Lua source files for skipped libraries (`liolib.c`, `loslib.c`, `loadlib.c`)
should be excluded from compilation entirely in the lua-src build script to
avoid pulling in their header dependencies.

---

## Work Items

### Phase 1: Fork lua-src and add wasm32-unknown-unknown build path

Source: `~/src/lua-src-rs/` (clone of https://github.com/mlua-rs/lua-src-rs)

- [ ] Create `crates/lua-src-wasm/` — copy from `~/src/lua-src-rs/`
- [ ] Modify `src/lib.rs` build script to add `wasm32-unknown-unknown` match arm:
  - Do NOT define `LUA_USE_POSIX` or `LUA_USE_LINUX`
  - Define `LUAI_THROW`, `LUAI_TRY`, `luai_jmpbuf` via `-D` flags to cc::Build
  - Add `-fwasm-exceptions` flag
  - Exclude `liolib.c`, `loslib.c`, `loadlib.c` from compilation
  - Declare `rust_lua_protected_call` and `rust_lua_throw` as extern in a
    header or via `-D` flags so the C code can reference them
- [ ] Add `[patch.crates-io]` in workspace `Cargo.toml`:
  ```toml
  [patch.crates-io]
  lua-src = { path = "crates/lua-src-wasm" }
  ```
- [ ] Verify the C compilation succeeds: enable `lua-filter` on pampa for WASM
  target and run `cargo build --target wasm32-unknown-unknown` with the right
  RUSTFLAGS/CFLAGS (doesn't need to link yet — just compile)

### Phase 2: Extend wasm-sysroot for Lua's needs

The wasm-sysroot lives at `crates/wasm-quarto-hub-client/wasm-sysroot/`.
The Rust shim implementations live at `crates/wasm-quarto-hub-client/src/c_shim.rs`.

**What we already have** (from tree-sitter):
- stdlib: `malloc`, `calloc`, `realloc`, `free`, `abort`
- string: `memcpy`, `memmove`, `memset`, `memcmp`, `strncmp`
- wctype: `iswspace`, `iswalnum`, `iswdigit`, `iswalpha`, `towlower`
- ctype: `isprint`
- stdio: `snprintf` (partial — `%d`, `%u`, `%s`, `%c` only), `fprintf`/`fputs`/etc. (panic stubs)
- time: `clock` (panic stub)

#### Dependency Strategy

Rather than hand-implementing everything, we use three Rust crates:

| Crate | Version | Provides | Notes |
|-------|---------|----------|-------|
| **`tinyrlibc`** | 0.5.1 | `strlen`, `strchr`, `strcmp`, `strcpy`, `strstr`, `strcat`, `strncpy`, `strncmp`, `strrchr`, `strspn`, `strcspn`, `memchr`, `qsort`, `rand`/`srand`, `atoi`, `strtol`/`strtoul`, `abs`, `signal`, `isdigit`/`isalpha`/`isspace`/`isupper`, `snprintf` (integers only) | no_std, feature-gated. Source at `~/src/tinyrlibc/`. The `snprintf` is C (handles varargs) but only supports `%d`/`%u`/`%x`/`%s`/`%c` — NO float formats. |
| **`libm`** | 0.2.16 | All C math functions: `sin`, `cos`, `tan`, `asin`, `acos`, `atan2`, `exp`, `log`, `log2`, `log10`, `sqrt`, `pow`, `fabs`, `floor`, `ceil`, `fmod`, `frexp`, `ldexp`, `modf` | Pure Rust port of musl's math library. Used by Rust's own stdlib on wasm. We expose these as `#[no_mangle] extern "C"` wrappers. (Or use `externc-libm` v0.1.0 which does this automatically.) |
| **`lexical-core`** | 1.0.6 | Float parsing (`strtod`) and float-to-string (`%g`/`%e`/`%f` for snprintf) | no_std, battle-tested. For `strtod`: wraps `lexical_core::parse_partial::<f64>()` with endptr. For snprintf floats: wraps `lexical_core::write_with_options::<f64>()`. Hex float (`%a`, `0x1.fp10`) needs a small pre-pass since lexical-core doesn't handle C hex float syntax natively. |

**What tinyrlibc does NOT cover** (we still hand-write these):

- Additional ctype: `isalnum`, `iscntrl`, `ispunct`, `islower`, `isxdigit`,
  `toupper`, `tolower` — trivial one-liners
- `strerror` — return static "unknown error" string
- `strpbrk`, `strncat` — simple string ops
- `localeconv` — stub returning `"."` decimal point
- `setlocale` — no-op
- `errno` with `ERANGE`/`EDOM` — static/thread-local int
- `rust_lua_protected_call` / `rust_lua_throw` — the core catch_unwind mechanism

**What Lua additionally needs** — headers AND implementations:

- [ ] Add `tinyrlibc`, `libm` (or `externc-libm`), and `lexical-core` as
  dependencies of `wasm-quarto-hub-client` (gated on wasm32 target)
- [ ] `<string.h>` additions: tinyrlibc provides most (`strlen`, `strchr`,
  `strcmp`, `strstr`, `strcpy`, `strncpy`, `strcat`, `strspn`, `strcspn`,
  `strrchr`, `memchr`); hand-write `strpbrk`, `strncat`, `strerror`
- [ ] `<stdlib.h>` additions: tinyrlibc provides `strtol`, `strtoul`, `atoi`,
  `abs`, `qsort`, `rand`, `srand`; wrap `lexical-core` for `strtod`
- [ ] `<math.h>` (NEW header): use `libm` crate for all functions; expose as
  `#[no_mangle] extern "C"` wrappers. Constants via clang builtins
  (`__builtin_huge_val()`, `__builtin_nan("")`, `__builtin_inf()`)
- [ ] `<ctype.h>` additions: tinyrlibc provides `isdigit`, `isalpha`, `isspace`,
  `isupper`; hand-write `isalnum`, `iscntrl`, `ispunct`, `islower`, `isxdigit`,
  `toupper`, `tolower`
- [ ] `<locale.h>` (NEW header): `localeconv` (stub — return static struct with
  `"."` as decimal point), `setlocale` (no-op)
- [ ] `<signal.h>` (NEW header): tinyrlibc provides `signal`
- [ ] `<errno.h>` (NEW header): static `errno`, `ERANGE`, `EDOM`
- [ ] `<float.h>` (NEW header): `FLT_RADIX`, `DBL_MAX`, `DBL_MAX_10_EXP`,
  `LDBL_MAX_10_EXP`, etc.
- [ ] `<limits.h>` (NEW header): `INT_MAX`, `INT_MIN`, `LONG_MAX`, `ULONG_MAX`,
  `LLONG_MAX`, `CHAR_BIT`, etc.
- [ ] `<stdarg.h>`: Should be provided by clang builtins automatically (verify)
- [ ] `rust_lua_protected_call` and `rust_lua_throw` in c_shim.rs (the core mechanism)
- [ ] Replace existing hand-written `snprintf` with tinyrlibc's C implementation
  (which handles varargs properly) and extend it with float format support using
  `lexical-core` for `%g`, `%e`, `%f` specifiers. `%a` (hex float) can be
  stubbed initially — it's rarely used by Lua filters.

### Phase 3: Wire mlua into the WASM build

- [ ] In `pampa/Cargo.toml`, ensure `lua-filter` feature works for WASM target
  - The mlua dependency should pick up our patched lua-src via `[patch.crates-io]`
- [ ] In `wasm-quarto-hub-client/Cargo.toml`, enable `lua-filter` feature on pampa:
  ```toml
  pampa = { path = "../pampa", features = ["lua-filter"] }
  ```
- [ ] Handle `Lua::new()` → `Lua::new_with()` for WASM (skip io/os/package)
  - Add `#[cfg(target_arch = "wasm32")]` conditional in `pampa/src/lua/filter.rs`
    around the `Lua::new()` call (line 109)
  - WASM path: `Lua::new_with(StdLib::ALL_SAFE & !StdLib::IO & !StdLib::OS & !StdLib::PACKAGE)`
  - Native path: unchanged `Lua::new()`
- [ ] Update `hub-client/scripts/build-wasm.js` to pass extra flags:
  - RUSTFLAGS: add `-Cpanic=unwind -Ctarget-feature=+exception-handling`
  - CFLAGS: add `-fwasm-exceptions`
  - wasm-pack args: add `-Zbuild-std=std,panic_unwind` (if supported; otherwise
    switch to manual `cargo build` + `wasm-bindgen` CLI)
- [ ] Attempt first WASM build — expect linker errors for missing symbols
- [ ] Fix linker errors iteratively (likely missing libc stubs)

### Phase 4: Enable UserFiltersStage in WASM pipeline

- [ ] In `quarto-core/src/pipeline.rs`, add `UserFiltersStage` to the WASM pipeline
  - Currently only the native pipeline (9 stages) includes it
  - The WASM pipeline (6 stages) skips it
  - Gate on `#[cfg(feature = "lua-filter")]` or similar
- [ ] Wire up VFS-based filter file reading
  - Lua filters are `.lua` files that need to be read from somewhere
  - In WASM, the VFS (virtual filesystem with `/project/` prefix) holds all files
  - The filter engine reads filter files via `std::fs::read_to_string` — this
    needs a WASM-compatible path (may already work through our VFS layer)
- [ ] Test with a simple filter (e.g., one that uppercases all Str elements)

### Phase 5: End-to-end demo

- [ ] Create a test .qmd with a Lua filter in the hub-client test fixtures
- [ ] Build hub-client with WASM Lua support
- [ ] Run in browser and verify the filter transforms content
- [ ] Document what works, what doesn't, and what cleanup would be needed

---

## Libc Surface Area: Detailed Gap Analysis

### Already provided by c_shim.rs (for tree-sitter):

| Category | Functions |
|----------|-----------|
| Memory | `malloc`, `calloc`, `realloc`, `free`, `abort` |
| String/mem | `memcpy`, `memmove`, `memset`, `memcmp`, `strncmp` |
| Wide char | `iswspace`, `iswalnum`, `iswdigit`, `iswalpha`, `towlower` |
| Char class | `isprint` |
| I/O | `snprintf` (partial), `fprintf`/`fputs`/`fputc`/`fclose`/`fwrite` (panic stubs) |
| Time | `clock` (panic stub) |

### Needed for Lua core VM (lvm.c, ldo.c, lapi.c, lstate.c, lobject.c, llex.c):

| Category | Functions | Notes |
|----------|-----------|-------|
| String | `strlen`, `strchr`, `strcmp`, `strcpy`, `memchr` | Used everywhere |
| Number parsing | `strtod` | Via `lua_str2number` macro in luaconf.h |
| Char class | `isdigit`, `isalpha`, `isalnum`, `isspace`, `isxdigit`, `toupper`, `tolower` | Lexer (llex.c) — Lua also has custom `lctype.h` versions |
| Locale | `localeconv` | Only for decimal point detection (`lua_getlocaledecpoint` macro) |
| Error | `errno`, `ERANGE` | Used in number parsing |
| Formatting | `snprintf` with `%g`, `%e`, `%f` | Number-to-string conversion |

### Needed for Lua string library (lstrlib.c):

| Category | Functions | Notes |
|----------|-----------|-------|
| String | `strstr`, `strpbrk`, `strcspn`, `strncpy` | Pattern matching |
| Char class | `iscntrl`, `ispunct`, `isupper`, `islower` | `%c`, `%p`, `%u`, `%l` patterns |
| Formatting | `snprintf` with full format spec support | `string.format()` |

### Needed for Lua math library (lmathlib.c):

| Category | Functions | Notes |
|----------|-----------|-------|
| Trig | `sin`, `cos`, `tan`, `asin`, `acos`, `atan2` | |
| Exp/log | `exp`, `log`, `log2`, `log10` | |
| Rounding | `floor`, `ceil`, `fmod` | Also used by VM |
| Power/root | `pow`, `sqrt`, `fabs` | |
| Decompose | `frexp`, `ldexp`, `modf` | |
| Random | `rand`, `srand` | `math.random()` — uses `time()` for seed |
| Constants | `HUGE_VAL`, `NAN`, `INFINITY` | Header-only |

### Needed for Lua table library (ltablib.c):

| Category | Functions | Notes |
|----------|-----------|-------|
| Sorting | `qsort` — but Lua implements its own sort | Actually not needed! Lua's `table.sort` is pure Lua/C |

### NOT needed (libraries we skip):

liolib.c (io): `fopen`, `fread`, `fwrite`, `fseek`, `ftell`, `popen`, `getc`, `feof`, `ferror`, `fflush`
loslib.c (os): `time`, `clock`, `gmtime`, `localtime`, `mktime`, `strftime`, `difftime`, `system`, `getenv`, `exit`, `remove`, `rename`, `tmpnam`
loadlib.c (package): `dlopen`, `dlsym`, `dlclose`, `dlerror`

---

## Math Functions Strategy

Use the **`libm`** crate (v0.2.16), a pure Rust port of musl's math library.
It's what Rust's own standard library uses on wasm targets. Expose functions as
`#[no_mangle] extern "C"` wrappers in c_shim.rs:

```rust
#[no_mangle] pub extern "C" fn sin(x: f64) -> f64 { libm::sin(x) }
#[no_mangle] pub extern "C" fn cos(x: f64) -> f64 { libm::cos(x) }
#[no_mangle] pub extern "C" fn floor(x: f64) -> f64 { libm::floor(x) }
#[no_mangle] pub extern "C" fn pow(base: f64, exp: f64) -> f64 { libm::pow(base, exp) }
// etc.
```

Alternative: use **`externc-libm`** (v0.1.0) which does this wrapping automatically.

For header constants, use clang builtins:
```c
#define HUGE_VAL  __builtin_huge_val()
#define NAN       __builtin_nan("")
#define INFINITY  __builtin_inf()
```

---

## strtod Strategy

Use **`lexical-core`** (v1.0.6) for float parsing. It's no_std compatible,
battle-tested, and handles decimal floats, infinity, and NaN. Wrap as:

```rust
#[no_mangle]
pub unsafe extern "C" fn strtod(s: *const c_char, endptr: *mut *mut c_char) -> f64 {
    let bytes = /* slice from s to first NUL or reasonable bound */;
    // Skip leading whitespace
    let trimmed = bytes.trim_ascii_start();
    let offset = bytes.len() - trimmed.len();

    // Pre-pass: check for C hex float syntax (0x...) that lexical-core
    // doesn't handle natively. Convert to decimal if needed, or handle
    // with a small custom parser.

    match lexical_core::parse_partial::<f64>(trimmed) {
        Ok((value, consumed)) => {
            if !endptr.is_null() {
                *endptr = s.add(offset + consumed) as *mut c_char;
            }
            value
        }
        Err(_) => {
            if !endptr.is_null() {
                *endptr = s as *mut c_char;
            }
            0.0
        }
    }
}
```

Hex float (`0x1.fp10`) needs a small pre-pass since lexical-core doesn't parse
C hex float syntax natively. This format is used by Lua's `%a` formatter and
`tonumber("0x1.8p1")`. Can be deferred for the initial demo if needed.

---

## snprintf Strategy

Use **tinyrlibc's snprintf.c** as the base — it's a proper C implementation
that handles varargs (which Rust can't do). It already supports `%d`, `%u`,
`%x`, `%s`, `%c` with width/precision/padding.

For float formats (`%g`, `%e`, `%f`) needed by Lua, extend tinyrlibc's
`vsnprintf` to call into Rust helpers that use **`lexical-core`** for
float-to-string conversion:

```c
// In the vsnprintf switch statement, add:
case 'g': case 'G':
case 'e': case 'E':
case 'f': case 'F': {
    double val = va_arg(ap, double);
    // Call into Rust for float formatting
    char float_buf[64];
    int float_len = rust_format_float(val, *fmt, precision, float_buf, sizeof(float_buf));
    // Write float_buf to output with padding
    ...
}
```

The `rust_format_float` Rust function uses `lexical_core::write_with_options`
to format the float according to the specifier. This avoids reimplementing
printf float formatting from scratch.

`%a` (hex float output) can be stubbed initially — it's rarely used.

---

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| `wasm-pack` doesn't support `-Zbuild-std` | Use manual `cargo build` + `wasm-bindgen` CLI instead |
| Nested pcall interactions with `catch_unwind` | Already tested with nested C frames — works |
| Lua number formatting needs full `snprintf` | Use tinyrlibc's snprintf.c + extend with `lexical-core` for float formats |
| `lexical-core` hex float gaps | `strtod` needs a small pre-pass for `0x` hex floats; `%a` output can be stubbed initially |
| tinyrlibc symbol conflicts with existing c_shim.rs | Both export `strlen`, `malloc`, etc. — disable overlapping tinyrlibc features, keep our existing impls |
| `localeconv` decimal point detection | Stub to always return `"."` — correct for WASM |
| Math precision differences | Rust f64 = C double = IEEE 754 — should match |
| Browser WASM EH support | Chrome 95+, Firefox 100+, Safari 15.2+ — all modern |
| `extern "C"` vs `extern "C-unwind"` confusion | mlua already uses C-unwind; our shims must too |

---

## Key Decisions

### How to fork lua-src

Copy `~/src/lua-src-rs/` into `crates/lua-src-wasm/` as a local workspace crate.
Use `[patch.crates-io]` in workspace `Cargo.toml` to redirect mlua's lua-src
dependency. This avoids modifying mlua itself — cargo's patch mechanism handles
the redirection transparently.

### Where to put the Rust shims

Put `rust_lua_protected_call` and `rust_lua_throw` in
`crates/wasm-quarto-hub-client/src/c_shim.rs` alongside other libc stubs.
They're `#[no_mangle] extern "C-unwind"` functions following the same pattern.

### How to handle Lua::new() for WASM

Add a `#[cfg(target_arch = "wasm32")]` conditional in `pampa/src/lua/filter.rs`
(around line 109) to use `Lua::new_with()` instead of `Lua::new()`, skipping
io/os/package libraries. The native path remains unchanged.
