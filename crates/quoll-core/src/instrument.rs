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
//! - function sites (phase 11): every function body becomes
//!   `const __quoll_f = __quoll.enter(id); try { body }
//!    catch (__quoll_e) { __quoll.unwind(__quoll_f, __quoll_e); throw __quoll_e; }
//!    finally { __quoll.leave(__quoll_f); }`
//!   (the body's own function declarations hoisted above it) so the runner
//!   can keep a shadow call stack.
//! - suspensions (phase 11): a suspended frame is OFF the stack until it
//!   resumes, or the code that runs meanwhile would be reported as running
//!   inside it. So every point where an async function or generator can
//!   suspend is marked, the implicit ones included:
//!   - `await x` / `yield x` → `__quoll.resume(f, await __quoll.suspend(f, x))`;
//!   - an async generator's `return x` (which awaits `x`) → `return __quoll.suspend(f, x)`;
//!   - `for await` suspends on its iterable and at the end of every
//!     iteration, and resumes at the top of the body and in a `finally`
//!     around the whole loop (so a labelled jump out of it resumes too);
//!   - `await using` disposal is bracketed by two synchronous `using`
//!     resources, which disposal order runs just before and just after it;
//!   - paths that re-enter without passing through any of those — a rejected
//!     `await` landing in a `catch`/`finally` — get an idempotent
//!     `__quoll.reenter(f)`.
//!
//!   The module body gets the same treatment for top-level `await` (as
//!   `topSuspend`/`topResume`, since it has no frame) plus a `topSuspend` at
//!   its end: while it's suspended or finished, nothing that runs was called
//!   by it. Every rewrite passes the operand through untouched, so none adds
//!   a microtask tick.
//!
//! Value sites carry an opt-in KIND (`expr` by default; `comment`/`perf` from
//! `//?`/`//?.`; `selection`/`logpoint` from caller-supplied `extra_sites`).
//! The kind changes only the host's quiet-mode filter, never the capture —
//! except `perf`, which times the expression instead of reading it.
//!
//! CRITICAL: every synthesized node carries the span of the user node it
//! wraps/precedes. Empty (0,0) spans would emit source-map segments pointing
//! at line 1 and corrupt line attribution for anything sharing the line.

use std::collections::{HashMap, HashSet};

use oxc_allocator::{Allocator, GetAllocator, Vec as ArenaVec};
use oxc_ast::ast::*;
use oxc_ast::builder::AstBuilder;
use oxc_ast_visit::VisitMut;
use oxc_ast_visit::walk_mut;
use oxc_span::{GetSpan, Span};
use oxc_syntax::scope::ScopeFlags;

/// The per-call frame token the runner hands back from `enter`. One `const`
/// per function body, so nested functions shadow it and an `await` always
/// names the frame of the function it suspends — lexical scope does the work.
const FRAME: &str = "__quoll_f";
/// The catch parameter of the synthesized function-level `try`.
const THROWN: &str = "__quoll_e";
/// A function neither declared with a name nor put somewhere that names it.
const ANONYMOUS: &str = "(anonymous)";

/// What an enclosing function is, for the suspension rewrites.
#[derive(Clone, Copy)]
struct FnKind {
    /// Async or a generator: an `await`/`yield` can suspend it.
    suspends: bool,
    /// An async generator, whose `return x` awaits `x` implicitly.
    async_generator: bool,
}

/// What a suspension point in the current position takes off the stack.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Suspender {
    /// The enclosing async function or generator's frame.
    Frame,
    /// The module body itself (top-level `await`): not a frame, but while it
    /// is suspended nothing it calls can be "called from the top level".
    Module,
    /// A synchronous function: nothing here can suspend.
    Never,
}

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
/// `settled` does the same one level up, for an anchor no capture contained:
/// the innermost STATEMENT around it has had its say (see `settle_selections`),
/// so enclosing statements must not reach for it.
struct Selection {
    offset: u32,
    line: u32,
    claimed: bool,
    settled: bool,
}

pub struct SiteRec {
    pub id: u32,
    pub line: u32,
    pub column: u32,
    pub end_line: u32,
    pub end_column: u32,
    pub kind: &'static str,
    /// `function` sites only: the name a stack frame shows.
    pub name: Option<String>,
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
    /// Names for anonymous functions and classes, inferred from where they
    /// were put (`const f = () => …`, `{ f() {} }`), keyed by the function or
    /// class node's span START. Recorded by the PARENT's visitor and looked up
    /// by the node's own, so there is no "pending name" state that an
    /// unrelated function visited in between could steal.
    names: HashMap<u32, String>,
    /// Names of the enclosing classes, innermost last (`C.method`).
    classes: Vec<Option<String>>,
    /// One entry per enclosing function, innermost last. Empty = the module
    /// body, whose top-level `await`s suspend the MODULE rather than a frame.
    frames: Vec<FnKind>,
    /// `await using` brackets emitted so far — numbers their resource names.
    disposers: u32,
    /// (id, span) of the sites created directly under each enclosing
    /// statement (not under a nested one), innermost last. Lets an anchor that
    /// no capture contained fall back to its own statement's values.
    owned: Vec<Vec<(u32, Span)>>,
    /// Spans of every function, arrow and class visited so far: the
    /// boundaries the statement fallback does not reach across.
    scopes: Vec<Span>,
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
                    settled: false,
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
            names: HashMap::new(),
            classes: Vec::new(),
            frames: Vec::new(),
            disposers: 0,
            owned: Vec::new(),
            scopes: Vec::new(),
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
            name: None,
        });
        if let Some(owned) = self.owned.last_mut() {
            owned.push((id, span));
        }
        id
    }

    fn new_function_site(&mut self, span: Span, name: String) -> u32 {
        let id = self.new_site(span, "function");
        self.sites[id as usize].name = Some(name);
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
        let id = Expression::new_numeric_literal(
            span,
            f64::from(id),
            None,
            NumberBase::Decimal,
            &self.ast,
        );
        self.runtime_call(method, id, arg, span)
    }

    /// `__quoll.<method>(__quoll_f[, <arg>])` — the frame-token calls.
    fn frame_call(
        &self,
        method: &'static str,
        arg: Option<Expression<'a>>,
        span: Span,
    ) -> Expression<'a> {
        let frame = Expression::new_identifier(span, FRAME, &self.ast);
        self.runtime_call(method, frame, arg, span)
    }

    fn runtime_call(
        &self,
        method: &'static str,
        first: Expression<'a>,
        arg: Option<Expression<'a>>,
        span: Span,
    ) -> Expression<'a> {
        let object = Expression::new_identifier(span, "__quoll", &self.ast);
        let property = IdentifierName::new(span, method, &self.ast);
        let callee =
            Expression::new_static_member_expression(span, object, property, false, &self.ast);
        let mut args = ArenaVec::with_capacity_in(2, &self.ast);
        args.push(Argument::from(first));
        if let Some(a) = arg {
            args.push(Argument::from(a));
        }
        Expression::new_call_expression(span, callee, None, args, false, &self.ast)
    }

    fn frame_statement(&self, method: &'static str, span: Span) -> Statement<'a> {
        Statement::new_expression_statement(span, self.frame_call(method, None, span), &self.ast)
    }

    /// `__quoll.<method>([<arg>])` — the module-body calls, which name no frame.
    fn module_call(
        &self,
        method: &'static str,
        arg: Option<Expression<'a>>,
        span: Span,
    ) -> Expression<'a> {
        let object = Expression::new_identifier(span, "__quoll", &self.ast);
        let property = IdentifierName::new(span, method, &self.ast);
        let callee =
            Expression::new_static_member_expression(span, object, property, false, &self.ast);
        let mut args = ArenaVec::with_capacity_in(1, &self.ast);
        if let Some(a) = arg {
            args.push(Argument::from(a));
        }
        Expression::new_call_expression(span, callee, None, args, false, &self.ast)
    }

    /// Inside an async function or generator — where an `await`/`yield` can
    /// take the current frame off the stack?
    fn can_suspend(&self) -> bool {
        self.suspender() == Suspender::Frame
    }

    fn suspender(&self) -> Suspender {
        match self.frames.last() {
            None => Suspender::Module,
            Some(kind) if kind.suspends => Suspender::Frame,
            Some(_) => Suspender::Never,
        }
    }

    /// Take the current frame (or the module body) off the stack, passing
    /// `arg` through: `__quoll.suspend(__quoll_f, arg)` / `__quoll.topSuspend(arg)`.
    fn suspend_call(
        &self,
        by: Suspender,
        arg: Option<Expression<'a>>,
        span: Span,
    ) -> Expression<'a> {
        match by {
            Suspender::Module => self.module_call("topSuspend", arg, span),
            _ => self.frame_call("suspend", arg, span),
        }
    }

    /// Put it back, passing `arg` through. Idempotent, so it doubles as the
    /// re-entry for paths that resume without passing through an `await`.
    fn resume_call(
        &self,
        by: Suspender,
        arg: Option<Expression<'a>>,
        span: Span,
    ) -> Expression<'a> {
        match by {
            Suspender::Module => self.module_call("topResume", arg, span),
            _ => self.frame_call("resume", arg, span),
        }
    }

    fn call_statement(&self, call: Expression<'a>, span: Span) -> Statement<'a> {
        Statement::new_expression_statement(span, call, &self.ast)
    }

    /// `try { <stmt> } finally { <on_exit> }` — runs `on_exit` however the
    /// statement is left, labelled `break`/`continue` to an outer target
    /// included.
    fn try_finally(
        &self,
        body: ArenaVec<'a, Statement<'a>>,
        on_exit: Statement<'a>,
        span: Span,
    ) -> Statement<'a> {
        let mut finalizer = ArenaVec::with_capacity_in(1, &self.ast);
        finalizer.push(on_exit);
        Statement::new_try_statement(
            span,
            BlockStatement::boxed(span, body, &self.ast),
            None,
            Some(BlockStatement::boxed(span, finalizer, &self.ast)),
            &self.ast,
        )
    }

    /// `await using` disposal awaits at the end of its block, which nothing in
    /// the source marks. Resources are disposed in REVERSE declaration order,
    /// so two synchronous `using` resources bracket it exactly, with no change
    /// to scoping and no extra tick:
    ///
    /// ```js
    /// using __quoll_rN = __quoll.resuming(__quoll_f);   // disposed LAST
    /// await using a = …;  …  await using b = …;
    /// using __quoll_sN = __quoll.suspending(__quoll_f); // disposed FIRST
    /// ```
    ///
    /// The first suspends the frame as disposal starts; the last runs, in the
    /// continuation, once every async disposal has been awaited, and resumes
    /// it. A synchronous resource adds no `Await` of its own when disposed
    /// (DisposeResources awaits only for async-dispose resources, and a
    /// `null` one), so the program's microtask order is unchanged. If the
    /// block is left before the last `await using` is declared, the
    /// suspending resource was never registered and the resuming one is a
    /// harmless re-entry. Names are numbered: a `switch`'s cases share a scope.
    fn bracket_await_using(
        &mut self,
        by: Suspender,
        stmts: ArenaVec<'a, Statement<'a>>,
    ) -> ArenaVec<'a, Statement<'a>> {
        let (Some(first), Some(last)) = (
            stmts.iter().position(is_await_using),
            stmts.iter().rposition(is_await_using),
        ) else {
            return stmts;
        };
        self.disposers += 1;
        let n = self.disposers;
        let mut out = ArenaVec::with_capacity_in(stmts.len() + 2, &self.ast);
        for (i, stmt) in stmts.into_iter().enumerate() {
            let span = stmt.span();
            if i == first {
                out.push(self.disposer(by, "resuming", format!("__quoll_r{n}"), span));
            }
            out.push(stmt);
            if i == last {
                out.push(self.disposer(by, "suspending", format!("__quoll_s{n}"), span));
            }
        }
        out
    }

    /// `using <name> = __quoll.<method>(__quoll_f)` (the `top…` method, with
    /// no frame, in the module body).
    fn disposer(
        &self,
        by: Suspender,
        method: &'static str,
        name: String,
        span: Span,
    ) -> Statement<'a> {
        let init = match (by, method) {
            (Suspender::Module, "resuming") => self.module_call("topResuming", None, span),
            (Suspender::Module, _) => self.module_call("topSuspending", None, span),
            _ => self.frame_call(method, None, span),
        };
        let name = self.ast.allocator().alloc_str(&name);
        let declarator = VariableDeclarator::new(
            span,
            BindingPattern::new_binding_identifier(span, name, &self.ast),
            None,
            Some(init),
            false,
            &self.ast,
        );
        let mut declarators = ArenaVec::with_capacity_in(1, &self.ast);
        declarators.push(declarator);
        Statement::new_variable_declaration(
            span,
            VariableDeclarationKind::Using,
            declarators,
            false,
            &self.ast,
        )
    }

    /// Record the name a function or class takes from where it was put, if
    /// `expr` IS one (parentheses aside). Anything else — `wrap(() => 1)` —
    /// records nothing: the name belongs to the call's result, not to the
    /// function passed into it.
    fn name_expression(&mut self, expr: &Expression<'a>, name: &str) {
        let start = match expr.without_parentheses() {
            Expression::FunctionExpression(f) => f.span.start,
            Expression::ArrowFunctionExpression(a) => a.span.start,
            Expression::ClassExpression(c) => c.span.start,
            _ => return,
        };
        self.names.entry(start).or_insert_with(|| name.to_string());
    }

    /// `Class.member` inside a named class, else just `member`.
    fn member_name(&self, key: &PropertyKey<'a>) -> Option<String> {
        let key = key.static_name()?;
        Some(match self.classes.last() {
            Some(Some(class)) => format!("{class}.{key}"),
            _ => key.into_owned(),
        })
    }

    /// Wrap a function body's statements in a frame:
    ///
    /// ```js
    /// const __quoll_f = __quoll.enter(id);
    /// try { ...body }
    /// catch (__quoll_e) { __quoll.unwind(__quoll_f, __quoll_e); throw __quoll_e; }
    /// finally { __quoll.leave(__quoll_f); }
    /// ```
    ///
    /// The `finally` is what makes `leave` exact: every way out of a body —
    /// return, throw, a generator's `.return()` — passes through it. The
    /// `catch` rethrows the SAME value, so it is invisible to the program; it
    /// exists so the runner can snapshot the stack at the throw, before the
    /// `finally`s below it unwind the frames away.
    ///
    /// The body's own function declarations stay OUTSIDE the `try`, above the
    /// `const`: inside a block they would become block-scoped, which is not
    /// the same thing — `var g; function g() {}` in one body is legal, and
    /// would be a redeclaration error in a block. Hoisting makes their
    /// position irrelevant, so moving them up changes nothing else. (Their
    /// coverage counters stay where they were.)
    fn framed(
        &self,
        id: u32,
        span: Span,
        body: ArenaVec<'a, Statement<'a>>,
    ) -> ArenaVec<'a, Statement<'a>> {
        let mut functions = ArenaVec::new_in(&self.ast);
        let mut statements = ArenaVec::with_capacity_in(body.len(), &self.ast);
        for stmt in body {
            if matches!(stmt, Statement::FunctionDeclaration(_)) {
                functions.push(stmt);
            } else {
                statements.push(stmt);
            }
        }
        let body = statements;
        let enter = self.quoll_call("enter", id, None, span);
        let declarator = VariableDeclarator::new(
            span,
            BindingPattern::new_binding_identifier(span, FRAME, &self.ast),
            None,
            Some(enter),
            false,
            &self.ast,
        );
        let mut declarators = ArenaVec::with_capacity_in(1, &self.ast);
        declarators.push(declarator);
        let declaration = Statement::new_variable_declaration(
            span,
            VariableDeclarationKind::Const,
            declarators,
            false,
            &self.ast,
        );

        let thrown = || Expression::new_identifier(span, THROWN, &self.ast);
        let mut on_throw = ArenaVec::with_capacity_in(2, &self.ast);
        on_throw.push(Statement::new_expression_statement(
            span,
            self.frame_call("unwind", Some(thrown()), span),
            &self.ast,
        ));
        on_throw.push(Statement::new_throw_statement(span, thrown(), &self.ast));
        let param = CatchParameter::new(
            span,
            BindingPattern::new_binding_identifier(span, THROWN, &self.ast),
            None,
            &self.ast,
        );
        let handler = CatchClause::boxed(
            span,
            Some(param),
            BlockStatement::boxed(span, on_throw, &self.ast),
            &self.ast,
        );
        let mut on_exit = ArenaVec::with_capacity_in(1, &self.ast);
        on_exit.push(self.frame_statement("leave", span));
        let attempt = Statement::new_try_statement(
            span,
            BlockStatement::boxed(span, body, &self.ast),
            Some(handler),
            Some(BlockStatement::boxed(span, on_exit, &self.ast)),
            &self.ast,
        );

        let mut out = ArenaVec::with_capacity_in(functions.len() + 2, &self.ast);
        out.extend(functions);
        out.push(declaration);
        out.push(attempt);
        out
    }

    /// `await arg` → `__quoll.resume(__quoll_f, await __quoll.suspend(__quoll_f, arg))`,
    /// and the same for `yield`/`yield*`. `arg` is evaluated INSIDE the frame
    /// (it is the call's first argument), then the frame leaves the stack for
    /// as long as the function is suspended, and `resume` puts it back — on top
    /// of whatever stack the resumption happens on (empty for a microtask, the
    /// caller's for a generator's `.next()`). The awaited value passes through
    /// both calls untouched, so the program sees no extra tick and no wrapper.
    /// A rejected `await` never reaches `resume`; see `reenter_at`.
    ///
    /// A top-level `await` gets the same pair with `topSuspend`/`topResume`:
    /// no frame, but while the module body is suspended, nothing that runs
    /// was called by it.
    fn wrap_suspension(&mut self, by: Suspender, expr: &mut Expression<'a>) {
        let span = expr.span();
        let mut suspended = self.take_expression(expr);
        match &mut suspended {
            Expression::AwaitExpression(await_expr) => {
                let arg = self.take_expression(&mut await_expr.argument);
                await_expr.argument = self.suspend_call(by, Some(arg), span);
            }
            Expression::YieldExpression(yield_expr) => {
                let arg = yield_expr.argument.take();
                yield_expr.argument = Some(self.suspend_call(by, arg, span));
            }
            _ => unreachable!("wrap_suspension is only called on await/yield"),
        }
        *expr = self.resume_call(by, Some(suspended), span);
    }

    /// Prepend an idempotent `__quoll.reenter(__quoll_f)` to a block that can
    /// run in a suspended frame without passing through `resume`.
    fn reenter_at(&self, block: &mut BlockStatement<'a>) {
        let span = block.span;
        block.body.insert(0, self.frame_statement("reenter", span));
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

    /// A statement has been fully walked, so every capture inside it has
    /// already had its chance to claim an anchor. Any anchor inside `span` that
    /// is still unclaimed sat outside every capture — on a NAME, a keyword, a
    /// destructuring pattern — and it falls back to the values of the
    /// innermost statement around it: double-clicking `x` in
    /// `const x = compute()` reveals `compute()`, and so does `b` on the middle
    /// line of `const {\n a,\n b\n} = obj`, which no line-based rule can reach.
    /// Because the innermost statement answers first, an anchor inside a
    /// callback's statement is answered there, before the capture that wraps
    /// the whole call gets to claim it.
    ///
    /// Only the statement's OWN values count, and never across a function,
    /// arrow or class boundary inside it: not a nested statement's sites (an
    /// anchor on the `if` keyword must not reveal its branch body), not a
    /// concise arrow body's (one stray selection in
    /// `export default [() => a, () => b]` must not reveal every callback),
    /// and not at all when the anchor itself is inside such a boundary (a
    /// method name in `const C = class { … }` is about the method, not the
    /// `const`). An anchor that tags nothing here is settled all the same and
    /// left to the line fallback.
    fn settle_selections(&mut self, span: Span, owned: &[(u32, Span)]) {
        for i in 0..self.selections.len() {
            let sel = &self.selections[i];
            if sel.claimed || sel.settled || sel.offset < span.start || sel.offset >= span.end {
                continue;
            }
            let offset = sel.offset;
            self.selections[i].settled = true;
            // The boundaries nested in this statement; one around the anchor
            // means the anchor belongs to that function, not to this statement.
            let inner: Vec<Span> = self
                .scopes
                .iter()
                .filter(|s| s.start >= span.start && s.end <= span.end)
                .copied()
                .collect();
            let within = |s: &Span, o: u32| o >= s.start && o < s.end;
            if inner.iter().any(|s| within(s, offset)) {
                continue;
            }
            for &(id, site_span) in owned {
                // Strictly inside: the capture OF an arrow shares its span and
                // is this statement's own value.
                if inner.iter().any(|s| {
                    within(s, site_span.start) && site_span.end <= s.end && site_span != *s
                }) {
                    continue;
                }
                let site = &mut self.sites[id as usize];
                if site.kind == "expr" || site.kind == "selection" {
                    site.kind = "selection";
                    self.selections[i].claimed = true;
                }
            }
        }
    }

    /// The last resort for anchors that neither a capture nor a statement
    /// claimed — whitespace after a `;`, a method name inside a class — is LINE
    /// granularity, so the gesture still reveals something on its line instead
    /// of silently doing nothing. It matches a site's START or END line.
    /// Only `expr` sites are re-tagged, here and in `settle_selections`:
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

/// An `await using` declaration.
fn is_await_using(stmt: &Statement) -> bool {
    matches!(stmt, Statement::VariableDeclaration(decl)
        if decl.kind == VariableDeclarationKind::AwaitUsing)
}

/// A `for await` loop, labelled or not.
fn is_for_await(stmt: &Statement) -> bool {
    match stmt {
        Statement::ForOfStatement(for_of) => for_of.r#await,
        Statement::LabeledStatement(labeled) => is_for_await(&labeled.body),
        _ => false,
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
    fn visit_statement(&mut self, stmt: &mut Statement<'a>) {
        let span = stmt.span();
        self.owned.push(Vec::new());
        walk_mut::walk_statement(self, stmt);
        let owned = self.owned.pop().unwrap_or_default();
        // Popped, not merged into the parent's list: a nested statement's
        // sites are its own, or an anchor on `if` would reveal its branch body.
        self.settle_selections(span, &owned);
    }

    fn visit_statements(&mut self, stmts: &mut ArenaVec<'a, Statement<'a>>) {
        walk_mut::walk_statements(self, stmts); // children first

        let by = self.suspender();
        let old = std::mem::replace(stmts, ArenaVec::new_in(&self.ast));
        let mut rebuilt = ArenaVec::with_capacity_in(old.len() * 2, &self.ast);
        for stmt in old {
            if !matches!(stmt, Statement::ImportDeclaration(_)) {
                rebuilt.push(self.cover_statement(stmt.span()));
            }
            if by != Suspender::Never && is_for_await(&stmt) {
                // A `for await` suspends on its last `next()` too, and leaving
                // it passes through no `resume` — however it's left: normal
                // end, `break`, or a labelled jump to a target outside it. So
                // the whole loop goes in a `finally` that resumes. (Its body
                // is handled in visit_for_of_statement.)
                let span = stmt.span();
                let mut body = ArenaVec::with_capacity_in(1, &self.ast);
                body.push(stmt);
                let resume = self.call_statement(self.resume_call(by, None, span), span);
                rebuilt.push(self.try_finally(body, resume, span));
            } else {
                rebuilt.push(stmt);
            }
        }
        *stmts = if by == Suspender::Never {
            rebuilt
        } else {
            self.bracket_await_using(by, rebuilt)
        };
    }

    fn visit_program(&mut self, program: &mut Program<'a>) {
        walk_mut::walk_program(self, program);
        // The module body is done running: nothing that runs after this was
        // called by it. (The runner's microtask-deferred clear is the
        // fallback for a body that throws before getting here.)
        if let Some(span) = program.body.last().map(GetSpan::span) {
            let done = self.call_statement(self.module_call("topSuspend", None, span), span);
            program.body.push(done);
        }
    }

    fn visit_expression(&mut self, expr: &mut Expression<'a>) {
        walk_mut::walk_expression(self, expr);
        let by = self.suspender();
        if by != Suspender::Never
            && matches!(
                expr,
                Expression::AwaitExpression(_) | Expression::YieldExpression(_)
            )
        {
            self.wrap_suspension(by, expr);
        }
    }

    fn visit_function(&mut self, func: &mut Function<'a>, flags: ScopeFlags) {
        self.scopes.push(func.span);
        if func.body.is_none() {
            // An overload or `declare` — the transform strips these, but a
            // body-less function has no frame to keep either way.
            walk_mut::walk_function(self, func, flags);
            return;
        }
        let name = func
            .id
            .as_ref()
            .map(|id| id.name.to_string())
            .or_else(|| self.names.remove(&func.span.start))
            .unwrap_or_else(|| ANONYMOUS.to_string());
        self.frames.push(FnKind {
            suspends: func.r#async || func.generator,
            async_generator: func.r#async && func.generator,
        });
        walk_mut::walk_function(self, func, flags);
        self.frames.pop();
        let id = self.new_function_site(func.span, name);
        if let Some(body) = &mut func.body {
            let stmts = std::mem::replace(&mut body.statements, ArenaVec::new_in(&self.ast));
            body.statements = self.framed(id, body.span, stmts);
        }
    }

    fn visit_class(&mut self, class: &mut Class<'a>) {
        self.scopes.push(class.span);
        let name = class
            .id
            .as_ref()
            .map(|id| id.name.to_string())
            .or_else(|| self.names.remove(&class.span.start));
        self.classes.push(name);
        walk_mut::walk_class(self, class);
        self.classes.pop();
    }

    fn visit_method_definition(&mut self, method: &mut MethodDefinition<'a>) {
        let name = if method.kind == MethodDefinitionKind::Constructor {
            // What V8 prints for a constructor frame.
            match self.classes.last() {
                Some(Some(class)) => Some(format!("new {class}")),
                _ => None,
            }
        } else if method.computed {
            None
        } else {
            self.member_name(&method.key)
        };
        if let Some(name) = name {
            self.names.entry(method.value.span.start).or_insert(name);
        }
        walk_mut::walk_method_definition(self, method);
    }

    fn visit_property_definition(&mut self, prop: &mut PropertyDefinition<'a>) {
        if !prop.computed
            && let Some(name) = self.member_name(&prop.key)
            && let Some(value) = &prop.value
        {
            self.name_expression(value, &name);
        }
        walk_mut::walk_property_definition(self, prop);
    }

    fn visit_object_property(&mut self, prop: &mut ObjectProperty<'a>) {
        if !prop.computed
            && let Some(name) = prop.key.static_name()
        {
            let name = name.into_owned();
            self.name_expression(&prop.value, &name);
        }
        walk_mut::walk_object_property(self, prop);
    }

    fn visit_assignment_expression(&mut self, assign: &mut AssignmentExpression<'a>) {
        let name = match &assign.left {
            AssignmentTarget::AssignmentTargetIdentifier(ident) => Some(ident.name.to_string()),
            AssignmentTarget::StaticMemberExpression(member) => {
                Some(member.property.name.to_string())
            }
            _ => None,
        };
        if let Some(name) = name {
            self.name_expression(&assign.right, &name);
        }
        walk_mut::walk_assignment_expression(self, assign);
    }

    fn visit_catch_clause(&mut self, clause: &mut CatchClause<'a>) {
        walk_mut::walk_catch_clause(self, clause);
        // A rejected `await` throws here without passing through `resume`.
        if self.can_suspend() {
            self.reenter_at(&mut clause.body);
        }
    }

    fn visit_try_statement(&mut self, try_stmt: &mut TryStatement<'a>) {
        walk_mut::walk_try_statement(self, try_stmt);
        // …and so does the `finally` a rejected `await` (or a generator's
        // `.return()`) runs on the way out.
        if self.can_suspend()
            && let Some(finalizer) = &mut try_stmt.finalizer
        {
            self.reenter_at(finalizer);
        }
    }

    fn visit_variable_declarator(&mut self, declarator: &mut VariableDeclarator<'a>) {
        if let (BindingPattern::BindingIdentifier(ident), Some(init)) =
            (&declarator.id, &declarator.init)
        {
            let name = ident.name.to_string();
            self.name_expression(init, &name);
        }
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
        let by = self.suspender();
        if !for_of.r#await || by == Suspender::Never {
            return;
        }
        // A `for await` awaits `next()` before EVERY iteration, the first one
        // included, and nothing in the source marks those awaits. So the
        // frame (or the module body) suspends once the iterable is handed
        // over, and again at the end of each iteration (a `finally`, so
        // `continue` suspends too); it resumes at the top of the body, and
        // wherever the loop is left (see visit_statements).
        let right_span = for_of.right.span();
        let right = self.take_expression(&mut for_of.right);
        for_of.right = self.suspend_call(by, Some(right), right_span);
        if let Statement::BlockStatement(body) = &mut for_of.body {
            let span = body.span;
            let stmts = std::mem::replace(&mut body.body, ArenaVec::new_in(&self.ast));
            let suspend = self.call_statement(self.suspend_call(by, None, span), span);
            let iteration = self.try_finally(stmts, suspend, span);
            body.body
                .push(self.call_statement(self.resume_call(by, None, span), span));
            body.body.push(iteration);
        }
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
        let async_generator = self.frames.last().is_some_and(|k| k.async_generator);
        if let Some(arg) = &mut ret.argument {
            self.wrap_value(arg);
            // An async generator's `return x` awaits `x` before its `finally`s
            // run — a suspension nothing in the source marks. The frame leaves
            // once `x` is evaluated; the `finally`s re-enter it.
            if async_generator {
                let span = arg.span();
                let value = self.take_expression(arg);
                *arg = self.frame_call("suspend", Some(value), span);
            }
        }
    }

    fn visit_expression_statement(&mut self, stmt: &mut ExpressionStatement<'a>) {
        walk_mut::walk_expression_statement(self, stmt);
        if !is_console_call(&stmt.expression) {
            self.wrap_value(&mut stmt.expression);
        }
    }

    fn visit_arrow_function_expression(&mut self, arrow: &mut ArrowFunctionExpression<'a>) {
        self.scopes.push(arrow.span);
        let name = self
            .names
            .remove(&arrow.span.start)
            .unwrap_or_else(|| ANONYMOUS.to_string());
        self.frames.push(FnKind {
            suspends: arrow.r#async,
            async_generator: false,
        });
        if arrow.body.is_expression() {
            // Expression-bodied arrow: the body expression IS the implicit
            // return. No statement site here (a cover statement would have
            // nowhere to go), only the value wrap, which returns the value.
            self.visit_formal_parameters(&mut arrow.params);
            if let Some(body) = arrow.body.as_expression_mut() {
                self.visit_expression(body);
                if !is_console_call(body) {
                    self.wrap_value(body);
                }
            }
        } else {
            walk_mut::walk_arrow_function_expression(self, arrow);
        }
        self.frames.pop();

        let id = self.new_function_site(arrow.span, name);
        // The frame needs statements around the body, so an expression body
        // becomes `{ return <expr>; }` first — the same value, returned
        // explicitly.
        let body_span = arrow.body.span();
        let stmts = match &mut arrow.body {
            ArrowFunctionBody::FunctionBody(body) => {
                std::mem::replace(&mut body.statements, ArenaVec::new_in(&self.ast))
            }
            other => {
                let expr = other
                    .as_expression_mut()
                    .map(|e| self.take_expression(e))
                    .expect("a non-block arrow body is an expression");
                let mut stmts = ArenaVec::with_capacity_in(1, &self.ast);
                stmts.push(Statement::new_return_statement(
                    body_span,
                    Some(expr),
                    &self.ast,
                ));
                stmts
            }
        };
        let framed = self.framed(id, body_span, stmts);
        match &mut arrow.body {
            ArrowFunctionBody::FunctionBody(body) => body.statements = framed,
            other => {
                *other = ArrowFunctionBody::FunctionBody(FunctionBody::boxed(
                    body_span,
                    ArenaVec::new_in(&self.ast),
                    framed,
                    &self.ast,
                ));
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
