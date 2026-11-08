#!/usr/bin/env node

for (const required of ["--safe-mode", "--tools", "--no-session-persistence", "--json-schema"]) {
  if (!process.argv.includes(required)) {
    process.stderr.write(`missing required distiller flag: ${required}\n`);
    process.exit(2);
  }
}
if (!process.cwd().split("/").pop()?.startsWith("zen-nav-distill-")) {
  process.stderr.write("distiller did not use an isolated working directory\n");
  process.exit(2);
}

const FRESH = {
  kind: "tool-tip",
  summary: "The fixture form uses a stable email locator.",
  detail: "The input is consistently available through its structural name attribute.",
  example: "css:input[name=email]",
  tools: ["fill"],
  success: true,
  confidence: 0.6,
};

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  // A KNOWN NOTES entry for the fact we already learned means the run should
  // reinforce it by position rather than restate it as a new note.
  const data = JSON.parse(input.split("DATA:\n")[1]);
  if (!data.events.some(e => e.tool === "fill")) {
    process.stdout.write(JSON.stringify({ structured_output: { notes: [] } })); return;
  }
  const known = input.match(/^\s*(\d+)\.\s*\([a-z-]+\)\s[^\n]*fixture form/im);
  const note = known
    ? {
      kind: "tool-tip",
      summary: "The fixture email input keeps its structural locator across visits.",
      detail: "A second visit confirmed the same structural name attribute.",
      tools: ["fill"],
      success: true,
      confidence: 0.6,
      reinforces: Number(known[1]),
    }
    : FRESH;
  process.stdout.write(JSON.stringify({ structured_output: { notes: [note] } }));
});
