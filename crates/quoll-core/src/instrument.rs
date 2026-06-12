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
//! CRITICAL: every synthesized node carries the span of the user node it
//! wraps/precedes. Empty (0,0) spans would emit source-map segments pointing
//! at line 1 and corrupt line attribution for anything sharing the line.

use oxc_allocator::{Allocator, Vec as ArenaVec};
use oxc_ast::ast::*;
use oxc_ast::{AstBuilder, NONE};
use oxc_ast_visit::walk_mut;
use oxc_ast_visit::VisitMut;
use oxc_span::{GetSpan, Span};

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
}

impl<'a> Instrumenter<'a> {
    pub fn new(allocator: &'a Allocator, source: &str) -> Self {
        let mut line_starts = vec![0u32];
        for (i, b) in source.bytes().enumerate() {
            if b == b'\n' {
                line_starts.push(i as u32 + 1);
            }
        }
        Self { ast: AstBuilder::new(allocator), line_starts, sites: Vec::new() }
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
        self.sites.push(SiteRec { id, line, column, end_line, end_column, kind });
        id
    }

    /// Detach `expr`, leaving a placeholder that is always overwritten.
    fn take_expression(&self, expr: &mut Expression<'a>) -> Expression<'a> {
        std::mem::replace(expr, self.ast.expression_null_literal(expr.span()))
    }

    /// `__quoll.<method>(<id>[, <arg>])`, every node spanned to `span`.
    fn quoll_call(&self, method: &'static str, id: u32, arg: Option<Expression<'a>>, span: Span) -> Expression<'a> {
        let object = self.ast.expression_identifier(span, "__quoll");
        let property = self.ast.identifier_name(span, method);
        let callee = Expression::from(self.ast.member_expression_static(span, object, property, false));
        let mut args = self.ast.vec_with_capacity(2);
        args.push(Argument::from(self.ast.expression_numeric_literal(
            span,
            f64::from(id),
            None,
            NumberBase::Decimal,
        )));
        if let Some(a) = arg {
            args.push(Argument::from(a));
        }
        self.ast.expression_call(span, callee, NONE, args, false)
    }

    /// expr → `__quoll.log(id, expr)`
    fn wrap_value(&mut self, expr: &mut Expression<'a>) {
        let span = expr.span();
        let id = self.new_site(span, "expr");
        let inner = self.take_expression(expr);
        *expr = self.quoll_call("log", id, Some(inner), span);
    }

    /// expr → `(__quoll.cover(id), expr)`
    fn wrap_branch(&mut self, expr: &mut Expression<'a>) {
        let span = expr.span();
        let id = self.new_site(span, "branch");
        let inner = self.take_expression(expr);
        let mut exprs = self.ast.vec_with_capacity(2);
        exprs.push(self.quoll_call("cover", id, None, span));
        exprs.push(inner);
        *expr = self.ast.expression_sequence(span, exprs);
    }

    fn cover_statement(&mut self, span: Span) -> Statement<'a> {
        let id = self.new_site(span, "statement");
        self.ast.statement_expression(span, self.quoll_call("cover", id, None, span))
    }

    /// Normalize a braceless body (`if (c) foo();`, `while (c) bar();`) into
    /// a block so visit_statements gives it a statement site — coverage must
    /// not depend on the user's brace style. Semantically an identity.
    fn ensure_block(&mut self, stmt: &mut Statement<'a>) {
        if matches!(stmt, Statement::BlockStatement(_)) {
            return;
        }
        let span = stmt.span();
        let inner = std::mem::replace(stmt, self.ast.statement_empty(span));
        let mut body = self.ast.vec_with_capacity(1);
        body.push(inner);
        *stmt = self.ast.statement_block(span, body);
    }
}

fn is_console_call(expr: &Expression) -> bool {
    let Expression::CallExpression(call) = expr else { return false };
    let Some(member) = call.callee.as_member_expression() else { return false };
    let MemberExpression::StaticMemberExpression(static_member) = member else { return false };
    matches!(&static_member.object, Expression::Identifier(ident) if ident.name == "console")
}

impl<'a> VisitMut<'a> for Instrumenter<'a> {
    fn visit_statements(&mut self, stmts: &mut ArenaVec<'a, Statement<'a>>) {
        walk_mut::walk_statements(self, stmts); // children first

        let old = std::mem::replace(stmts, self.ast.vec());
        let mut rebuilt = self.ast.vec_with_capacity(old.len() * 2);
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
        if let Some(alternate) = &mut if_stmt.alternate {
            if !matches!(alternate, Statement::IfStatement(_)) {
                self.ensure_block(alternate);
            }
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
        if !arrow.expression {
            walk_mut::walk_arrow_function_expression(self, arrow);
            return;
        }
        // Expression-bodied arrow: the body is one ExpressionStatement whose
        // value is the implicit return. Inserting a cover statement would
        // force a block body and silently destroy the return value — so no
        // statement site here, only the value wrap (which returns the value).
        self.visit_formal_parameters(&mut arrow.params);
        if let Some(Statement::ExpressionStatement(stmt)) = arrow.body.statements.first_mut() {
            self.visit_expression(&mut stmt.expression);
            if !is_console_call(&stmt.expression) {
                self.wrap_value(&mut stmt.expression);
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
