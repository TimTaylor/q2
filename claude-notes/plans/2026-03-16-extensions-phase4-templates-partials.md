# Extensions Phase 4: Template and Partial Support

**Created**: 2026-03-16
**Status**: Not started
**Parent Plan**: `claude-notes/plans/2026-03-16-extensions-master-plan.md`
**Depends on**: Phase 1 (complete)

## Overview

Extensions can declare custom templates and template-partials in their
`contributes.formats.<format>` section. These override or supplement the
built-in templates used by `ApplyTemplateStage`.

### Goals

1. An extension declaring `template: template.html` in its format config
   causes that template to be used instead of the built-in HTML template
2. An extension declaring `template-partials: [title-block.html]` causes
   those partials to be available when compiling the template (either the
   extension's custom template or the built-in template)
3. Extension partials override same-named built-in partials
4. Document/directory metadata `template` and `template-partials` override
   extension values (higher precedence in the merge order)

### Non-Goals

- PDF/LaTeX templates (q2 only renders HTML natively for now)
- Pandoc template staging (q2 has its own template engine)
- Template validation or schema checking

## How TS Quarto Does It

In TS Quarto, `template` and `template-partials` are standard format metadata
keys. After format resolution (which merges extension config), they appear in
the merged format config. During `runPandoc()`:

1. `readPartials(metadata)` extracts `template-partials` from merged metadata,
   expands globs, resolves paths
2. Each format defines a `templateContext` with default partials
3. User/extension partials are appended (same-name = override)
4. Everything is staged as files for Pandoc's template engine

Key difference: TS Quarto delegates to Pandoc for template rendering, so it
stages files to a temp directory. q2 has its own `quarto-doctemplate` engine,
so we can resolve partials in-memory or from the filesystem directly.

## What q2 Already Has

### Template engine (`quarto-doctemplate`)

- `PartialResolver` trait with `get_partial(name, base_path) -> Option<String>`
- `FileSystemResolver` -- reads partials from disk via `std::fs::read_to_string`
- `MemoryResolver` -- in-memory map of name -> content (for tests/bundled)
- `NullResolver` -- returns nothing (used for built-in templates today)
- `Template::compile_with_resolver(source, path, resolver, depth)` -- compiles
  with partial resolution
- `Template::compile_from_file(path)` -- compiles from disk with FileSystemResolver

**WASM limitation**: Both `FileSystemResolver` and `Template::compile_from_file`
use `std::fs` directly, not `SystemRuntime`. They cannot access the WASM VFS.
Phase 4.0 addresses this.

### Template integration (`quarto-core/src/template.rs`)

- `MINIMAL_HTML_TEMPLATE` and `FULL_HTML_TEMPLATE` -- built-in string constants
- `minimal_html_template()` / `full_html_template()` -- compile via `Template::compile()`
  which uses `NullResolver` (no partials in built-in templates today)
- `render_with_format(body, meta, format, css_paths)` -- selects minimal vs full
  based on `is_minimal_html(meta)`, adds CSS paths, renders
- `render_with_custom_template(template, body, meta)` -- renders with a
  pre-compiled Template object

**Metadata filtering**: `render_with_format()` (line 338) excludes only `css`
from the template context (via `add_metadata_to_context_except` at line 387).
`render_with_custom_template()` (line 267) excludes nothing (uses
`add_metadata_to_context`). Both are in `template.rs`. This means `template`
and `template-partials` will leak into the template context as `$template$` /
`$template-partials$` unless we add them to the exclusion list. Phase 4.4
addresses this.

### Apply template stage (`quarto-core/src/stage/stages/apply_template.rs`)

- `ApplyTemplateConfig` has `template: Option<Template>` -- if set, uses it;
  otherwise calls `render_with_format()` for built-in selection
- The stage receives `RenderedOutput` which includes `metadata: ConfigValue`
  (the fully merged metadata from MetadataMergeStage)

### Extension metadata flow (Phase 1, complete)

- `template` and `template-partials` from `_extension.yml` already flow
  through as format metadata keys in `ConfigValue`
- After `MetadataMergeStage`, they appear in `doc.ast.meta` alongside
  `toc`, `theme`, etc.
- Path values in extension YAML are plain strings relative to the extension
  dir. They are NOT yet `ConfigValueKind::Path` -- only filter/shortcode paths
  are resolved to absolute in `read_extension()`.

### The `!path` tag system

q2 has a `!path` YAML tag that marks values as `ConfigValueKind::Path`. These
are automatically adjusted by `adjust_paths_to_document_dir()` during metadata
merge -- relative paths are rebased from the metadata source dir to the document
dir. This is exactly what we need for extension template paths.

However, extension authors won't write `!path` tags in their YAML. Instead,
`read_extension()` should convert known path-valued keys (`template`,
`template-partials`) from `ConfigValueKind::Scalar(String)` to
`ConfigValueKind::Path(String)` during parsing. Then the existing merge
pipeline handles path resolution automatically -- no special-casing needed
in `ApplyTemplateStage`.

## Design Decisions

**Where to resolve extension template paths**: Convert them to
`ConfigValueKind::Path` values in `parse_formats()` (`extension/read.rs`).
The function already accepts `ext_dir: &Path` (currently unused with `_`
prefix). Then add `adjust_paths_to_document_dir()` on the extension layer in
`MetadataMergeStage`, using the extension's directory as the source dir.
This reuses the existing `!path` resolution machinery and means all
path-valued metadata keys in extension format config are handled uniformly.

To make the extension dir available at merge time, `build_extension_metadata_layer`
returns `Option<(ConfigValue, PathBuf)>` instead of `Option<ConfigValue>`.
The `PathBuf` comes from `ext.path.clone()` on the matched `Extension`.

See also: `claude-notes/investigations/2026-03-16-investigate-extension-path-resolution.md` for whether
filters/shortcodes should migrate to this pattern too (conclusion: no).

**Where to compile the template**: In `ApplyTemplateStage::run()`. The stage
already has access to the merged metadata. After merge, `template` is a
resolved path string. The stage reads it, compiles with partials, renders.

**How to read template/partial files**: Always use `ctx.runtime.file_read_string()`
(never `std::fs`). This ensures WASM VFS compatibility. The template content is
read into a String, then compiled with `Template::compile_with_resolver()`.
`Template::compile_from_file()` is NOT used (it calls `std::fs` internally).

**Resolver strategy**: There are three cases:

1. **Custom template, no explicit `template-partials`**: Read template content
   via `ctx.runtime.file_read_string()`. Compile with a `RuntimeResolver`
   (new resolver backed by `SystemRuntime`) that loads partials from the
   template's directory via the runtime. This replaces the `FileSystemResolver`
   path for WASM compatibility.

2. **Custom template + explicit `template-partials`**: Need a `ChainedResolver`
   that tries explicit partials first, then falls back to `RuntimeResolver`
   for any partials the template references that aren't in the explicit list.
   Build a `MemoryResolver` from the explicit partial files (read content via
   runtime, key by filename **stem**), then chain: explicit -> runtime.

3. **No custom template + explicit `template-partials`**: Compile the built-in
   template (minimal or full) with a `MemoryResolver` containing the explicit
   partials. Since built-in templates currently don't use partials, this is
   a no-op today but the infrastructure should support it for when we add
   partials to the built-in templates.

**Partial name keying**: Partials are keyed by **stem** (e.g.,
`title-block.html` -> key `"title-block"`). The template parser extracts the
stem from `$title-block()$` and passes it to `PartialResolver::get_partial`.
The `MemoryResolver` tests confirm this convention. This matches Pandoc's
behavior. Confirmed via deepwiki and `quarto-doctemplate` test suite.

**Stripping `template` from the template context**: Add `"template"` and
`"template-partials"` to the exclusion list in `add_metadata_to_context_except()`
in `template.rs` (line 387). Currently only `"css"` is excluded. This affects:
- `render_with_format()` (line 338) -- already uses `_except` variant
- `render_with_resources()` (line 294) -- already uses `_except` variant
- `render_with_custom_template()` (line 267) -- currently uses
  `add_metadata_to_context()` with NO exclusions; must switch to
  `add_metadata_to_context_except()` with the same exclusion list

## Work Items

### Phase 4.0: RuntimeResolver -- WASM-compatible partial resolution

This is a prerequisite: the existing `FileSystemResolver` uses `std::fs`
and cannot work in WASM. We need a resolver that uses `SystemRuntime`.

Since `PartialResolver` lives in `quarto-doctemplate` (which has no dependency
on `quarto-system-runtime`), the `RuntimeResolver` must live in `quarto-core`
(which depends on both).

- [x] **4.0.1** Add `RuntimeResolver` in `quarto-core/src/template.rs`
- [x] **4.0.2** Add `ChainedResolver` to `quarto-doctemplate/src/resolver.rs`
- [x] **4.0.3** Tests for `RuntimeResolver`: loads partial via runtime,
  returns None when file missing, resolves extension from base path
- [x] **4.0.4** Tests for `ChainedResolver`: primary wins, fallback used when
  primary returns None, None when both missing

### Phase 4.1: Path resolution for extension template values

- [ ] **4.1.1** In `parse_formats()` (`extension/read.rs`), remove the
  underscore prefix from `_ext_dir` and use it to walk the format config.
  Convert `template` (string) and `template-partials` (array of strings)
  from `ConfigValueKind::Scalar` to `ConfigValueKind::Path`. This marks them
  for path adjustment during merge.

- [ ] **4.1.2** Change `build_extension_metadata_layer()` in `metadata_merge.rs`
  (line 86) to return `Option<(ConfigValue, PathBuf)>` instead of
  `Option<ConfigValue>`. The `PathBuf` is `ext.path.clone()` from the matched
  `Extension` struct (which already stores the absolute extension dir).

- [ ] **4.1.3** In `MetadataMergeStage::run()`, after getting the extension
  layer (line 202), destructure the tuple and call
  `adjust_paths_to_document_dir(&mut ext_config, &extension_dir, &document_dir)`
  on it, just like the project layer already does at line 197.

- [ ] **4.1.4** Tests:
  - Verify that after `parse_formats()`, `template` and `template-partials`
    values are `ConfigValueKind::Path`
  - Verify that after metadata merge, extension `!path` values are rebased
    correctly from extension dir to document dir
  - Verify non-path metadata (e.g., `toc: true`) is unaffected

### Phase 4.2: Extract template config from merged metadata

- [ ] **4.2.1** In `ApplyTemplateStage::run()`, after receiving `RenderedOutput`,
  extract `template` and `template-partials` from `rendered.metadata`:
  ```rust
  let custom_template_path = metadata.get("template").and_then(|v| v.as_str());
  let partial_paths: Vec<String> = metadata.get("template-partials")
      .and_then(|v| v.as_array())
      .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
      .unwrap_or_default();
  ```
- [ ] **4.2.2** Tests: verify extraction works for present/absent/empty values

### Phase 4.3: Compile and apply extension templates

- [ ] **4.3.1** Custom template, no explicit partials: read template content
  via `ctx.runtime.file_read_string(path)`, compile with `RuntimeResolver`
  backed by `ctx.runtime`

- [ ] **4.3.2** Custom template + explicit `template-partials`: read all
  partial files via `ctx.runtime.file_read_string()`, build `MemoryResolver`
  keyed by file stem, chain with `RuntimeResolver`, compile template with
  `ChainedResolver`

- [ ] **4.3.3** No custom template + explicit `template-partials`: build
  `MemoryResolver`, compile built-in template (minimal or full) with it.
  New function in `template.rs`:
  ```rust
  pub fn compile_builtin_template_with_partials(
      meta: &ConfigValue,
      resolver: &impl PartialResolver,
  ) -> Result<Template>
  ```

- [ ] **4.3.4** When neither is set: existing behavior unchanged (regression)

- [ ] **4.3.5** Error handling: if template file doesn't exist or can't be
  compiled, produce a clear error with the extension name and path

### Phase 4.4: Strip template keys from template context

- [ ] **4.4.1** In `template.rs`, add `"template"` and `"template-partials"`
  to the exclusion list used by `add_metadata_to_context_except()` (line 387).
  Currently only `"css"` is excluded. This affects `render_with_format()`
  (line 338) and `render_with_resources()` (line 294) which already use the
  `_except` variant.

- [ ] **4.4.2** Change `render_with_custom_template()` (line 267) to use
  `add_metadata_to_context_except()` instead of `add_metadata_to_context()`,
  with the same exclusion list (`["css", "template", "template-partials"]`).

- [ ] **4.4.3** Test: verify `$template$` does not render in output when
  extension provides a template path

### Phase 4.5: Integration tests

- [ ] **4.5.1** Unit test: extension provides custom template -> output uses
  that template's structure
- [ ] **4.5.2** Unit test: extension provides custom template + explicit
  partials -> partials override filesystem partials
- [ ] **4.5.3** Unit test: extension provides only template-partials (no
  custom template) -> partials available when compiling built-in template
- [ ] **4.5.4** Unit test: document metadata `template` overrides extension
  `template` (higher precedence in merge)
- [ ] **4.5.5** Unit test: no template/partials -> existing behavior unchanged
- [ ] **4.5.6** Integration test in `ApplyTemplateStage` with mock metadata
  containing template path

### Phase 4.6: Smoke Tests

- [ ] **4.6.1** Create `extensions/custom-template/` smoke test:
  - Extension with a simple custom HTML template
  - Verify output matches custom template structure (not built-in)

- [ ] **4.6.2** Create `extensions/template-partials/` smoke test:
  - Extension with a custom template that uses `$header()$` partial
  - Extension provides the partial file
  - Verify partial content appears in output

### Phase 4.7: Workspace Verification

- [ ] **4.7.1** `cargo build --workspace`
- [ ] **4.7.2** `cargo nextest run --workspace`

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `crates/quarto-doctemplate/src/resolver.rs` | Modify | Add `ChainedResolver` |
| `crates/quarto-core/src/template.rs` | Modify | Add `RuntimeResolver`, `compile_builtin_template_with_partials()`, update exclusion lists in all three render functions |
| `crates/quarto-core/src/extension/read.rs` | Modify | Convert `template`/`template-partials` to `ConfigValueKind::Path` in `parse_formats()`, remove `_` prefix from `ext_dir` |
| `crates/quarto-core/src/stage/stages/metadata_merge.rs` | Modify | Return `(ConfigValue, PathBuf)` from `build_extension_metadata_layer`, call `adjust_paths_to_document_dir` on extension layer |
| `crates/quarto-core/src/stage/stages/apply_template.rs` | Modify | Extract template config from metadata, compile with resolver via runtime |
| `crates/quarto/tests/smoke-all/extensions/custom-template/` | Create | Smoke test |
| `crates/quarto/tests/smoke-all/extensions/template-partials/` | Create | Smoke test |

## Key APIs

**Reading partial files into MemoryResolver** (via runtime, not std::fs):
```rust
fn build_partial_resolver(
    partial_paths: &[String],
    runtime: &dyn SystemRuntime,
) -> MemoryResolver {
    let mut resolver = MemoryResolver::new();
    for path_str in partial_paths {
        let path = Path::new(path_str);
        if let Ok(content) = runtime.file_read_string(path) {
            let name = path.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(path_str);
            resolver.add(name, content);
        }
    }
    resolver
}
```

**Compiling template from runtime-read content**:
```rust
let template_content = ctx.runtime.file_read_string(Path::new(template_path))?;
let runtime_resolver = RuntimeResolver::new(ctx.runtime.as_ref());
let template = Template::compile_with_resolver(
    &template_content,
    Path::new(template_path),
    &runtime_resolver,
    0,
)?;
```

## Risks and Open Questions

1. **SystemRuntime in ApplyTemplateStage**: The stage has access to `ctx.runtime`
   for reading extension template/partial files. No new plumbing needed.

2. **WASM compatibility**: Fully addressed by `RuntimeResolver` (Phase 4.0).
   All file reads go through `ctx.runtime.file_read_string()`, which handles
   the VFS in WASM context. `FileSystemResolver` and `compile_from_file` are
   not used for extension templates.

3. **Partial name resolution**: Partials are keyed by **stem** (e.g.,
   `title-block.html` -> `"title-block"`). The template parser passes the stem
   to `get_partial`. `MemoryResolver` looks up by exact name match. This
   matches Pandoc/TS Quarto conventions. Confirmed via deepwiki and
   `quarto-doctemplate` test suite.

4. **What about `template` in document metadata?** If a user writes
   `template: !path my-template.html` in their frontmatter, the `!path` tag
   makes it a `ConfigValueKind::Path` which `adjust_paths_to_document_dir()`
   resolves automatically. If they write `template: my-template.html`
   (no tag), it's a plain string and won't be adjusted -- it would need to
   be resolved relative to the document dir in `ApplyTemplateStage`. For
   Phase 4, we only need to handle the extension case (where we add the
   `!path` conversion in `read_extension`). Document-level template support
   can be added later.

5. **Which keys need `!path` conversion?** In TS Quarto, `template` and
   `template-partials` are the path-valued keys in format config. Other
   format-resources paths (`format-resources`, `css`) may also need this
   treatment in later phases, but Phase 4 only covers template/partials.

6. **Should filters/shortcodes also use `!path` instead of absolute resolution?**
   See separate investigation:
   `claude-notes/investigations/2026-03-16-investigate-extension-path-resolution.md`
   Conclusion: No. Absolute is correct for execution paths, `!path` for metadata.
