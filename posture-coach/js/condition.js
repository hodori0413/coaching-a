// YAML 조건식 파서 — 원본은 Python eval()을 썼지만, 여기서는 eval 없이 직접 해석한다.
// 지원: 숫자, 변수, + - * / %, 비교(< <= > >= == !=, 파이썬식 연쇄 비교 a < b < c),
//       and / or / not, 괄호, abs() min() max(), True / False
// 예: "angle > 90 and angle <= 165", "abs(left_hip_y - right_hip_y) > 30"

const FUNCS = {
  abs: Math.abs,
  min: Math.min,
  max: Math.max,
};

function tokenize(src) {
  const re = /\s*(?:(\d+\.\d*|\.\d+|\d+)|([A-Za-z_]\w*)|(<=|>=|==|!=|[<>+\-*/%(),]))/y;
  const out = [];
  let i = 0;
  while (i < src.length) {
    if (/\s/.test(src[i])) { i++; continue; }
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new SyntaxError(`조건식 해석 실패: "${src}" (${i}번째 글자)`);
    if (m[1] !== undefined) out.push({ t: "num", v: parseFloat(m[1]) });
    else if (m[2] !== undefined) out.push({ t: "id", v: m[2] });
    else out.push({ t: "op", v: m[3] });
    i = re.lastIndex;
  }
  out.push({ t: "end" });
  return out;
}

export function compile(src) {
  const toks = tokenize(String(src));
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v) => toks[p].t === "op" && toks[p].v === v;
  const isKw = (v) => toks[p].t === "id" && toks[p].v === v;
  const expect = (v) => {
    if (!isOp(v)) throw new SyntaxError(`"${v}"가 필요합니다: ${src}`);
    p++;
  };

  function orExpr() {
    let left = andExpr();
    while (isKw("or")) {
      p++;
      const l = left, r = andExpr();
      left = (c) => l(c) || r(c);
    }
    return left;
  }
  function andExpr() {
    let left = notExpr();
    while (isKw("and")) {
      p++;
      const l = left, r = notExpr();
      left = (c) => l(c) && r(c);
    }
    return left;
  }
  function notExpr() {
    if (isKw("not")) {
      p++;
      const e = notExpr();
      return (c) => !e(c);
    }
    return comparison();
  }
  const CMP = {
    "<": (a, b) => a < b, "<=": (a, b) => a <= b,
    ">": (a, b) => a > b, ">=": (a, b) => a >= b,
    "==": (a, b) => a === b, "!=": (a, b) => a !== b,
  };
  function comparison() {
    const first = arith();
    const ops = [], rhs = [];
    while (peek().t === "op" && CMP[peek().v]) {
      ops.push(CMP[toks[p++].v]);
      rhs.push(arith());
    }
    if (!ops.length) return first;
    return (c) => {
      let a = first(c);
      for (let k = 0; k < ops.length; k++) {
        const b = rhs[k](c);
        if (!ops[k](a, b)) return false;
        a = b;
      }
      return true;
    };
  }
  function arith() {
    let left = term();
    while (isOp("+") || isOp("-")) {
      const op = toks[p++].v, l = left, r = term();
      left = op === "+" ? (c) => l(c) + r(c) : (c) => l(c) - r(c);
    }
    return left;
  }
  function term() {
    let left = unary();
    while (isOp("*") || isOp("/") || isOp("%")) {
      const op = toks[p++].v, l = left, r = unary();
      left = op === "*" ? (c) => l(c) * r(c)
        : op === "/" ? (c) => l(c) / r(c)
        : (c) => l(c) % r(c);
    }
    return left;
  }
  function unary() {
    if (isOp("-")) { p++; const e = unary(); return (c) => -e(c); }
    if (isOp("+")) { p++; return unary(); }
    return primary();
  }
  function primary() {
    const tk = peek();
    if (tk.t === "num") { p++; const v = tk.v; return () => v; }
    if (isOp("(")) { p++; const e = orExpr(); expect(")"); return e; }
    if (tk.t === "id") {
      p++;
      if (tk.v === "True") return () => true;
      if (tk.v === "False") return () => false;
      if (isOp("(")) {
        const fn = FUNCS[tk.v];
        if (!fn) throw new SyntaxError(`허용되지 않은 함수: ${tk.v}`);
        p++;
        const args = [];
        if (!isOp(")")) {
          args.push(orExpr());
          while (isOp(",")) { p++; args.push(orExpr()); }
        }
        expect(")");
        return (c) => fn(...args.map((a) => a(c)));
      }
      const name = tk.v;
      return (c) => {
        const v = c[name];
        if (v === undefined) throw new ReferenceError(`알 수 없는 변수: ${name}`);
        return v;
      };
    }
    throw new SyntaxError(`조건식 해석 실패: ${src}`);
  }

  const fn = orExpr();
  if (peek().t !== "end") throw new SyntaxError(`조건식 끝에 남은 내용이 있습니다: ${src}`);
  return fn;
}

// 변수가 없으면(해당 관절이 안 보이는 등) false 처리 — 원본의 try/except와 같은 동작
export function compileSafe(src) {
  const fn = compile(src);
  return (ctx) => {
    try { return Boolean(fn(ctx)); } catch { return false; }
  };
}
