//! Value-capture + coverage injection — the Traverse/VisitMut half of the
//! single Oxc pass. Runs AFTER the TS/JSX strip on the same AST, BEFORE the
//! one codegen, so there is exactly one source map.
//!
//! Injections (all referencing the `__quoll` global the runner defines):
//! - value sites (`expr`):      `init` → `__quoll.log(id, init)` on
//!   variable-declarator inits, return arguments, and expression statements
//!   (console.* calls excluded — they're captured by the console patch).
//! - statement sites:           `__quoll.cover(id);` inserted before each
//!   statement in every statement list (imports excluded).
//! - branch sites:              ternary arms and logical-expression RHS →
//!   `(__quoll.cover(id), arm)`.
//!
//! Value sites carry an opt-in KIND (`expr` by default; `comment`/`perf` from
//! `//?`/`//?.`; `selection`/`logpoint` from caller-supplied `extra_sites`).
//! The kind changes only the host's quiet-mode filter, never the capture —
//! except `perf`, which times the expression instead of reading it.
//!
//! CRITICAL: every synthesized node carries the span of the user node it
//! wraps/precedes. Empty (0,0) spans would emit source-map segments pointing
//! at line 1 and corrupt line attribution for anything sharing the line.

use std::collections::HashSet;

use oxc_allocator::{Allocator, Vec as ArenaVec};
use oxc_ast::ast::*;
use oxc_ast::builder::AstBuilder;
use oxc_ast_visit::VisitMut;
use oxc_ast_visit::walk_mut;
use oxc_span::{GetSpan, Span};

/// Everything the pass needs to tag a value site beyond the AST itself: the
/// `//?`/`//?.` annotations read from the source comments, plus the caller's
/// `extra_sites` (Logpoints, value-on-selection).
///
/// The two caller-supplied kinds deliberately differ in granularity, because
/// their SOURCES do: a VS Code breakpoint marks a LINE, so a logpoint is a line
/// set exactly like `//?`; an editor selection marks a SPAN, so a selection is
/// an anchor offset that claims the innermost capture containing it.
#[derive(Default)]
pub struct Annotations {
    /// Source lines carrying `//?.` (perf timing).
    pub perf_lines: HashSet<u32>,
    /// Source lines carrying `//?` (value comment).
    pub comment_lines: HashSet<u32>,
    /// Source lines holding a caller-supplied logpoint.
    pub logpoint_lines: HashSet<u32>,
    /// Caller-supplied selection anchors as (1-based line, 0-based byte column).
    pub selections: Vec<(u32, u32)>,
}

/// A selection anchor resolved to an absolute offset. `claimed` is what makes
/// the INNERMOST containing capture win: children are visited before their
/// parents, so by the time an outer capture asks, the anchor is already taken.
struct Selection {
    offset: u32,
    line: u32,
    claimed: bool,
}

pub struct SiteRec {
    pub id: u32,
    pub line: u32,
    pub column: u32,
    pub end_line: u32,
    pub end_column: u32,
    pub kind: &'static str,
}

pub struct Instrumenter<'a> {
    ast: AstBuilder<'a>,
    line_starts: Vec<u32>,
    pub sites: Vec<SiteRec>,
    /// Source lines carrying a `//?.` perf annotation (Phase 8 live comments).
    perf_lines: HashSet<u32>,
    /// Source lines carrying a `//?` value-comment annotation.
    comment_lines: HashSet<u32>,
    /// Source lines carrying a caller-supplied logpoint (Phase 9).
    logpoint_lines: HashSet<u32>,
    /// Caller-supplied selection anchors, offset-resolved (Phase 8).
    selections: Vec<Selection>,
}

impl<'a> Instrumenter<'a> {
    pub fn new(allocator: &'a Allocator, source: &str, annotations: Annotations) -> Self {
        let mut line_starts = vec![0u32];
        for (i, b) in source.bytes().enumerate() {
            if b == b'\n' {
                line_starts.push(i as u32 + 1);
            }
        }
        // Resolve each (line, column) anchor to an absolute offset here, where
        // line_starts already exists. The column is clamped INTO its line so a
        // stale or over-long column (the buffer moved under the caller) can
        // never point into a different line's spans.
        let selections = annotations
            .selections
            .iter()
            .map(|&(line, column)| {
                let idx = line.saturating_sub(1) as usize;
                let start = line_starts.get(idx).copied().unwrap_or(0);
                let end = line_starts
                    .get(idx + 1)
                    .copied()
                    .unwrap_or(source.len() as u32);
                Selection {
                    offset: start.saturating_add(column).min(end),
                    line,
                    claimed: false,
                }
            })
            .collect();
        Self {
            ast: AstBuilder::new(allocator),
            line_starts,
            sites: Vec::new(),
            perf_lines: annotations.perf_lines,
            comment_lines: annotations.comment_lines,
            logpoint_lines: annotations.logpoint_lines,
            selections,
        }
    }

    fn pos(&self, offset: u32) -> (u32, u32) {
        let line_idx = match self.line_starts.binary_search(&offset) {
            Ok(i) => i,
            Err(i) => i - 1,
        };
        (line_idx as u32 + 1, offset - self.line_starts[line_idx])
    }

    fn new_site(&mut self, span: Span, kind: &'static str) -> u32 {
        let id = self.sites.len() as u32;
        let (line, column) = self.pos(span.start);
        let (end_line, end_column) = self.pos(span.end);
        self.sites.push(SiteRec {
            id,
            line,
            column,
            end_line,
            end_column,
            kind,
        });
        id
    }

    /// Detach `expr`, leaving a placeholder that is always overwritten.
    fn take_expression(&self, expr: &mut Expression<'a>) -> Expression<'a> {
        let placeholder = Expression::new_null_literal(expr.span(), &self.ast);
        std::mem::replace(expr, placeholder)
    }

    /// `__quoll.<method>(<id>[, <arg>])`, every node spanned to `span`.
    fn quoll_call(
        &self,
        method: &'static str,
        id: u32,
        arg: Option<Expression<'a>>,
        span: Span,
    ) -> Expression<'a> {
        let object = Expression::new_identifier(span, "__quoll", &self.ast);
        let property = IdentifierName::new(span, method, &self.ast);
        let callee =
            Expression::new_static_member_expression(span, object, property, false, &self.ast);
        let mut args = ArenaVec::with_capacity_in(2, &self.ast);
        args.push(Argument::from(Expression::new_numeric_literal(
            span,
            f64::from(id),
            None,
            NumberBase::Decimal,
            &self.ast,
        )));
        if let Some(a) = arg {
            args.push(Argument::from(a));
        }
        Expression::new_call_expression(span, callee, None, args, false, &self.ast)
    }

    /// Does `span` sit on a line in `lines`? A trailing annotation follows the
    /// expression's LAST line, but allow either boundary so a single-line
    /// expression matches regardless.
    fn line_matches(&self, span: Span, lines: &HashSet<u32>) -> bool {
        let (start_line, _) = self.pos(span.start);
        let (end_line, _) = self.pos(span.end);
        lines.contains(&start_line) || lines.contains(&end_line)
    }

    fn is_perf(&self, span: Span) -> bool {
        self.line_matches(span, &self.perf_lines)
    }

    /// Claim the first unclaimed selection anchor falling inside `span`. The
    /// walk visits children before parents, so the innermost capture containing
    /// the anchor claims it and enclosing captures find it already taken —
    /// selecting `x * 2` in `xs.map(x => x * 2)` reveals the arrow body, not
    /// the whole `map` call.
    fn claim_selection(&mut self, span: Span) -> bool {
        for sel in &mut self.selections {
            if !sel.claimed && sel.offset >= span.start && sel.offset < span.end {
                sel.claimed = true;
                return true;
            }
        }
        false
    }

    /// Opt-in tag for a value capture, most specific first. All three non-`expr`
    /// kinds capture identically and render identically (the host's quiet-mode
    /// filter only asks "did the user opt in?"); the kind records PROVENANCE,
    /// which the event log keeps and phases 10-11 replay.
    fn value_kind(&mut self, span: Span) -> &'static str {
        if self.claim_selection(span) {
            "selection"
        } else if self.line_matches(span, &self.logpoint_lines) {
            "logpoint"
        } else if self.line_matches(span, &self.comment_lines) {
            "comment"
        } else {
            "expr"
        }
    }

    /// Selection anchors that no capture span contained — the user selected a
    /// variable NAME, a keyword, an indent — fall back to LINE granularity, so
    /// double-clicking `x` in `const x = compute()` still reveals the line
    /// instead of silently doing nothing. Only `expr` sites are re-tagged:
    /// `perf`, `branch` and `statement` encode mechanism rather than opt-in
    /// policy, and `comment` is opt-in already.
    pub fn resolve_unclaimed_selections(&mut self) {
        let lines: HashSet<u32> = self
            .selections
            .iter()
            .filter(|s| !s.claimed)
            .map(|s| s.line)
            .collect();
        if lines.is_empty() {
            return;
        }
        for site in &mut self.sites {
            if site.kind == "expr" && (lines.contains(&site.line) || lines.contains(&site.end_line))
            {
                site.kind = "selection";
            }
        }
    }

    /// expr → `__quoll.log(id, expr)`. An opt-in annotation (`//?`, a logpoint,
    /// a selection) only re-tags the site's kind — same capture; the host
    /// filters by kind for quiet mode. A `//?.` annotation instead emits a
    /// `perf` site that TIMES the expression, and must wrap it in a thunk,
    /// because a call argument evaluates eagerly and there'd be nothing left
    /// to time.
    fn wrap_value(&mut self, expr: &mut Expression<'a>) {
        let span = expr.span();
        // Perf is checked first and never claims a selection anchor: it changes
        // the capture MECHANISM, so a selection landing on a timed line must not
        // quietly turn that line back into a value read.
        if self.is_perf(span) {
            let id = self.new_site(span, "perf");
            let inner = self.take_expression(expr);
            let thunk = self.arrow_thunk(inner, span);
            *expr = self.quoll_call("perf", id, Some(thunk), span);
            return;
        }
        let kind = self.value_kind(span);
        let id = self.new_site(span, kind);
        let inner = self.take_expression(expr);
        *expr = self.quoll_call("log", id, Some(inner), span);
    }

    /// `() => inner` — defers `inner` so `__quoll.perf` can time its evaluation.
    fn arrow_thunk(&self, inner: Expression<'a>, span: Span) -> Expression<'a> {
        let params = FormalParameters::boxed(
            span,
            FormalParameterKind::ArrowFormalParameters,
            ArenaVec::new_in(&self.ast),
            None,
            &self.ast,
        );
        // Concise body: the expression IS the implicit return, so the thunk
        // hands `__quoll.perf` something that still evaluates to the value.
        let body = ArrowFunctionBody::from(inner);
        Expression::new_arrow_function_expression(span, false, None, params, None, body, &self.ast)
    }

    /// expr → `(__quoll.cover(id), expr)`
    fn wrap_branch(&mut self, expr: &mut Expression<'a>) {
        let span = expr.span();
        let id = self.new_site(span, "branch");
        let inner = self.take_expression(expr);
        let mut exprs = ArenaVec::with_capacity_in(2, &self.ast);
        exprs.push(self.quoll_call("cover", id, None, span));
        exprs.push(inner);
        *expr = Expression::new_sequence_expression(span, exprs, &self.ast);
    }

    fn cover_statement(&mut self, span: Span) -> Statement<'a> {
        let id = self.new_site(span, "statement");
        let call = self.quoll_call("cover", id, None, span);
        Statement::new_expression_statement(span, call, &self.ast)
    }

    /// Normalize a braceless body (`if (c) foo();`, `while (c) bar();`) into
    /// a block so visit_statements gives it a statement site — coverage must
    /// not depend on the user's brace style. Semantically an identity.
    fn ensure_block(&mut self, stmt: &mut Statement<'a>) {
        if matches!(stmt, Statement::BlockStatement(_)) {
            return;
        }
        let span = stmt.span();
        let inner = std::mem::replace(stmt, Statement::new_empty_statement(span, &self.ast));
        let mut body = ArenaVec::with_capacity_in(1, &self.ast);
        body.push(inner);
        *stmt = Statement::new_block_statement(span, body, &self.ast);
    }
}

fn is_console_call(expr: &Expression) -> bool {
    let Expression::CallExpression(call) = expr else {
        return false;
    };
    let Some(member) = call.callee.as_member_expression() else {
        return false;
    };
    let MemberExpression::StaticMemberExpression(static_member) = member else {
        return false;
    };
    matches!(&static_member.object, Expression::Identifier(ident) if ident.name == "console")
}

impl<'a> VisitMut<'a> for Instrumenter<'a> {
    fn visit_statements(&mut self, stmts: &mut ArenaVec<'a, Statement<'a>>) {
        walk_mut::walk_statements(self, stmts); // children first

        let old = std::mem::replace(stmts, ArenaVec::new_in(&self.ast));
        let mut rebuilt = ArenaVec::with_capacity_in(old.len() * 2, &self.ast);
        for stmt in old {
            if !matches!(stmt, Statement::ImportDeclaration(_)) {
                rebuilt.push(self.cover_statement(stmt.span()));
            }
            rebuilt.push(stmt);
        }
        *stmts = rebuilt;
    }

    fn visit_variable_declarator(&mut self, declarator: &mut VariableDeclarator<'a>) {
        walk_mut::walk_variable_declarator(self, declarator);
        if let Some(init) = &mut declarator.init {
            // Function/class inits would just preview the function object —
            // noise. Their bodies are still instrumented by the walk above.
            let skip = is_console_call(init)
                || matches!(
                    init,
                    Expression::ArrowFunctionExpression(_)
                        | Expression::FunctionExpression(_)
                        | Expression::ClassExpression(_)
                );
            if !skip {
                self.wrap_value(init);
            }
        }
    }

    fn visit_if_statement(&mut self, if_stmt: &mut IfStatement<'a>) {
        self.ensure_block(&mut if_stmt.consequent);
        // `else if` stays as-is (block-wrapping it would renest the chain);
        // the nested IfStatement normalizes its own arms.
        if let Some(alternate) = &mut if_stmt.alternate
            && !matches!(alternate, Statement::IfStatement(_))
        {
            self.ensure_block(alternate);
        }
        walk_mut::walk_if_statement(self, if_stmt);
    }

    fn visit_for_statement(&mut self, for_stmt: &mut ForStatement<'a>) {
        self.ensure_block(&mut for_stmt.body);
        walk_mut::walk_for_statement(self, for_stmt);
    }

    fn visit_for_in_statement(&mut self, for_in: &mut ForInStatement<'a>) {
        self.ensure_block(&mut for_in.body);
        walk_mut::walk_for_in_statement(self, for_in);
    }

    fn visit_for_of_statement(&mut self, for_of: &mut ForOfStatement<'a>) {
        self.ensure_block(&mut for_of.body);
        walk_mut::walk_for_of_statement(self, for_of);
    }

    fn visit_while_statement(&mut self, while_stmt: &mut WhileStatement<'a>) {
        self.ensure_block(&mut while_stmt.body);
        walk_mut::walk_while_statement(self, while_stmt);
    }

    fn visit_do_while_statement(&mut self, do_while: &mut DoWhileStatement<'a>) {
        self.ensure_block(&mut do_while.body);
        walk_mut::walk_do_while_statement(self, do_while);
    }

    fn visit_return_statement(&mut self, ret: &mut ReturnStatement<'a>) {
        walk_mut::walk_return_statement(self, ret);
        if let Some(arg) = &mut ret.argument {
            self.wrap_value(arg);
        }
    }

    fn visit_expression_statement(&mut self, stmt: &mut ExpressionStatement<'a>) {
        walk_mut::walk_expression_statement(self, stmt);
        if !is_console_call(&stmt.expression) {
            self.wrap_value(&mut stmt.expression);
        }
    }

    fn visit_arrow_function_expression(&mut self, arrow: &mut ArrowFunctionExpression<'a>) {
        if !arrow.body.is_expression() {
            walk_mut::walk_arrow_function_expression(self, arrow);
            return;
        }
        // Expression-bodied arrow: the body expression IS the implicit return.
        // Inserting a cover statement would force a block body and silently
        // destroy the return value — so no statement site here, only the value
        // wrap (which returns the value).
        self.visit_formal_parameters(&mut arrow.params);
        if let Some(body) = arrow.body.as_expression_mut() {
            self.visit_expression(body);
            if !is_console_call(body) {
                self.wrap_value(body);
            }
        }
    }

    fn visit_conditional_expression(&mut self, cond: &mut ConditionalExpression<'a>) {
        walk_mut::walk_conditional_expression(self, cond);
        self.wrap_branch(&mut cond.consequent);
        self.wrap_branch(&mut cond.alternate);
    }

    fn visit_logical_expression(&mut self, logical: &mut LogicalExpression<'a>) {
        walk_mut::walk_logical_expression(self, logical);
        self.wrap_branch(&mut logical.right);
    }
}
