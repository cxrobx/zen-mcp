import { transform } from "@babel/standalone";
import { Interpreter } from "eval5";

declare global {
  interface Window {
    __zenExtMcpEvaluate?: (code: string) => unknown;
  }
}

const EVALUATION_TIMEOUT_MS = 10_000;

/**
 * Evaluate an MCP function body without eval() or Function().
 *
 * Firefox applies the page CSP to dynamic compilation in MAIN world, so sites
 * without unsafe-eval reject the old `new Function(code)` implementation. Babel
 * lowers current JavaScript syntax to ES5 and eval5 executes the resulting AST
 * against the real page window without asking Firefox to compile a string.
 */
function evaluate(code: string): unknown {
  const wrapped = `(function () {\n${code}\n}).call(window);`;
  const transpiled = transform(wrapped, {
    presets: [["env", { modules: false, targets: { ie: "11" }, useBuiltIns: false }]],
    sourceType: "script",
    comments: false,
    compact: true,
  }).code;
  if (!transpiled) throw new Error("script transpilation produced no code");

  const interpreter = new Interpreter(window, {
    timeout: EVALUATION_TIMEOUT_MS,
    globalContextInFunction: window,
  });
  // Input type is not a reliable credential signal after a visibility toggle.
  // Capture both sides of evaluation, including scripts that clear/remove a field.
  const values = new Set<string>();
  const collect = (root: Document | ShadowRoot): void => {
    root.querySelectorAll("input, textarea").forEach((el) => {
      const input = el as HTMLInputElement;
      if (input.value) values.add(input.value);
      const initial = input.getAttribute("value");
      if (initial) values.add(initial);
    });
    root.querySelectorAll("*").forEach((el) => { if (el.shadowRoot) collect(el.shadowRoot); });
  };
  collect(document);
  const scrub = (text: string): string => {
    for (const value of [...values].sort((a, b) => b.length - a.length)) {
      text = text.split(value).join("[redacted input]");
    }
    return text;
  };
  try {
    const result = interpreter.evaluate(transpiled);
    collect(document);
    // Scrub strings recursively before crossing the extension boundary.
    let serialized = JSON.stringify(result === undefined ? null : result);
    for (const value of [...values].sort((a, b) => b.length - a.length)) {
      serialized = serialized.split(JSON.stringify(value).slice(1, -1)).join("[redacted input]");
    }
    return JSON.parse(serialized);
  } catch (error) {
    collect(document);
    throw new Error(scrub(error instanceof Error ? error.message : String(error)));
  }
}

window.__zenExtMcpEvaluate = evaluate;
