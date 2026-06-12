//! Quoll instrumentation core — single Oxc pass:
//! parse TS/JSX → strip types/JSX (Transformer) → codegen with ONE source map.
//!
//! Phase 3 scope: transpile + source map only. Phase 4 adds the Traverse-based
//! value-capture/coverage injection into this same pass, which is the whole
//! reason this pipeline is single-pass (no source-map composition).

use std::path::Path;

use napi_derive::napi;
use oxc_allocator::Allocator;
use oxc_codegen::{Codegen, CodegenOptions};
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;
use oxc_transformer::{TransformOptions, Transformer};

#[napi(object)]
pub struct InstrumentOpts {
    pub filename: String,
    pub jsx: bool,
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
    /// Fatal parse/transform errors. Non-empty means `code` is unusable.
    pub errors: Vec<InstrumentError>,
}

fn offset_to_line(source: &str, offset: u32) -> u32 {
    let upto = &source[..(offset as usize).min(source.len())];
    upto.bytes().filter(|&b| b == b'\n').count() as u32 + 1
}

#[napi]
pub fn instrument(source: String, opts: InstrumentOpts) -> InstrumentResult {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(Path::new(&opts.filename))
        .unwrap_or_else(|_| if opts.jsx { SourceType::tsx() } else { SourceType::ts() });

    let parser_ret = Parser::new(&allocator, &source, source_type).parse();
    if parser_ret.panicked || !parser_ret.errors.is_empty() {
        return InstrumentResult {
            code: String::new(),
            map_json: String::new(),
            errors: parser_ret
                .errors
                .iter()
                .map(|e| InstrumentError {
                    message: e.to_string(),
                    line: e.labels.as_ref().and_then(|labels| {
                        labels.first().map(|l| offset_to_line(&source, l.offset() as u32))
                    }),
                })
                .collect(),
        };
    }
    let mut program = parser_ret.program;

    let scoping = SemanticBuilder::new().build(&program).semantic.into_scoping();
    let transform_options = TransformOptions::default();
    let transformer_ret =
        Transformer::new(&allocator, Path::new(&opts.filename), &transform_options)
            .build_with_scoping(scoping, &mut program);
    if !transformer_ret.errors.is_empty() {
        return InstrumentResult {
            code: String::new(),
            map_json: String::new(),
            errors: transformer_ret
                .errors
                .iter()
                .map(|e| InstrumentError { message: e.to_string(), line: None })
                .collect(),
        };
    }

    let codegen_ret = Codegen::new()
        .with_options(CodegenOptions {
            source_map_path: Some(opts.filename.clone().into()),
            ..CodegenOptions::default()
        })
        .build(&program);

    InstrumentResult {
        code: codegen_ret.code,
        map_json: codegen_ret.map.map(|m| m.to_json_string()).unwrap_or_default(),
        errors: vec![],
    }
}
