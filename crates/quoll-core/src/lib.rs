//! Quoll instrumentation core — single Oxc pass:
//! parse TS/JSX → strip types/JSX (Transformer) → codegen with ONE source map.
//!
//! Phase 3 scope: transpile + source map only. Phase 4 adds the Traverse-based
//! value-capture/coverage injection into this same pass, which is the whole
//! reason this pipeline is single-pass (no source-map composition).

mod imports;
mod instrument;

use std::collections::{HashMap, HashSet};
use std::path::Path;

use napi_derive::napi;
use oxc_allocator::Allocator;
use oxc_ast::ast::Comment;
use oxc_ast_visit::{Visit, VisitMut};
use oxc_codegen::{Codegen, CodegenOptions};
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;
use oxc_transformer::{TransformOptions, Transformer};

use imports::{ImportRewriter, RequestCollector};
use instrument::{Annotations, Instrumenter};

/// A caller-supplied capture position (protocol `ExtraSite`). This is the
/// entire mechanism behind value-on-selection (Phase 8) and Logpoints
/// (Phase 9): both are ordinary value captures that differ only in what
/// ASKED for them.
#[napi(object)]
pub struct NapiExtraSite {
    /// 1-based source line.
    pub line: u32,
    /// 0-based BYTE column. VS Code counts UTF-16 code units, so the host
    /// converts before calling (see `prepareRun`) — this is the same
    /// coordinate space `NapiCaptureSite.column` reports back.
    pub column: u32,
    /// "logpoint" | "selection" (protocol `ExtraSiteKind`).
    pub kind: String,
}

#[napi(object)]
pub struct InstrumentOpts {
    pub filename: String,
    pub jsx: bool,
    /// Module-specifier replacements (original → resolved), applied at the
    /// AST level before codegen. The host builds this from `list_imports`
    /// output (Phase 6 import resolution). Absent/empty = no rewriting.
    pub rewrites: Option<HashMap<String, String>>,
    /// Extra capture positions the caller wants tagged as opt-in, so quiet
    /// mode reveals them. Absent/empty = source annotations only.
    pub extra_sites: Option<Vec<NapiExtraSite>>,
}

#[napi(object)]
pub struct NapiCaptureSite {
    pub id: u32,
    /// 1-based lines, 0-based byte columns, original-source coordinates.
    pub line: u32,
    pub column: u32,
    pub end_line: u32,
    pub end_column: u32,
    /// "expr" | "statement" | "branch" | "comment" | "perf" | "logpoint"
    /// | "selection" (see protocol CaptureSiteKind).
    pub kind: String,
}

#[napi(object)]
pub struct InstrumentError {
    pub message: String,
    /// 1-based source line of the error start, when known.
    pub line: Option<u32>,
}

#[napi(object)]
pub struct InstrumentResult {
    pub code: String,
    /// Source map v3 as JSON (host parses into RawSourceMap).
    pub map_json: String,
    /// Capture sites injected into `code`, original-source positions.
    pub sites: Vec<NapiCaptureSite>,
    /// Fatal parse/transform errors. Non-empty means `code` is unusable.
    pub errors: Vec<InstrumentError>,
}

/// Parse-only listing of the source's module requests (static import/export
/// sources + string-literal dynamic imports), so the host can resolve them
/// BEFORE calling `instrument` with the resulting rewrite map. Parse errors
/// are not reported here — `instrument` is the error authority — but requests
/// collected from the partial AST are still returned.
#[napi]
pub fn list_imports(source: String, filename: String, jsx: bool) -> Vec<String> {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(Path::new(&filename)).unwrap_or_else(|_| {
        if jsx {
            SourceType::tsx()
        } else {
            SourceType::ts()
        }
    });
    let parser_ret = Parser::new(&allocator, &source, source_type).parse();
    let mut collector = RequestCollector::default();
    collector.visit_program(&parser_ret.program);
    collector.requests
}

/// Phase 8 live comments: classify trailing line comments by the source line
/// they sit on. `//?.` → perf timing, `//?` → value comment. Strict on the
/// char immediately after `//` (must be `?`) so `// ? prose` never matches.
/// Collected from the parsed comments BEFORE the AST is moved into transform.
fn collect_annotations(source: &str, comments: &[Comment]) -> (HashSet<u32>, HashSet<u32>) {
    let mut perf = HashSet::new();
    let mut comment = HashSet::new();
    for c in comments {
        if !c.is_line() {
            continue;
        }
        let span = c.content_span();
        let text = &source[span.start as usize..span.end as usize];
        let Some(rest) = text.strip_prefix('?') else {
            continue;
        };
        let line = offset_to_line(source, c.span.start);
        if rest.starts_with('.') {
            perf.insert(line);
        } else {
            comment.insert(line);
        }
    }
    (perf, comment)
}

/// Merge the source-derived annotations with the caller's `extra_sites` into
/// the single input the pass reads. An unrecognized kind is DROPPED rather
/// than failing the run: `extra_sites` comes from editor state (a breakpoint,
/// a selection) that must never be able to break instrumentation.
fn build_annotations(
    perf_lines: HashSet<u32>,
    comment_lines: HashSet<u32>,
    extra_sites: Option<&[NapiExtraSite]>,
) -> Annotations {
    let mut annotations = Annotations {
        perf_lines,
        comment_lines,
        ..Annotations::default()
    };
    for site in extra_sites.unwrap_or_default() {
        match site.kind.as_str() {
            "logpoint" => {
                annotations.logpoint_lines.insert(site.line);
            }
            "selection" => annotations.selections.push((site.line, site.column)),
            _ => {}
        }
    }
    annotations
}

fn offset_to_line(source: &str, offset: u32) -> u32 {
    // Byte slice, not &str slice: a label offset landing mid-character must
    // not panic on a char boundary.
    let end = (offset as usize).min(source.len());
    source.as_bytes()[..end]
        .iter()
        .filter(|&&b| b == b'\n')
        .count() as u32
        + 1
}

#[napi]
pub fn instrument(source: String, opts: InstrumentOpts) -> InstrumentResult {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(Path::new(&opts.filename)).unwrap_or_else(|_| {
        if opts.jsx {
            SourceType::tsx()
        } else {
            SourceType::ts()
        }
    });

    let parser_ret = Parser::new(&allocator, &source, source_type).parse();
    if parser_ret.panicked || !parser_ret.diagnostics.is_empty() {
        let mut errors: Vec<InstrumentError> = parser_ret
            .diagnostics
            .iter()
            .map(|e| InstrumentError {
                message: e.to_string(),
                line: e
                    .labels
                    .as_slice()
                    .first()
                    .map(|l| offset_to_line(&source, l.offset())),
            })
            .collect();
        // `panicked` with no diagnostics would otherwise look like success to
        // the host (errors.length === 0) with empty code and an unparseable
        // empty map_json.
        if errors.is_empty() {
            errors.push(InstrumentError {
                message: "parser panicked without diagnostics".to_string(),
                line: None,
            });
        }
        return InstrumentResult {
            code: String::new(),
            map_json: String::new(),
            sites: vec![],
            errors,
        };
    }
    let mut program = parser_ret.program;

    // Phase 8: read `//?` / `//?.` annotations from the parsed comments now,
    // before the transformer consumes the AST. Lines are original-source, which
    // is the same coordinate space the Instrumenter tags sites in — and the same
    // space the caller's `extra_sites` arrive in, so the two merge cleanly.
    let (perf_lines, comment_lines) = collect_annotations(&source, &program.comments);
    let annotations = build_annotations(perf_lines, comment_lines, opts.extra_sites.as_deref());

    let scoping = SemanticBuilder::new()
        .build(&program)
        .semantic
        .into_scoping();
    let transform_options = TransformOptions::default();
    let transformer_ret =
        Transformer::new(&allocator, Path::new(&opts.filename), &transform_options)
            .build_with_scoping(scoping, &mut program);
    if !transformer_ret.diagnostics.is_empty() {
        return InstrumentResult {
            code: String::new(),
            map_json: String::new(),
            sites: vec![],
            errors: transformer_ret
                .diagnostics
                .iter()
                .map(|e| InstrumentError {
                    message: e.to_string(),
                    line: None,
                })
                .collect(),
        };
    }

    // Phase 6: apply host-resolved import rewrites in the AST so they land in
    // the generated code through the same single codegen/source-map pass.
    if let Some(rewrites) = opts.rewrites.as_ref().filter(|m| !m.is_empty()) {
        ImportRewriter::new(&allocator, rewrites).visit_program(&mut program);
    }

    // Phase 4: inject value-capture + coverage into the SAME AST before the
    // single codegen — no second pass, no source-map composition.
    let mut instrumenter = Instrumenter::new(&allocator, &source, annotations);
    instrumenter.visit_program(&mut program);
    // Anchors that landed outside every capture span fall back to their line.
    instrumenter.resolve_unclaimed_selections();

    let codegen_ret = Codegen::new()
        .with_options(CodegenOptions {
            source_map_path: Some(opts.filename.clone().into()),
            ..CodegenOptions::default()
        })
        .build(&program);

    InstrumentResult {
        code: codegen_ret.code,
        map_json: codegen_ret
            .map
            .map(|m| m.to_json_string())
            .unwrap_or_default(),
        sites: instrumenter
            .sites
            .iter()
            .map(|s| NapiCaptureSite {
                id: s.id,
                line: s.line,
                column: s.column,
                end_line: s.end_line,
                end_column: s.end_column,
                kind: s.kind.to_string(),
            })
            .collect(),
        errors: vec![],
    }
}
