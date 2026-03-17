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

// Remove ALL import/require lines that reference /src/wasm-js-bridge/
jsSource = jsSource.replace(/^import .+ from ['"]\/src\/wasm-js-bridge\/[^'"]+['"];?\s*$/gm, '');
jsSource = jsSource.replace(/^import \* as \w+ from ['"]\/src\/wasm-js-bridge\/[^'"]+['"];?\s*$/gm, '');
jsSource = jsSource.replace(/^const .+ = require\(.*\/src\/wasm-js-bridge\/[^)]+\);?\s*$/gm, '');

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

// These are the module-level require() results that wasm-bindgen references
const import1 = { jsRenderEjs, jsRenderSimpleTemplate, jsTemplateAvailable };
const import2 = { jsCompileSass, jsSassAvailable };

`;
jsSource = stubs + jsSource;

// Write patched module
const tmpFile = join(__dirname, '_test_patched_wasm.mjs');
await writeFile(tmpFile, jsSource);

try {
  const mod = await import(tmpFile);

  // Initialize — web target needs a WebAssembly.Module, not raw bytes
  const wasmBytes = await readFile(join(pkgDir, 'wasm_quarto_hub_client_bg.wasm'));
  const wasmModule = await WebAssembly.compile(wasmBytes);
  await mod.default(wasmModule);

  console.log('WASM module initialized with Lua!\n');

  // Test 0: basic unwind (no Lua)
  console.log('Test 0: Basic catch_unwind (no Lua)');
  try {
    const r0 = mod.test_unwind();
    console.log(`  Result: ${r0}`);
    console.log(`  ${r0.includes('caught panic') ? 'PASS' : 'FAIL'}`);
  } catch (e) {
    console.log(`  TRAP: ${e.message}`);
    console.log('  The unwind mechanism itself is broken in this binary.');
    process.exit(1);
  }

  // Capture console.error output
  const origError = console.error;
  let lastError = '';
  console.error = (...args) => { lastError = args.join(' '); origError.apply(console, args); };

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
      console.log(`  ERROR: ${e.message}`);
      console.log(`  Stack: ${e.stack?.split('\n').slice(0,5).join('\n  ')}`);
      failed++;
    }
  }

  // Smoke test: verify tree-sitter / QMD parsing still works
  console.log('\nSmoke test: parse_qmd_content (tree-sitter)');
  try {
    const qmd = '# Hello\n\nWorld\n';
    const result = mod.parse_qmd_content(qmd);
    const parsed = JSON.parse(result);
    if (parsed.success) {
      console.log('  PASS — QMD parsing works');
      passed++;
    } else {
      console.log(`  FAIL — parse returned success=false: ${result.slice(0, 200)}`);
      failed++;
    }
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
    console.log(`  Stack: ${e.stack?.split('\n').slice(0,5).join('\n  ')}`);
    failed++;
  }

  console.log(`\n${passed} passed, ${failed} failed out of ${tests.length + 1} tests`);
  process.exit(failed > 0 ? 1 : 0);
} finally {
  await unlink(tmpFile).catch(() => {});
}
