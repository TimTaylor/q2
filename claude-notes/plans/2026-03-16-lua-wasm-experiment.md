# Experiment: Lua on wasm32-unknown-unknown via LUAI_TRY/LUAI_THROW Override

**Date**: 2026-03-16
**Branch**: `experiment/lua-wasm`
**Status**: Planning
**Context**: [Investigation](../investigations/2026-03-16-lua-wasm-options.md) — Option 8

## Goal

Prove that we can compile mlua + PUC-Rio Lua 5.4 for `wasm32-unknown-unknown`
and run a real Lua filter in the hub-client WASM build. This is an experiment —
right architecture, not a perfectly clean implementation. Demo target: work week.

## Proven So Far

1. `catch_unwind` works on `wasm32-unknown-unknown` (nightly + `-Zbuild-std` + `+exception-handling`)
2. Panics unwind correctly through C frames when using `extern "C-unwind"` and `-fwasm-exceptions`
3. mlua-sys already declares all Lua API functions as `extern "C-unwind"` (20 in lua54)
4. We already have a `wasm-sysroot/` and `c_shim.rs` infrastructure for compiling C (tree-sitter) to WASM

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

### Key Mechanism

Lua's error handling in `ldo.c` uses two macros: `LUAI_THROW(L,c)` and
`LUAI_TRY(L,c,a)`. By default these expand to `longjmp`/`setjmp`. We override
them with C macros that call into Rust:

```c
// Injected via -D flags at build time
#define luai_jmpbuf     int  /* dummy, like C++ path */
#define LUAI_THROW(L,c) rust_lua_throw()
#define LUAI_TRY(L,c,a) \
    if (rust_lua_protected_call(f, L, ud) != 0) { \
        if ((c)->status == 0) (c)->status = -1; \
    }
```

The `LUAI_TRY` macro is only used in one place (`luaD_rawrunprotected`) where
`f`, `L`, `ud` are local variables. This coupling is acceptable.

Rust side:
```rust
#[no_mangle]
pub extern "C-unwind" fn rust_lua_protected_call(
    f: extern "C-unwind" fn(*mut lua_State, *mut c_void),
    l: *mut lua_State,
    ud: *mut c_void,
) -> i32 {
    match catch_unwind(AssertUnwindSafe(|| f(l, ud))) {
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

| Requirement | Status |
|------------|--------|
| Nightly Rust | Already using (1.96) |
| `-Zbuild-std=std,panic_unwind` | Needed for wasm-pack invocation |
| `-Cpanic=unwind` | RUSTFLAGS |
| `-Ctarget-feature=+exception-handling` | RUSTFLAGS |
| `rust-src` component | Installed |
| Homebrew LLVM | Installed, supports wasm32 target |
| `CC_wasm32_unknown_unknown` | Point to homebrew clang |
| `CFLAGS_wasm32_unknown_unknown` | `-I{sysroot} -fwasm-exceptions --target=wasm32-unknown-unknown` |

### Lua Libraries for WASM

Use `Lua::new_with(StdLib::ALL_SAFE - StdLib::IO - StdLib::OS - StdLib::PACKAGE)`
or equivalent to skip libraries needing filesystem/process access.

Libraries to KEEP: base, coroutine, table, string, math, utf8, debug
Libraries to SKIP: io, os, package (dynamic loading)

This eliminates the need for: `fopen`, `fread`, `popen`, `system`, `getenv`,
`exit`, `remove`, `rename`, `tmpnam`, `mkstemp`, `dlopen`, `dlsym`, `gmtime`,
`localtime`, `mktime`, `strftime`, `difftime`.

---

## Work Items

### Phase 1: Fork lua-src and add wasm32-unknown-unknown build path

- [ ] Create a local `lua-src-wasm` crate (or patch in workspace)
- [ ] Copy lua-src-550.0.0 build logic
- [ ] Add `wasm32-unknown-unknown` match arm that:
  - Does NOT define `LUA_USE_POSIX` or `LUA_USE_LINUX`
  - Defines custom `LUAI_THROW`, `LUAI_TRY`, `luai_jmpbuf` via `-D` flags
  - Compiles with `-fwasm-exceptions` flag
  - Does NOT include `liolib.c`, `loslib.c`, `loadlib.c` (or compiles stubs)
- [ ] Verify the C compilation succeeds (just `cc` compile, no link yet)

### Phase 2: Extend wasm-sysroot for Lua's needs

Lua core + string/math/table libraries need these beyond what tree-sitter uses:

**Headers to add/extend:**

- [ ] `<string.h>`: Add `strlen`, `strchr`, `strcmp`, `strstr`, `strcpy`, `strncpy`, `strcat`, `strncat`, `strspn`, `strcspn`, `strerror`
- [ ] `<stdlib.h>`: Add `strtod`, `strtol`, `strtoul`, `atoi`, `abs`, `rand`, `srand`, `qsort`, `bsearch`
- [ ] `<math.h>`: NEW header — `floor`, `ceil`, `fmod`, `pow`, `fabs`, `sqrt`, `log`, `log2`, `log10`, `exp`, `sin`, `cos`, `tan`, `asin`, `acos`, `atan2`, `frexp`, `ldexp`, `modf`, `HUGE_VAL`, `NAN`, `INFINITY`
- [ ] `<ctype.h>`: Add `isdigit`, `isalpha`, `isalnum`, `isspace`, `iscntrl`, `ispunct`, `isupper`, `islower`, `isxdigit`, `toupper`, `tolower`
- [ ] `<locale.h>`: NEW header — stub `localeconv` (return "." as decimal point), `setlocale` (no-op)
- [ ] `<signal.h>`: NEW header — stub `signal` (no-op)
- [ ] `<errno.h>`: NEW header — `errno` thread-local, `ERANGE`, `EDOM`
- [ ] `<float.h>`: NEW header — `FLT_RADIX`, `DBL_MAX_10_EXP`, `LDBL_MAX_10_EXP`, etc.
- [ ] `<limits.h>`: NEW header — `INT_MAX`, `INT_MIN`, `LONG_MAX`, `ULONG_MAX`, `LLONG_MAX`, etc.
- [ ] `<stdarg.h>`: Should be provided by clang builtins (verify)

**Rust shim functions to add in c_shim.rs:**

- [ ] String functions: `strlen`, `strchr`, `strcmp`, `strstr`, `strcpy`, `strncpy`, `strcat`, `strncat`, `strspn`, `strcspn`, `strerror`, `strpbrk`
- [ ] Number parsing: `strtod`, `strtol`, `strtoul`, `strtoll`, `strtoull`, `atoi`
- [ ] Math functions: link to `libm` via Rust or implement as wrappers around `f64::sin()`, `f64::cos()`, etc.
- [ ] Locale: `localeconv` (return static struct with `.` as decimal point), `setlocale` (no-op)
- [ ] Sorting: `qsort` (use Rust's sort)
- [ ] ctype functions: `isdigit`, `isalpha`, `isalnum`, `isspace`, `iscntrl`, `ispunct`, `isxdigit`, `isupper`, `islower`, `toupper`, `tolower`
- [ ] errno: thread-local `errno` variable
- [ ] Signal: `signal` (no-op, return SIG_DFL)
- [ ] `rust_lua_protected_call` and `rust_lua_throw` (the core mechanism)

### Phase 3: Wire mlua into the WASM build

- [ ] In `pampa/Cargo.toml`, make `lua-filter` feature available for WASM
  - Point mlua at our forked lua-src (via patch or path dependency)
- [ ] In `wasm-quarto-hub-client/Cargo.toml`, enable `lua-filter` feature on pampa
- [ ] Handle `Lua::new()` → `Lua::new_with()` for WASM (skip io/os/package)
  - May need `#[cfg(target_arch = "wasm32")]` conditional in filter.rs
- [ ] Update `build-wasm.js` to pass the extra RUSTFLAGS and CFLAGS
  - `-Zbuild-std=std,panic_unwind` (requires wasm-pack support or manual cargo build)
  - `-Cpanic=unwind -Ctarget-feature=+exception-handling`
  - C side: `-fwasm-exceptions`
- [ ] Attempt first WASM build — fix linker errors iteratively

### Phase 4: Enable UserFiltersStage in WASM pipeline

- [ ] In `quarto-core/src/pipeline.rs`, add `UserFiltersStage` to the WASM pipeline
  - Start with a cfg-gated conditional: only add if lua-filter feature is on
- [ ] Wire up VFS-based filter file reading (filters need to read .lua files)
- [ ] Test with a simple filter (e.g., one that uppercases all Str elements)

### Phase 5: End-to-end demo

- [ ] Create a test .qmd with a Lua filter
- [ ] Build hub-client with WASM Lua support
- [ ] Run in browser and verify the filter transforms content
- [ ] Document what works and what doesn't

---

## Libc Surface Area Analysis

### What we already have (from tree-sitter c_shim):
`malloc`, `calloc`, `realloc`, `free`, `abort`,
`memcpy`, `memmove`, `memset`, `memcmp`, `strncmp`,
`iswspace`, `iswalnum`, `iswdigit`, `iswalpha`, `towlower`,
`isprint`, `clock`, `snprintf`, `vsnprintf`,
`fprintf`, `fputs`, `fputc`, `fdopen`, `fclose`, `fwrite`

### What Lua core additionally needs:
`strlen`, `strchr`, `strcmp`, `strcpy`, `strncpy`, `strtod`, `strtol`,
`strtoul`, `localeconv`, `toupper`, `tolower`, `isdigit`, `isalpha`,
`isalnum`, `isspace`, `isxdigit`, `isupper`, `islower`,
`floor`, `ceil`, `fmod`, `pow`, `fabs`, `sqrt`, `log`, `exp`,
`sin`, `cos`, `tan`, `asin`, `acos`, `atan2`, `frexp`, `ldexp`,
`qsort`, `abs`, `rand`, `srand`, `strerror`, `signal`, `errno`

### Math functions strategy:
Rust's `f64` already provides most math operations. Implement C math shims as:
```rust
#[no_mangle]
pub extern "C" fn sin(x: f64) -> f64 { x.sin() }
#[no_mangle]
pub extern "C" fn cos(x: f64) -> f64 { x.cos() }
// etc.
```

For `HUGE_VAL`, `NAN`, `INFINITY` — define in `math.h` using GCC/Clang builtins:
```c
#define HUGE_VAL __builtin_huge_val()
#define NAN __builtin_nan("")
#define INFINITY __builtin_inf()
```

---

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| wasm-pack doesn't support `-Zbuild-std` | Use manual `cargo build` + `wasm-bindgen` CLI instead |
| Nested pcall interactions with catch_unwind | Already tested with nested C frames — works |
| Lua number formatting needs `sprintf`/`snprintf` | Already have snprintf in c_shim; extend format specifier coverage (especially `%g`, `%e`, `%f` for floats) |
| `localeconv` decimal point detection | Stub to always return "." — Lua only uses it for number parsing |
| Math precision differences | Rust f64 operations should match C double — both IEEE 754 |
| Browser WASM EH support | Chrome 95+, Firefox 100+, Safari 15.2+ — all modern browsers |

---

## Key Decision: How to fork lua-src

Options:
1. **Copy lua-src into workspace** as a local crate — simple, self-contained
2. **Git fork of lua-src-rs** on GitHub — can track upstream
3. **Cargo patch** in workspace Cargo.toml pointing to local copy

For this experiment, option 1 (local crate) is simplest. We copy `lua-src-550.0.0`
into `crates/lua-src-wasm/` and modify the build script. We can use a
`[patch.crates-io]` entry in the workspace Cargo.toml to redirect mlua's
lua-src dependency to our local version.

---

## Key Decision: Where to put the Rust shims

The `rust_lua_protected_call` and `rust_lua_throw` functions need to be linked
into the same WASM binary as Lua. Two options:

1. **In c_shim.rs** alongside other libc stubs — they ARE effectively libc
   stubs from Lua's perspective
2. **In a dedicated lua_wasm_shim.rs** — cleaner separation

For this experiment, put them in c_shim.rs. They're `#[no_mangle] extern "C-unwind"`
functions, same pattern as the other shims.

---

## snprintf: The Hidden Boss

Lua uses `snprintf` extensively for number formatting (`%g`, `%.14g`, `%a`,
`%e`, `%f`, `%p`, `%x`). Our current snprintf handles `%d`, `%u`, `%s`, `%c`
but NOT floating-point formats. This is the single biggest gap.

Options:
1. **Extend our snprintf** with `%g`, `%e`, `%f` support (significant work)
2. **Use a C snprintf implementation** like musl's — it's self-contained
3. **Override Lua's number formatting** via `LUAI_NUMFORMAT` macro

For the experiment, option 3 is fastest: define `LUAI_NUMFORMAT` to call a Rust
function that formats numbers using Rust's `format!()` machinery. This avoids
needing a full `snprintf` with float support.

Actually, the cleanest approach: provide a Rust-backed `snprintf` that handles
`%g`/`%e`/`%f` by delegating to Rust's `format!`. This benefits all C code in
the WASM build, not just Lua.
