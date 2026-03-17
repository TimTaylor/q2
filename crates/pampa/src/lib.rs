#![cfg_attr(coverage_nightly, feature(coverage_attribute))]
#![allow(dead_code)]

/*
 * lib.rs
 * Copyright (c) 2025 Posit, PBC
 */

pub mod citeproc_filter;
pub mod errors;
pub mod filter_context;
pub mod filters;
#[cfg(feature = "json-filter")]
pub mod json_filter;
#[cfg(feature = "lua-filter")]
pub mod lua;
pub mod options;
pub mod pandoc;
pub mod readers;
pub mod template;
pub mod toc;
pub mod transforms;
pub mod traversals;
pub mod unified_filter;
pub mod utils;
pub mod wasm_entry_points;
pub mod writers;

#[cfg(feature = "lua-filter")]
pub fn lua_wasm_test(script: &str) -> String {
    use mlua::StdLib;
    use mlua::prelude::*;

    let libs = StdLib::COROUTINE | StdLib::TABLE | StdLib::STRING | StdLib::UTF8 | StdLib::MATH;

    let lua = match Lua::new_with(libs, mlua::LuaOptions::default()) {
        Ok(lua) => lua,
        Err(e) => return format!("Failed to create Lua state: {e}"),
    };

    match lua.load(script).eval::<String>() {
        Ok(result) => result,
        Err(e) => format!("Lua error: {e}"),
    }
}
