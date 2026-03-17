#!/usr/bin/env node
/**
 * Test Lua execution in WASM.
 *
 * Patches the generated wasm-bindgen JS to stub out hub-client bridge imports.
 */

import { readFile, writeFile, unlink } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, 'pkg');

// Read the generated JS
let jsSource = await readFile(join(pkgDir, 'wasm_quarto_hub_client.js'), 'utf-8');

// Remove ALL import lines that reference /src/wasm-js-bridge/
jsSource = jsSource.replace(/^import .+ from ['"]\/src\/wasm-js-bridge\/[^'"]+['"];?\s*$/gm, '');
jsSource = jsSource.replace(/^import \* as \w+ from ['"]\/src\/wasm-js-bridge\/[^'"]+['"];?\s*$/gm, '');

// Add stubs at the top of the file
const stubs = `
// Stubs for hub-client bridge imports
function jsCacheClearNamespace() { return undefined; }
function jsCacheDelete() { return undefined; }
function jsCacheGet() { return null; }
function jsCacheSet() { return undefined; }
function jsCompileSass() { return ''; }
function jsRenderEjs() { return ''; }
function jsRenderSimpleTemplate() { return ''; }

function jsTemplateAvailable() { return false; }
function jsSassAvailable() { return false; }

// These are the module-level imports that wasm-bindgen references
const import1 = { jsRenderEjs, jsRenderSimpleTemplate, jsTemplateAvailable };
const import2 = { jsCompileSass, jsSassAvailable };
`;
jsSource = stubs + jsSource;

// Write patched module
const tmpFile = join(__dirname, '_test_patched_wasm.mjs');
await writeFile(tmpFile, jsSource);

try {
  const mod = await import(tmpFile);

  // Initialize
  const wasmBytes = await readFile(join(pkgDir, 'wasm_quarto_hub_client_bg.wasm'));
  await mod.default(wasmBytes);

  console.log('WASM module initialized with Lua!\n');

  const tests = [
    ['Simple string', 'return "Hello from Lua in WASM!"', 'Hello from Lua in WASM!'],
    ['Integer math', 'return tostring(2 + 3 * 4)', '14'],
    ['Float math', 'return tostring(math.floor(math.pi * 100))', '314'],
    ['String ops', 'return string.upper("hello world")', 'HELLO WORLD'],
    ['String.format', 'return string.format("x=%d y=%s", 42, "ok")', 'x=42 y=ok'],
    ['Table sort', `
      local t = {3, 1, 4, 1, 5, 9}
      table.sort(t)
      local r = {}
      for _, v in ipairs(t) do r[#r+1] = tostring(v) end
      return table.concat(r, ", ")
    `, '1, 1, 3, 4, 5, 9'],
    ['pcall error', `
      local ok, err = pcall(function() error("boom") end)
      return tostring(ok) .. " " .. tostring(err):match("boom")
    `, 'false boom'],
    ['Coroutine', `
      local co = coroutine.create(function()
        coroutine.yield("first")
        return "second"
      end)
      local _, a = coroutine.resume(co)
      local _, b = coroutine.resume(co)
      return a .. " " .. b
    `, 'first second'],
  ];

  let passed = 0;
  let failed = 0;

  for (const [name, script, expected] of tests) {
    process.stdout.write(`${name}: `);
    try {
      const result = mod.test_lua(script);
      if (expected && result === expected) {
        console.log(`PASS (${result})`);
        passed++;
      } else if (expected) {
        console.log(`FAIL (got "${result}", expected "${expected}")`);
        failed++;
      } else {
        console.log(`OK (${result})`);
        passed++;
      }
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed out of ${tests.length} tests`);
  process.exit(failed > 0 ? 1 : 0);
} finally {
  await unlink(tmpFile).catch(() => {});
}
