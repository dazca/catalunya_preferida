/**
 * @file formulaParser — recursive-descent AST parser for scoring formulas.
 *
 * Grammar (precedence low → high):
 *   expr       ::= comparison
 *   comparison ::= add (('==' | '!=' | '<=' | '>=' | '<' | '>') add)*
 *   add        ::= mul (('+' | '-') mul)*
 *   mul        ::= unary (('*' | '/') unary)*
 *   unary      ::= ('-' | '+') unary | primary
 *   primary    ::= NUMBER | IDENT | call | '(' expr ')'
 *   call       ::= IDENT '(' arglist ')'
 *   arglist    ::= expr (',' expr)*
 *
 * Brackets `[` `]` are normalised to `(` `)` before parsing.
 * Function names are uppercased during parse.
 */

/* ── AST node types ─────────────────────────────────────────────────── */

export type NumberNode = { kind: 'number'; value: number };
export type IdentNode  = { kind: 'identifier'; name: string };
export type BinopNode  = { kind: 'binop'; op: string; left: AstNode; right: AstNode };
export type UnaryNode  = { kind: 'unary'; op: string; expr: AstNode };
export type CallNode   = { kind: 'call'; name: string; args: AstNode[] };

export type AstNode = NumberNode | IdentNode | BinopNode | UnaryNode | CallNode;

/* ── Tokeniser ──────────────────────────────────────────────────────── */

type TokenKind = 'NUMBER' | 'IDENT' | 'OP' | 'LPAREN' | 'RPAREN' | 'COMMA' | 'EOF';
interface Token { kind: TokenKind; text: string; pos: number }

function tokenise(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    // Whitespace
    if (/\s/.test(ch)) { i++; continue; }

    // Number: integer or float, optional scientific notation
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const start = i;
      i++;
      while (i < src.length && /[0-9.]/.test(src[i])) i++;
      // Scientific notation: 1e-10, 2.5E+3
      if ((src[i] === 'e' || src[i] === 'E') && i < src.length) {
        i++;
        if (i < src.length && (src[i] === '+' || src[i] === '-')) i++;
        while (i < src.length && /[0-9]/.test(src[i])) i++;
      }
      tokens.push({ kind: 'NUMBER', text: src.slice(start, i), pos: start });
      continue;
    }

    // Identifier
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      i++;
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) i++;
      tokens.push({ kind: 'IDENT', text: src.slice(start, i), pos: start });
      continue;
    }

    // Grouping
    if (ch === '(' || ch === '[') { tokens.push({ kind: 'LPAREN', text: '(', pos: i++ }); continue; }
    if (ch === ')' || ch === ']') { tokens.push({ kind: 'RPAREN', text: ')', pos: i++ }); continue; }
    if (ch === ',') { tokens.push({ kind: 'COMMA', text: ',', pos: i++ }); continue; }

    // Multi-char operators
    const two = src.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '==' || two === '!=') {
      tokens.push({ kind: 'OP', text: two, pos: i });
      i += 2;
      continue;
    }

    // Single-char operators
    if ('+-*/^<>'.includes(ch)) {
      tokens.push({ kind: 'OP', text: ch, pos: i++ });
      continue;
    }

    // Unknown character — skip silently (unit suffixes, etc.)
    i++;
  }
  tokens.push({ kind: 'EOF', text: '', pos: i });
  return tokens;
}

/* ── Parser ─────────────────────────────────────────────────────────── */

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(src: string) {
    this.tokens = tokenise(src);
  }

  private peek(): Token { return this.tokens[this.pos]; }
  private advance(): Token { return this.tokens[this.pos++]; }

  private check(kind: TokenKind, text?: string): boolean {
    const t = this.tokens[this.pos];
    return t.kind === kind && (text === undefined || t.text === text);
  }

  private eat(kind: TokenKind, text?: string): Token {
    if (!this.check(kind, text)) {
      const t = this.peek();
      throw new SyntaxError(
        `Expected ${text ?? kind} at pos ${t.pos}, got '${t.text || 'EOF'}'`,
      );
    }
    return this.advance();
  }

  parse(): AstNode {
    const node = this.parseComparison();
    if (!this.check('EOF')) {
      const t = this.peek();
      throw new SyntaxError(`Unexpected token '${t.text}' at pos ${t.pos}`);
    }
    return node;
  }

  private parseComparison(): AstNode {
    let left = this.parseAdd();
    while (
      this.check('OP') &&
      ['<', '>', '<=', '>=', '==', '!='].includes(this.peek().text)
    ) {
      const op = this.advance().text;
      const right = this.parseAdd();
      left = { kind: 'binop', op, left, right };
    }
    return left;
  }

  private parseAdd(): AstNode {
    let left = this.parseMul();
    while (this.check('OP') && (this.peek().text === '+' || this.peek().text === '-')) {
      const op = this.advance().text;
      const right = this.parseMul();
      left = { kind: 'binop', op, left, right };
    }
    return left;
  }

  private parseMul(): AstNode {
    let left = this.parseUnary();
    while (
      this.check('OP') &&
      (this.peek().text === '*' || this.peek().text === '/' || this.peek().text === '^')
    ) {
      const op = this.advance().text;
      const right = this.parseUnary();
      left = { kind: 'binop', op, left, right };
    }
    return left;
  }

  private parseUnary(): AstNode {
    if (this.check('OP') && this.peek().text === '-') {
      this.advance();
      const expr = this.parseUnary();
      return { kind: 'unary', op: '-', expr };
    }
    if (this.check('OP') && this.peek().text === '+') {
      this.advance(); // unary + is a no-op
      return this.parseUnary();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): AstNode {
    const t = this.peek();

    if (t.kind === 'NUMBER') {
      this.advance();
      return { kind: 'number', value: parseFloat(t.text) };
    }

    if (t.kind === 'IDENT') {
      this.advance();
      if (this.check('LPAREN')) {
        // Function call
        this.eat('LPAREN');
        const args: AstNode[] = [];
        if (!this.check('RPAREN')) {
          args.push(this.parseComparison());
          while (this.check('COMMA')) {
            this.advance();
            args.push(this.parseComparison());
          }
        }
        this.eat('RPAREN');
        return { kind: 'call', name: t.text.toUpperCase(), args };
      }
      return { kind: 'identifier', name: t.text };
    }

    if (t.kind === 'LPAREN') {
      this.eat('LPAREN');
      const inner = this.parseComparison();
      this.eat('RPAREN');
      // Return the inner node directly — grouping is captured in the tree structure
      return inner;
    }

    throw new SyntaxError(
      `Unexpected token '${t.text || 'EOF'}' at pos ${t.pos}`,
    );
  }
}

/* ── Operator precedence ────────────────────────────────────────────── */

function opPrec(op: string): number {
  if (['<', '>', '<=', '>=', '==', '!='].includes(op)) return 1;
  if (op === '+' || op === '-') return 2;
  if (op === '*' || op === '/') return 3;
  if (op === '^') return 4;
  return 0;
}

function needsParens(child: AstNode, parentOp: string, side: 'left' | 'right'): boolean {
  if (child.kind === 'unary') return false; // never: unary is tightest
  if (child.kind !== 'binop') return false;
  const cp = opPrec(child.op);
  const pp = opPrec(parentOp);
  if (cp < pp) return true;
  // Same precedence: right-side of left-associative - and /
  if (cp === pp && side === 'right' && (parentOp === '-' || parentOp === '/')) return true;
  return false;
}

/* ── Public API ─────────────────────────────────────────────────────── */

/**
 * Parse a formula string into an AST.
 * Pre-normalises `[`/`]` brackets and strips optional `score =` prefix.
 */
export function parseFormula(src: string): AstNode {
  const normalized = src
    .trim()
    .replace(/^\s*score\s*=\s*/i, '')
    .replace(/\[/g, '(')
    .replace(/\]/g, ')');
  return new Parser(normalized).parse();
}

/**
 * Serialise an AST back into a canonical formula string.
 * Adds parentheses only where required by operator precedence.
 */
export function serializeAst(node: AstNode): string {
  switch (node.kind) {
    case 'number': {
      const v = node.value;
      return Number.isInteger(v) ? String(v) : parseFloat(v.toFixed(6)).toString();
    }
    case 'identifier':
      return node.name;
    case 'unary':
      // Wrap binop operand if needed
      if (node.expr.kind === 'binop') return `${node.op}(${serializeAst(node.expr)})`;
      return `${node.op}${serializeAst(node.expr)}`;
    case 'binop': {
      const L = serializeAst(node.left);
      const R = serializeAst(node.right);
      const lp = needsParens(node.left, node.op, 'left');
      const rp = needsParens(node.right, node.op, 'right');
      return `${lp ? `(${L})` : L} ${node.op} ${rp ? `(${R})` : R}`;
    }
    case 'call':
      return `${node.name}(${node.args.map(serializeAst).join(', ')})`;
  }
}

/**
 * Walk every node in the AST depth-first.
 * Return `false` from the visitor to prune that subtree.
 */
export function walkAst(node: AstNode, visitor: (node: AstNode) => boolean | void): void {
  const cont = visitor(node);
  if (cont === false) return;
  switch (node.kind) {
    case 'binop':
      walkAst(node.left, visitor);
      walkAst(node.right, visitor);
      break;
    case 'unary':
      walkAst(node.expr, visitor);
      break;
    case 'call':
      for (const arg of node.args) walkAst(arg, visitor);
      break;
    // number / identifier have no children
  }
}

/* ── Simple structure detection ─────────────────────────────────────── */

/** Describes a single weighted transfer-function term: `w * FN(var, M, N, ...)`. */
export interface SimpleTerm {
  weight: number;
  fn: string;     // 'SIN' | 'INVSIN' | 'RANGE' | 'INVRANGE'
  varName: string;
  M: number;
  N: number;
  high?: number;
  low?: number;
}

/**
 * Describes the "simple visual" formula structure:
 *   (guard₁) * (guard₂) * ... * (term₁ + term₂ + ...) / totalWeight
 */
export interface SimpleStructure {
  guards: BinopNode[];
  terms: SimpleTerm[];
  totalWeight: number;
}

const TF_FNS = new Set(['SIN', 'INVSIN', 'RANGE', 'INVRANGE']);

/**
 * Attempt to detect if the AST represents the canonical visual formula
 * structure.  Returns `null` if the formula does not match.
 *
 * Handles left-associative multiplication chains generated by
 * `visualToRawFormula`:  `guard * w * FN(...) + ...`
 */
export function detectSimpleStructure(node: AstNode): SimpleStructure | null {
  // Strip outer `/ totalWeight`
  let sumNode: AstNode = node;
  let totalWeight = 1;

  if (node.kind === 'binop' && node.op === '/' && node.right.kind === 'number') {
    totalWeight = (node.right as NumberNode).value;
    sumNode = node.left;
  }

  // Collect additive terms (sum split by +)
  const addTermNodes = flattenAdd(sumNode);

  const guards: BinopNode[] = [];
  const terms: SimpleTerm[] = [];

  for (const termNode of addTermNodes) {
    // Flatten the * chain for this additive term
    const factors = flattenMul(termNode);

    // Separate comparison guards from numeric/call factors
    const localGuards: BinopNode[] = [];
    const rest: AstNode[] = [];

    for (const f of factors) {
      if (isComparison(f)) localGuards.push(f as BinopNode);
      else rest.push(f);
    }

    // guards only ever appear in the first term (or all terms may share them)
    guards.push(...localGuards.filter((g) => !guards.some((eg) => eg === g)));

    // rest should be [weight?, call] or [call]
    const term = tryBuildTerm(rest);
    if (!term) return null;
    terms.push(term);
  }

  if (terms.length === 0) return null;
  return { guards, terms, totalWeight };
}

/** Flatten a left-/right-associative addition tree into an ordered list. */
function flattenAdd(node: AstNode): AstNode[] {
  if (node.kind === 'binop' && node.op === '+') {
    return [...flattenAdd(node.left), ...flattenAdd(node.right)];
  }
  return [node];
}

/** Flatten a left-/right-associative multiplication tree into an ordered list. */
function flattenMul(node: AstNode): AstNode[] {
  if (node.kind === 'binop' && node.op === '*') {
    return [...flattenMul(node.left), ...flattenMul(node.right)];
  }
  return [node];
}

function isComparison(node: AstNode): boolean {
  return (
    node.kind === 'binop' &&
    ['<', '>', '<=', '>='].includes(node.op) &&
    node.left.kind === 'identifier' &&
    node.right.kind === 'number'
  );
}

/**
 * Given the non-guard factors of a multiplicative term, extract a SimpleTerm.
 * Expects either [call] or [number, call] or [number, number, ..., call].
 */
function tryBuildTerm(rest: AstNode[]): SimpleTerm | null {
  if (rest.length === 0) return null;

  const callNode = rest.find((n) => n.kind === 'call' && TF_FNS.has((n as CallNode).name));
  if (!callNode) return null;

  const numberNodes = rest.filter((n) => n.kind === 'number');
  // weight = product of all numeric factors; default 1
  const weight = numberNodes.reduce((acc, n) => acc * (n as NumberNode).value, 1);

  const base = tryExtractTfCall(callNode as CallNode);
  if (!base) return null;

  return { ...base, weight };
}

function tryExtractTfCall(node: CallNode): Omit<SimpleTerm, 'weight'> | null {
  const { args } = node;
  if (args.length < 3) return null;
  if (args[0].kind !== 'identifier') return null;
  if (args[1].kind !== 'number') return null;
  if (args[2].kind !== 'number') return null;
  return {
    fn: node.name,
    varName: (args[0] as IdentNode).name,
    M: (args[1] as NumberNode).value,
    N: (args[2] as NumberNode).value,
    high: args[3]?.kind === 'number' ? (args[3] as NumberNode).value : undefined,
    low:  args[4]?.kind === 'number' ? (args[4] as NumberNode).value : undefined,
  };
}
