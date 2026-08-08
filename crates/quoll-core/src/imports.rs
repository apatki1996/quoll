//! Module-request collection and AST-level specifier rewriting (Phase 6).
//!
//! The host resolves the entry's module requests (relative → absolute
//! `file://` URLs so the runner's `data:` entry can load them) and passes the
//! result back as a rewrite map; we swap the specifier strings in the AST
//! before the one codegen. Doing this at the AST level — instead of regex
//! over the generated code — means a user string literal that merely LOOKS
//! like an import statement can never be corrupted.

use std::collections::{HashMap, HashSet};

use oxc_allocator::Allocator;
use oxc_ast::ast::*;
use oxc_ast_visit::{Visit, VisitMut, walk, walk_mut};
use oxc_str::Str;

/// Every statically-knowable module request: static import/export-from
/// sources plus string-literal dynamic `import()`s. First-appearance order,
/// deduped. Computed-specifier dynamic imports are invisible here by nature.
#[derive(Default)]
pub struct RequestCollector {
    seen: HashSet<String>,
    pub requests: Vec<String>,
}

impl RequestCollector {
    fn record(&mut self, specifier: &str) {
        if self.seen.insert(specifier.to_string()) {
            self.requests.push(specifier.to_string());
        }
    }
}

// The walk calls matter even on import nodes: an export-from declaration can
// contain initializers with nested dynamic imports (`export const f = () =>
// import("./x")`), and dynamic imports appear at any expression depth.
impl<'a> Visit<'a> for RequestCollector {
    fn visit_import_declaration(&mut self, decl: &ImportDeclaration<'a>) {
        self.record(decl.source.value.as_str());
        walk::walk_import_declaration(self, decl);
    }

    fn visit_export_from_declaration(&mut self, decl: &ExportFromDeclaration<'a>) {
        self.record(decl.source.value.as_str());
        walk::walk_export_from_declaration(self, decl);
    }

    fn visit_export_all_declaration(&mut self, decl: &ExportAllDeclaration<'a>) {
        self.record(decl.source.value.as_str());
        walk::walk_export_all_declaration(self, decl);
    }

    fn visit_import_expression(&mut self, expr: &ImportExpression<'a>) {
        if let Expression::StringLiteral(lit) = &expr.source {
            self.record(lit.value.as_str());
        }
        walk::walk_import_expression(self, expr);
    }
}

/// Applies the host-resolved specifier map to the same import positions the
/// collector reads. Specifiers not in the map are left untouched (bare
/// node:/npm specifiers, unresolvable paths — they surface as real runtime
/// errors rather than being silently dropped).
pub struct ImportRewriter<'a, 'm> {
    allocator: &'a Allocator,
    rewrites: &'m HashMap<String, String>,
}

impl<'a, 'm> ImportRewriter<'a, 'm> {
    pub fn new(allocator: &'a Allocator, rewrites: &'m HashMap<String, String>) -> Self {
        Self {
            allocator,
            rewrites,
        }
    }

    fn rewrite(&self, lit: &mut StringLiteral<'a>) {
        if let Some(replacement) = self.rewrites.get(lit.value.as_str()) {
            lit.value = Str::from(self.allocator.alloc_str(replacement));
            lit.raw = None; // codegen must print from `value`, not the original raw text
        }
    }
}

impl<'a> VisitMut<'a> for ImportRewriter<'a, '_> {
    fn visit_import_declaration(&mut self, decl: &mut ImportDeclaration<'a>) {
        self.rewrite(&mut decl.source);
        walk_mut::walk_import_declaration(self, decl);
    }

    fn visit_export_from_declaration(&mut self, decl: &mut ExportFromDeclaration<'a>) {
        self.rewrite(&mut decl.source);
        walk_mut::walk_export_from_declaration(self, decl);
    }

    fn visit_export_all_declaration(&mut self, decl: &mut ExportAllDeclaration<'a>) {
        self.rewrite(&mut decl.source);
        walk_mut::walk_export_all_declaration(self, decl);
    }

    fn visit_import_expression(&mut self, expr: &mut ImportExpression<'a>) {
        if let Expression::StringLiteral(lit) = &mut expr.source {
            self.rewrite(lit);
        }
        walk_mut::walk_import_expression(self, expr);
    }
}
